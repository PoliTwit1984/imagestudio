-- =============================================================================
-- Migration: 0052_create_subscriptions.sql
-- Purpose:   Create the `subscriptions` table — Darkroom's per-user billing
--            state. One row per user that has ever started a paid (or
--            trialing) subscription. The free tier is implicit: a user with
--            no row in this table is treated as `free` by the tier-config
--            module (`src/server/billing.ts`).
--
--            Pairs with `usage_quota` (0053) to give us monthly metered
--            limits per tier. Stripe is the source of truth for state
--            transitions; this table is the local mirror so PostgREST /
--            UI / quota checks don't have to round-trip Stripe.
--
-- When:     2026-04-27
-- Author:   backend-1 / darkroom.billing.subscriptions-table
--
-- Idempotent: every CREATE uses IF NOT EXISTS, so re-running this migration
--             is safe. Does NOT drop or alter existing rows.
--
-- Note on user_id: stored as a bare uuid (no FK) — auth.users may not be
-- present at apply time in every environment (CI, branch DBs, fresh
-- staging). Same convention as 0042 / 0050.
--
-- ROLLBACK:
--   See bottom of file for the full rollback block.
-- =============================================================================

-- Required extensions (gen_random_uuid lives in pgcrypto on older PG, in
-- core on PG13+; using IF NOT EXISTS keeps this safe either way).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Table: subscriptions
-- -----------------------------------------------------------------------------
-- One row per user that has any subscription state worth tracking. Stripe
-- IDs are nullable so we can record local state (e.g. trialing) before a
-- Stripe customer/subscription has been minted, but in normal operation
-- both will be populated once Stripe.checkout.sessions.create returns.
--
-- The (status, tier) CHECK constraints intentionally mirror Stripe's
-- subscription statuses minus `paused` (we don't ship pause flows in v1)
-- and add Darkroom's three tiers. Expand both lists via follow-up
-- migrations as we add tiers / payment states.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
    -- Identity
    id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Owning user. Bare uuid — see header note about no FK.
    user_id                     uuid        NOT NULL,

    -- Pricing tier. Free is implicit (no row), but we still allow it as a
    -- valid stored value so we can mirror Stripe's downgrade flow without
    -- deleting the row (preserves the Stripe customer linkage).
    tier                        text        NOT NULL DEFAULT 'free'
                                CHECK (tier IN (
                                    'free',
                                    'pro',
                                    'team'
                                )),

    -- Lifecycle status. Mirrors Stripe's `subscription.status` enum, minus
    -- `paused` (we don't ship pause in v1). The CHECK list is the
    -- canonical set; expand via a follow-up migration if Stripe adds
    -- something new we care about.
    status                      text        NOT NULL DEFAULT 'incomplete'
                                CHECK (status IN (
                                    'trialing',
                                    'active',
                                    'past_due',
                                    'cancelled',
                                    'incomplete',
                                    'unpaid'
                                )),

    -- Stripe linkage. Both nullable so we can record local trialing state
    -- before Stripe customer/subscription objects exist. Once populated,
    -- they're treated as the canonical Stripe identifiers for webhooks
    -- and reconciliation.
    stripe_customer_id          text        NULL,
    stripe_subscription_id      text        NULL,

    -- Current billing period bounds. Set from the matching Stripe
    -- subscription fields on every webhook update. Used by the quota
    -- system to know which `usage_quota` rows are "current".
    current_period_start        timestamptz NULL,
    current_period_end          timestamptz NULL,

    -- Whether the subscription will cancel at the end of the current
    -- period. Mirrors Stripe.subscription.cancel_at_period_end. UI uses
    -- this to show "ends on <date>" without inspecting Stripe directly.
    cancel_at_period_end        boolean     NOT NULL DEFAULT false,

    -- Timestamps. created_at fires on insert; updated_at should auto-bump
    -- on UPDATE — the shared touch_updated_at() trigger pattern documented
    -- in 0042 will pick this table up when that follow-up migration ships.
    -- Until then, callers must set updated_at = now() explicitly.
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Per-user lookup. The hot path is "what subscription does user X have?"
-- — used by getUserTier() in src/server/billing.ts on every quota check.
-- We do NOT make this UNIQUE: a user could in theory have a historical
-- 'cancelled' row plus a fresh 'active' row; the billing module filters
-- by status=in.(trialing,active) and limits to 1.
CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx
    ON subscriptions (user_id);

-- Stripe webhook reconciliation. Given a webhook event saying "customer
-- cus_xxx changed", we need to find the local row in O(1).
CREATE INDEX IF NOT EXISTS subscriptions_stripe_customer_idx
    ON subscriptions (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Comments (self-documenting schema for downstream tooling)
-- -----------------------------------------------------------------------------
COMMENT ON TABLE  subscriptions                           IS
    'Darkroom per-user subscription state. Local mirror of Stripe; quota '
    'checks read this table directly via PostgREST. A user with no row '
    'is treated as the implicit `free` tier.';

COMMENT ON COLUMN subscriptions.user_id                   IS
    'Owning user. Bare uuid (no FK) — auth.users not guaranteed at apply time.';
COMMENT ON COLUMN subscriptions.tier                      IS
    'Pricing tier: free | pro | team. CHECK-constrained.';
COMMENT ON COLUMN subscriptions.status                    IS
    'Stripe-mirror status: trialing | active | past_due | cancelled | '
    'incomplete | unpaid. CHECK-constrained.';
COMMENT ON COLUMN subscriptions.stripe_customer_id        IS
    'Stripe customer id (cus_...). Nullable so local trialing state can '
    'be recorded before the Stripe customer is minted.';
COMMENT ON COLUMN subscriptions.stripe_subscription_id    IS
    'Stripe subscription id (sub_...). Nullable for the same reason as '
    'stripe_customer_id.';
COMMENT ON COLUMN subscriptions.current_period_start      IS
    'Start of the current billing period. Mirrors Stripe; used by the '
    'quota system to align usage_quota rows.';
COMMENT ON COLUMN subscriptions.current_period_end        IS
    'End of the current billing period. Mirrors Stripe.';
COMMENT ON COLUMN subscriptions.cancel_at_period_end      IS
    'If true, the subscription will end at current_period_end. Mirrors '
    'Stripe.subscription.cancel_at_period_end.';

-- =============================================================================
-- ROLLBACK:
--   -- Drop indexes first
--   DROP INDEX IF EXISTS subscriptions_stripe_customer_idx;
--   DROP INDEX IF EXISTS subscriptions_user_id_idx;
--   -- Drop the table
--   DROP TABLE IF EXISTS subscriptions CASCADE;
-- =============================================================================
