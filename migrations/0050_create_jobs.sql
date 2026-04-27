-- =============================================================================
-- Migration: 0050_create_jobs.sql
-- Purpose:   Create the `jobs` table — Darkroom's async work-queue tracker.
--
--            Long-running engine work in Darkroom (Topaz upscales, video
--            generation, multi-pass chains, face-swaps, vendor calls to
--            Replicate / fal.ai / xAI / Magnific) needs durable status
--            tracking that survives process restarts and is visible to the
--            UI. The `jobs` table is the canonical record for one of those
--            units of work: what engine is running it, what it's operating
--            on, where it is, and whether it succeeded.
--
--            See PLAN.md Phase 2 (DARKROOM, ASYNC) for the broader
--            async-pipeline spec — `jobs` sits next to `assets`,
--            `wardrobe`, `presets`, and `projects` as the async layer.
--
-- When:     2026-04-27
-- Author:   backend-1 / darkroom.async.jobs-table
--
-- Idempotent: every CREATE uses IF NOT EXISTS, so re-running this migration
--             is safe. Does NOT drop or alter existing rows.
--
-- ROLLBACK:
--   See bottom of file for the full rollback block. Drop indexes first,
--   then the table.
-- =============================================================================

-- Required extensions (gen_random_uuid lives in pgcrypto on older PG, in
-- core on PG13+; using IF NOT EXISTS keeps this safe either way).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Table: jobs
-- -----------------------------------------------------------------------------
-- One row per async unit of work. The worker layer claims a row by flipping
-- status: queued -> running -> (completed | failed | cancelled | expired),
-- updates `progress` + `progress_message` while running, and writes
-- `output_asset_id` on success or `error_class` + `error_detail` on failure.
--
-- Notes:
--   * input_asset_id / output_asset_id are real FKs to assets(id) with
--     ON DELETE SET NULL. Rationale: a job's history is auditable even
--     after its source/result asset is deleted — we keep the job row
--     and just null the pointer. This differs from `project_assets`
--     (which uses CASCADE) because a job is a historical event, not a
--     containment relationship.
--   * status is constrained via a CHECK so workers can't write garbage.
--     Add new states by editing the CHECK in a follow-up migration.
--   * progress is a real (0.0 .. 1.0). The CHECK clamps the range so
--     bad clients can't push 200% bars to the UI.
--   * params is jsonb so engine-specific request shapes don't require
--     schema migrations every time a vendor adds a knob.
--   * external_provider + external_job_id together let us reconcile
--     against vendor APIs (e.g. "what's the status of Replicate
--     prediction abc123?") via a unique-per-pair lookup.
--   * expires_at defaults to now() + 24h — a reaper can mark stale
--     queued/running rows as 'expired' to keep the queue clean.
--   * user_id is nullable to support service-account / system-seeded
--     jobs (e.g. nightly batch upscales) before per-user auth is enforced,
--     mirroring the pattern in `assets` and `projects`.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
    -- Identity
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Lifecycle state. Workers transition this column. The CHECK list is
    -- the canonical set; add new states only via a follow-up migration
    -- that updates the CHECK constraint.
    status              text        NOT NULL DEFAULT 'queued'
                        CHECK (status IN (
                            'queued',
                            'running',
                            'completed',
                            'failed',
                            'cancelled',
                            'expired'
                        )),

    -- Which Darkroom engine owns this job. Free-text on purpose — engines
    -- come and go. Today: 'lens' (capture/intake), 'develop' (Topaz +
    -- skin), 'lock' (face-swap), 'reveal' (video). Tomorrow: who knows.
    engine              text        NULL,

    -- What kind of work this job represents. Free-text — examples:
    -- 'upscale', 'face-swap', 'video-gen', 'chain-run', 'image-gen',
    -- 'skin-enhance'. Distinct from `engine` because one engine can run
    -- multiple job_types.
    job_type            text        NULL,

    -- Asset pointers. SET NULL on delete so the job row survives as an
    -- audit record even after the asset is gone.
    input_asset_id      uuid        NULL
                        REFERENCES assets(id)
                        ON DELETE SET NULL
                        DEFERRABLE INITIALLY DEFERRED,

    output_asset_id     uuid        NULL
                        REFERENCES assets(id)
                        ON DELETE SET NULL
                        DEFERRABLE INITIALLY DEFERRED,

    -- Engine-specific request bag. Lives in jsonb so adding a new vendor
    -- knob doesn't need a schema migration. Examples:
    --   { "model": "topaz-bloom-realism", "scale": 2 }
    --   { "lora": "LUNAV2", "strength": 0.825, "steps": 17 }
    --   { "swap_target": "<asset_id>", "preserve_pose": true }
    params              jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- Progress: 0.0 .. 1.0 inclusive. Real (single-precision) is plenty
    -- for a UI bar; double precision would be wasted bytes.
    progress            real        NOT NULL DEFAULT 0
                        CHECK (progress >= 0 AND progress <= 1),

    -- Human-readable status string, surfaced in the UI under the bar.
    -- e.g. "Uploading source image", "Polling vendor", "Downloading
    -- result", "Saving to assets".
    progress_message    text        NULL,

    -- Failure taxonomy. NULL while running / on success. The CHECK list
    -- mirrors the worker's classification logic — keep it in sync.
    error_class         text        NULL
                        CHECK (error_class IS NULL OR error_class IN (
                            'content_filter',
                            'rate_limit',
                            'auth',
                            'service',
                            'timeout',
                            'invalid_input'
                        )),
    error_detail        text        NULL,

    -- Retry bookkeeping. Workers bump `attempts` each time they pick the
    -- row up. When attempts >= max_attempts and the latest attempt
    -- failed, the row stays in 'failed' instead of being requeued.
    attempts            int         NOT NULL DEFAULT 0
                        CHECK (attempts >= 0),
    max_attempts        int         NOT NULL DEFAULT 3
                        CHECK (max_attempts >= 1),

    -- Vendor reconciliation. external_job_id is whatever the upstream
    -- service hands back (Replicate prediction id, fal request id, etc.).
    -- external_provider is the canonical vendor key — keep this list
    -- short and curated; expansion is cheap (just a CHECK update).
    external_job_id     text        NULL,
    external_provider   text        NULL
                        CHECK (external_provider IS NULL OR external_provider IN (
                            'replicate',
                            'fal',
                            'fal-ai',
                            'xai',
                            'topaz',
                            'enhancor',
                            'magnific'
                        )),

    -- Higher numbers run first. Default 0 = normal. Use small integers
    -- (e.g. 10 = "user is staring at the spinner", -10 = "nightly batch")
    -- to keep the priority space readable in psql.
    priority            int         NOT NULL DEFAULT 0,

    -- Ownership. NULL allowed for service-account / system jobs.
    user_id             uuid        NULL,

    -- Timestamps. created_at fires on insert; updated_at should auto-bump
    -- on UPDATE — the shared touch_updated_at() trigger pattern documented
    -- in 0042 will pick this table up when that follow-up migration ships.
    -- started_at / completed_at are written by workers explicitly when
    -- they transition states. expires_at is a soft TTL; a reaper marks
    -- stale rows as 'expired'.
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    started_at          timestamptz NULL,
    completed_at        timestamptz NULL,
    expires_at          timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Primary work-queue lookup. The worker's claim query is roughly:
--   SELECT id FROM jobs
--    WHERE status = 'queued'
--    ORDER BY priority DESC, created_at ASC
--    LIMIT 1 FOR UPDATE SKIP LOCKED;
-- The (status, priority DESC, created_at) composite serves that scan
-- without a sort step.
CREATE INDEX IF NOT EXISTS jobs_status_priority_created_idx
    ON jobs (status, priority DESC, created_at);

-- Per-user job history. Excludes 'expired' rows because they're noise
-- in the user-facing list (the reaper just cleared them). Composite
-- (user_id, created_at DESC) supports the "my jobs, newest first" view.
CREATE INDEX IF NOT EXISTS jobs_user_created_idx
    ON jobs (user_id, created_at DESC)
    WHERE status NOT IN ('expired');

-- Vendor reconciliation. Given a webhook from Replicate/fal saying
-- "prediction xyz finished", we need to find the local row in O(1).
CREATE INDEX IF NOT EXISTS jobs_external_provider_job_idx
    ON jobs (external_provider, external_job_id);

-- Asset-side joins. Cheap single-column indexes for "what jobs touched
-- this asset?" — useful for audit, debugging, and the asset-detail UI
-- that wants to show "this image was generated by job <id>".
CREATE INDEX IF NOT EXISTS jobs_input_asset_idx
    ON jobs (input_asset_id)
    WHERE input_asset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_output_asset_idx
    ON jobs (output_asset_id)
    WHERE output_asset_id IS NOT NULL;

-- Param search. GIN on jsonb supports both @> containment and ?| key
-- existence — useful for "find all jobs that used model X" or "all
-- jobs with strength > 0.8" debugging queries.
CREATE INDEX IF NOT EXISTS jobs_params_gin_idx
    ON jobs USING GIN (params);

-- -----------------------------------------------------------------------------
-- Comments (self-documenting schema for downstream tooling)
-- -----------------------------------------------------------------------------
COMMENT ON TABLE  jobs                       IS
    'Darkroom async work-queue. One row per long-running engine task '
    '(upscale, face-swap, video gen, chain run, vendor call). Workers '
    'claim rows by flipping status; UI watches progress + progress_message.';

COMMENT ON COLUMN jobs.status                IS
    'Lifecycle state. Constrained set: queued, running, completed, '
    'failed, cancelled, expired. Workers own all transitions.';
COMMENT ON COLUMN jobs.engine                IS
    'Which Darkroom engine owns this job — lens, develop, lock, reveal, '
    'etc. Free-text; engines come and go.';
COMMENT ON COLUMN jobs.job_type              IS
    'What kind of work. Free-text: upscale, face-swap, video-gen, '
    'chain-run, image-gen, skin-enhance, etc.';
COMMENT ON COLUMN jobs.input_asset_id        IS
    'Source asset for the job. ON DELETE SET NULL — job row survives '
    'as audit even if the asset is deleted.';
COMMENT ON COLUMN jobs.output_asset_id       IS
    'Asset produced by the job, populated on success. ON DELETE SET '
    'NULL for the same audit reason.';
COMMENT ON COLUMN jobs.params                IS
    'Engine-specific request bag (jsonb). model, scale, lora, strength, '
    'steps, guidance, swap_target, etc. — vendor-shape varies.';
COMMENT ON COLUMN jobs.progress              IS
    'Completion fraction, 0.0 .. 1.0 (CHECK-clamped). Drives the UI bar.';
COMMENT ON COLUMN jobs.progress_message      IS
    'Human-readable current step. Shown under the progress bar.';
COMMENT ON COLUMN jobs.error_class           IS
    'Failure taxonomy: content_filter, rate_limit, auth, service, '
    'timeout, invalid_input. NULL on success or while running.';
COMMENT ON COLUMN jobs.error_detail          IS
    'Free-text error context (vendor message, stack hint). Pair with '
    'error_class for the structured + readable combo.';
COMMENT ON COLUMN jobs.attempts              IS
    'How many times a worker has picked this row up. Bumped on each claim.';
COMMENT ON COLUMN jobs.max_attempts          IS
    'Retry budget. attempts >= max_attempts + last failed = stays failed.';
COMMENT ON COLUMN jobs.external_job_id       IS
    'Vendor-side job id (Replicate prediction id, fal request id, etc.) '
    'for webhook reconciliation.';
COMMENT ON COLUMN jobs.external_provider     IS
    'Canonical vendor key: replicate, fal, fal-ai, xai, topaz, enhancor, '
    'magnific. Curated CHECK list — expand via follow-up migration.';
COMMENT ON COLUMN jobs.priority              IS
    'Higher runs first. Default 0. Use small ints (e.g. 10 = interactive, '
    '-10 = nightly batch) for readability.';
COMMENT ON COLUMN jobs.user_id               IS
    'Owning user. NULL allowed for service-account / system jobs '
    '(nightly batches, seeders).';
COMMENT ON COLUMN jobs.expires_at            IS
    'Soft TTL. Default now() + 24h. A reaper marks stale queued/running '
    'rows as expired; the user_created index excludes expired rows so '
    'they fall out of the UI quietly.';

-- =============================================================================
-- ROLLBACK:
--   -- Drop indexes first
--   DROP INDEX IF EXISTS jobs_params_gin_idx;
--   DROP INDEX IF EXISTS jobs_output_asset_idx;
--   DROP INDEX IF EXISTS jobs_input_asset_idx;
--   DROP INDEX IF EXISTS jobs_external_provider_job_idx;
--   DROP INDEX IF EXISTS jobs_user_created_idx;
--   DROP INDEX IF EXISTS jobs_status_priority_created_idx;
--   -- Drop the table
--   DROP TABLE IF EXISTS jobs CASCADE;
-- =============================================================================
