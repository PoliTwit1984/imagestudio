-- =============================================================================
-- Migration: 0058_luna_archive_columns.sql
-- Purpose:   Add tier-downgrade lifecycle columns to the Luna tables.
--
--            When a user downgrades from Pro → Free (or any tier → Free),
--            their Luna memories are soft-archived for 90 days before final
--            purge. This migration adds:
--
--            darkroom_luna_memories.archive_until  — timestamptz (nullable)
--                Set to NOW() + 90 days on Pro → Free downgrade.
--                NULL = memory is live (normal lifecycle).
--                Non-null = memory is archived; purged once archive_until
--                elapses via purgeArchivedLunaMemories().
--
--            darkroom_lunas.tier_locked_features   — text[] (nullable)
--                Array of feature slugs that are locked due to tier downgrade.
--                e.g. '{voice,face}' after Devotion → Pro downgrade.
--                NULL = no locks active (Devotion or fully active Pro/Free).
--
--            A new table tier_change_events is also added for idempotent
--            audit logging of Devotion → Pro downgrade events (log-only —
--            no data mutation). The handleLunaTierChange function in
--            src/server/billing.ts writes to this table.
--
-- When:     2026-04-27
-- Author:   backend-2 / darkroom.luna.downgrade-hooks
--
-- Idempotent: all DDL uses ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT
--             EXISTS — safe to re-run. Does NOT drop or alter existing rows.
--
-- Pairs with:
--   migrations/0054_create_lunas.sql     (darkroom_lunas / darkroom_luna_memories)
--   src/server/billing.ts                (handleLunaTierChange, purgeArchivedLunaMemories)
--
-- ROLLBACK:
--   See bottom of file for the full rollback block.
-- =============================================================================

-- Required extensions (gen_random_uuid lives in pgcrypto on older PG, in
-- core on PG13+; using IF NOT EXISTS keeps this safe either way).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Column: darkroom_luna_memories.archive_until
-- -----------------------------------------------------------------------------
-- Set to NOW() + 90 days when a user downgrades from Pro → Free (or any paid
-- tier → Free). NULL = active / normal lifecycle. Non-null = archived and
-- pending purge. The partial index below speeds up the cron-like purge query
-- that deletes rows where archive_until < NOW().
--
-- Note: this column is orthogonal to invalidated_at. invalidated_at marks a
-- memory as logically retracted (superseded, corrected). archive_until marks
-- a memory as scheduled for physical deletion due to tier downgrade. Both can
-- be set simultaneously.
-- -----------------------------------------------------------------------------
ALTER TABLE darkroom_luna_memories
    ADD COLUMN IF NOT EXISTS archive_until timestamptz NULL;

COMMENT ON COLUMN darkroom_luna_memories.archive_until IS
    'Soft-archive deadline set on Pro → Free tier downgrade. NULL = live memory. '
    'Non-null = memory is archived; purgeArchivedLunaMemories() deletes rows '
    'where archive_until < NOW(). Users who re-upgrade before the deadline '
    'regain access; rows can be un-archived by clearing this column.';

-- Index to make the purge query fast: DELETE ... WHERE archive_until < NOW()
-- A partial index (WHERE archive_until IS NOT NULL) keeps it lean — most rows
-- will have NULL and are excluded.
CREATE INDEX IF NOT EXISTS darkroom_luna_memories_archive_until_idx
    ON darkroom_luna_memories (archive_until)
    WHERE archive_until IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Column: darkroom_lunas.tier_locked_features
-- -----------------------------------------------------------------------------
-- Array of feature slugs locked due to a tier downgrade. The application layer
-- checks this array before allowing calls to voice / face generation endpoints.
-- An empty array or NULL means no locks are active.
--
-- Known slugs (as of Phase 18):
--   'voice'  — ElevenLabs voice synthesis (Devotion-only feature)
--   'face'   — LoRA face training + face-locked image generation (Devotion-only)
-- -----------------------------------------------------------------------------
ALTER TABLE darkroom_lunas
    ADD COLUMN IF NOT EXISTS tier_locked_features text[] NULL;

