-- =============================================================================
-- Migration: 0053_create_usage_quota.sql
-- Purpose:   Create the `usage_quota` table — Darkroom's per-user, per-metric
--            usage counter, scoped to a billing period. One row per
--            (user_id, metric, period_start) tuple; the count column is
--            incremented on every metered event (generation, edit, upscale,
--            job, chain run, LUT extract).
--
--            Pairs with `subscriptions` (0052) and the tier-config module
--            (`src/server/billing.ts`). The billing module's `incrementUsage`
--            does an upsert on (user_id, metric, period_start); `checkQuota`
--            reads the current row and compares to the tier's per-metric
--            cap.
--
-- When:     2026-04-27
-- Author:   backend-1 / darkroom.billing.usage-quota-table
--
-- Idempotent: every CREATE uses IF NOT EXISTS, so re-running this migration
--             is safe. Does NOT drop or alter existing rows.
--
-- Note on user_id: stored as a bare uuid (no FK) — auth.users may not be
-- present at apply time in every environment (CI, branch DBs, fresh
-- staging). Same convention as 0042 / 0050 / 0052.
--
-- ROLLBACK:
--   See bottom of file for the full rollback block.
-- =============================================================================

-- Required extensions (gen_random_uuid lives in pgcrypto on older PG, in
-- core on PG13+; using IF NOT EXISTS keeps this safe either way).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Table: usage_quota
-- -----------------------------------------------------------------------------
-- One row per (user, metric, period). The billing module aligns periods to
-- calendar months in UTC: period_start = first day of the current UTC month
-- at 00:00:00, period_end = first day of the next UTC month. This keeps the
-- shape stable regardless of the user's local timezone or a Stripe
-- subscription's anchor day.
--
-- The metric CHECK list mirrors the union type `BillingMetric` in
-- src/server/billing.ts. Add a new metric in three places (CHECK here,
-- TierLimits interface in billing.ts, and TIER configs). Removing a
-- metric needs a follow-up migration.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_quota (
    -- Identity
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Owning user. Bare uuid — see header note about no FK.
    user_id         uuid        NOT NULL,

    -- Which metric this row counts. Free-text would be tempting but the
    -- CHECK keeps the surface area small and forces the billing module to
    -- evolve in lockstep with the schema. Add new metrics via follow-up
    -- migrations that update the CHECK list.
    metric          text        NOT NULL
                    CHECK (metric IN (
                        'generations',
                        'edits',
                        'upscales',
                        'jobs',
                        'chains_runs',
                        'lut_extracts'
                    )),

    -- Billing-period bounds. Aligned to UTC calendar months by the billing
    -- module. Kept on the row (vs computed) so a future shift to per-user
    -- subscription anchors doesn't require a schema change — just write
    -- different period_start/end values.
    period_start    timestamptz NOT NULL,
    period_end      timestamptz NOT NULL,

    -- Running count for this (user, metric, period). incrementUsage()
    -- upserts with merge-duplicates so concurrent calls last-write-wins;
    -- a Postgres trigger / RPC for atomic +delta is a v2 follow-up (see
    -- comment in src/server/billing.ts).
    count           int         NOT NULL DEFAULT 0
                    CHECK (count >= 0),

    -- Timestamps. created_at fires on insert; updated_at should auto-bump
    -- on UPDATE — the shared touch_updated_at() trigger pattern documented
    -- in 0042 will pick this table up when that follow-up migration ships.
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- One row per (user, metric, period) — required for the upsert in
    -- incrementUsage() to use ON CONFLICT cleanly.
    CONSTRAINT usage_quota_user_metric_period_unique
        UNIQUE (user_id, metric, period_start)
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Primary access pattern: "for user X, what's the current count of metric
-- M in their current period?" — used by checkQuota() / getCurrentUsage()
-- in src/server/billing.ts on every metered request. The composite
-- (user_id, metric, period_start DESC) supports both the exact-match
-- lookup (current period) and the "most recent period" fallback.
CREATE INDEX IF NOT EXISTS usage_quota_user_metric_period_idx
    ON usage_quota (user_id, metric, period_start DESC);

-- -----------------------------------------------------------------------------
-- Comments (self-documenting schema for downstream tooling)
-- -----------------------------------------------------------------------------
COMMENT ON TABLE  usage_quota                IS
    'Darkroom per-user metered usage counters, scoped to a billing period. '
    'One row per (user_id, metric, period_start). Read by checkQuota(); '
    'written by incrementUsage() (src/server/billing.ts).';

COMMENT ON COLUMN usage_quota.user_id        IS
    'Owning user. Bare uuid (no FK) — auth.users not guaranteed at apply time.';
COMMENT ON COLUMN usage_quota.metric         IS
    'Counted metric: generations | edits | upscales | jobs | chains_runs | '
    'lut_extracts. CHECK-constrained; mirrors BillingMetric union in '
    'src/server/billing.ts.';
COMMENT ON COLUMN usage_quota.period_start   IS
    'Inclusive start of the billing period this row counts. UTC '
    'calendar-month-aligned by the billing module.';
COMMENT ON COLUMN usage_quota.period_end     IS
    'Exclusive end of the billing period. period_end = next month''s '
    'period_start, by convention.';
COMMENT ON COLUMN usage_quota.count          IS
    'Running count of metered events for this (user, metric, period). '
    'CHECK count >= 0 to prevent negative drift.';

-- =============================================================================
-- ROLLBACK:
--   -- Drop indexes first
--   DROP INDEX IF EXISTS usage_quota_user_metric_period_idx;
--   -- Drop the unique constraint with the table
--   DROP TABLE IF EXISTS usage_quota CASCADE;
-- =============================================================================
