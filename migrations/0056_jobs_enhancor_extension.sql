-- =============================================================================
-- Migration: 0056_jobs_enhancor_extension.sql
-- Purpose:   Extend the `jobs` table with Enhancor-specific columns.
--
--            Enhancor is an async image-enhancement vendor that delivers
--            results via webhook. Three new concerns distinguish Enhancor
--            jobs from generic vendor jobs already tracked in `jobs`:
--
--            1. vendor — records which vendor "owns" this job row when the
--               Enhancor worker is the claimant. Defaults to 'enhancor' so
--               new rows from the Enhancor worker don't need to pass the
--               column explicitly.
--
--            2. vendor_request_id — the opaque correlation id Enhancor
--               assigns on intake. Needed for webhook deduplication: if
--               Enhancor fires the same callback more than once (at-least-
--               once delivery), we idempotently match the inbound id to an
--               existing job row instead of creating a duplicate.
--
--            3. webhook_received_at — timestamp written the moment our
--               webhook handler processes the Enhancor callback. Useful for
--               latency auditing and debugging missed-webhook support cases.
--
--            4. cost_credits — credits consumed by this job on the Enhancor
--               platform. Populated from the webhook payload. Drives usage
--               reporting + quota enforcement in the billing layer.
--
--            Companion unique partial index on vendor_request_id WHERE
--            vendor='enhancor' enforces deduplication at the DB level so no
--            application-level guard is needed.
--
--            See `migrations/0050_create_jobs.sql` for the base table.
--
-- When:     2026-04-27
-- Author:   backend-2 / darkroom.enhancor.jobs-extension-migration
--
-- Idempotent: all ALTER TABLE … ADD COLUMN IF NOT EXISTS; CREATE INDEX IF
--             NOT EXISTS — safe to re-run at any point.
--
-- ROLLBACK:
--   See bottom of file for the full rollback block.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- New columns on jobs
-- -----------------------------------------------------------------------------

-- Which vendor owns this job row. Defaults to 'enhancor' so the Enhancor
-- worker can insert without specifying it. Other values are allowed (the
-- column is free-text, consistent with external_provider) to stay
-- forward-compatible if a second webhook vendor reuses this pattern.
ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS vendor text DEFAULT 'enhancor';

-- Enhancor's correlation id returned on intake (distinct from
-- external_job_id which is a generic vendor id used for Replicate/fal
-- polling). vendor_request_id is specifically the id Enhancor includes in
-- webhook payloads, enabling O(1) deduplication on receipt.
ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS vendor_request_id text;

-- Wall-clock timestamp when our webhook handler received and processed the
-- Enhancor callback. NULL until the webhook fires. Useful for latency
-- audits: (webhook_received_at - started_at) = vendor processing time.
ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS webhook_received_at timestamptz;

-- Credits billed by Enhancor for this job, populated from the webhook
-- payload. NULL until the webhook fires. Integer (not numeric) because
-- Enhancor's credit unit is whole-number; avoids floating-point imprecision
-- in quota-sum queries.
ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS cost_credits int;

-- -----------------------------------------------------------------------------
-- Deduplication index
-- -----------------------------------------------------------------------------
-- Unique partial index: within the set of Enhancor jobs, vendor_request_id
-- must be unique. Partial (WHERE vendor='enhancor') so the uniqueness
-- constraint is scoped only to Enhancor rows — other vendors can have any
-- vendor_request_id value without collision, and NULL vendor_request_id rows
-- (jobs not yet assigned an Enhancor id) are excluded from the uniqueness
-- check (NULLs are never equal in a unique index).
CREATE UNIQUE INDEX IF NOT EXISTS jobs_enhancor_vendor_request_id_idx
    ON jobs (vendor_request_id)
    WHERE vendor = 'enhancor'
      AND vendor_request_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Comments (self-documenting schema for downstream tooling)
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN jobs.vendor IS
    'Which vendor owns this job row. Defaults to ''enhancor'' for rows '
    'created by the Enhancor worker. Free-text for forward compatibility.';

COMMENT ON COLUMN jobs.vendor_request_id IS
    'Vendor-assigned correlation id for webhook deduplication. For Enhancor '
    'jobs this is the id returned on intake and echoed in every callback. '
    'Enforced unique per vendor via jobs_enhancor_vendor_request_id_idx.';

COMMENT ON COLUMN jobs.webhook_received_at IS
    'Wall-clock timestamp when our webhook handler processed the Enhancor '
    'callback. NULL until the webhook fires. Pair with started_at for '
    'vendor processing-time audits.';

COMMENT ON COLUMN jobs.cost_credits IS
    'Credits consumed on the Enhancor platform, from the webhook payload. '
    'NULL until populated. Integer (whole-number credit unit). Used by the '
    'billing layer for usage reporting and quota enforcement.';

-- =============================================================================
-- ROLLBACK:
--   -- Drop the deduplication index first
--   DROP INDEX IF EXISTS jobs_enhancor_vendor_request_id_idx;
--   -- Remove the new columns
--   ALTER TABLE jobs DROP COLUMN IF EXISTS cost_credits;
--   ALTER TABLE jobs DROP COLUMN IF EXISTS webhook_received_at;
--   ALTER TABLE jobs DROP COLUMN IF EXISTS vendor_request_id;
--   ALTER TABLE jobs DROP COLUMN IF EXISTS vendor;
-- =============================================================================