COMMENT ON COLUMN darkroom_lunas.tier_locked_features IS
    'Feature slugs locked due to a tier downgrade. e.g. ARRAY[''voice'',''face''] '
    'after Devotion → Pro downgrade. NULL or empty array = no locks active. '
    'Checked by the voice and face API endpoints before processing. '
    'Cleared when the user re-upgrades to a tier that includes those features.';

-- -----------------------------------------------------------------------------
-- Table: tier_change_events
-- -----------------------------------------------------------------------------
-- Idempotent audit log for tier-change events processed via the Stripe webhook.
-- handleLunaTierChange in src/server/billing.ts inserts one row per event —
-- no data mutation happens here, this is a log-only table.
--
-- Idempotency key: stripe_event_id. The UNIQUE constraint on stripe_event_id
-- (when non-null) ensures a duplicate Stripe event delivery results in a
-- conflict, not a double row. For non-Stripe callers, stripe_event_id may be
-- null and deduplication is the caller's responsibility.
--
-- Note on user_id: bare uuid (no FK) — same convention as 0042/0050/0052.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tier_change_events (
    -- Identity
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- User whose tier changed.
    user_id             uuid        NOT NULL,

    -- Tier before and after. Values mirror BillingTier in src/server/billing.ts.
    -- CHECK list is intentionally open-ended (text, not enum) so future tiers
    -- (e.g. 'devotion') can be recorded without a schema change.
    old_tier            text        NOT NULL,
    new_tier            text        NOT NULL,

    -- Stripe event id that triggered this change. Nullable for non-Stripe
    -- callers. When non-null, the UNIQUE index ensures idempotent delivery.
    stripe_event_id     text        NULL,

    -- Human-readable note logged by the handler (e.g. which features were
    -- locked, or a summary of what side effects were applied).
    notes               text        NULL,

    -- Wall-clock time this event was processed. Separate from any Stripe
    -- event timestamp — this is when our system handled it.
    processed_at        timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: a single Stripe event should produce at most one log row.
-- Partial index (WHERE stripe_event_id IS NOT NULL) so non-Stripe rows
-- with NULL stripe_event_id don't collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS tier_change_events_stripe_event_id_unique_idx
    ON tier_change_events (stripe_event_id)
    WHERE stripe_event_id IS NOT NULL;

-- Per-user lookup: "what tier changes has this user had?" — used by the
-- support tooling and future admin UI.
CREATE INDEX IF NOT EXISTS tier_change_events_user_id_idx
    ON tier_change_events (user_id);

-- -----------------------------------------------------------------------------
-- Comments (self-documenting schema for downstream tooling)
-- -----------------------------------------------------------------------------
COMMENT ON TABLE tier_change_events IS
    'Audit log for billing tier changes. One row per handleLunaTierChange call. '
    'Log-only — no user data is mutated here. Idempotent via UNIQUE on '
    'stripe_event_id (when non-null). See src/server/billing.ts for the '
    'handler that writes to this table.';

COMMENT ON COLUMN tier_change_events.user_id IS
    'User whose subscription tier changed. Bare uuid — no FK to auth.users.';
COMMENT ON COLUMN tier_change_events.old_tier IS
    'Tier before the change (e.g. "devotion", "pro", "free").';
COMMENT ON COLUMN tier_change_events.new_tier IS
    'Tier after the change (e.g. "pro", "free").';
COMMENT ON COLUMN tier_change_events.stripe_event_id IS
    'Stripe event id that triggered this change. NULL for non-Stripe sources. '
    'UNIQUE (partial) — prevents duplicate log rows on Stripe retry delivery.';
COMMENT ON COLUMN tier_change_events.notes IS
    'Human-readable summary of what this handler did (features locked, rows '
    'archived, etc.). Useful for support triage.';
COMMENT ON COLUMN tier_change_events.processed_at IS
    'Wall-clock time this event was processed by our system.';

-- =============================================================================
-- ROLLBACK:
--   -- Drop new table (indexes drop with it)
--   DROP TABLE IF EXISTS tier_change_events CASCADE;
--   -- Drop new index on memories
--   DROP INDEX IF EXISTS darkroom_luna_memories_archive_until_idx;
--   -- Drop added columns
--   ALTER TABLE darkroom_lunas        DROP COLUMN IF EXISTS tier_locked_features;
--   ALTER TABLE darkroom_luna_memories DROP COLUMN IF EXISTS archive_until;
-- =============================================================================
