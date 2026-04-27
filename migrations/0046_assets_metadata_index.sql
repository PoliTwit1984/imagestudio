-- =============================================================================
-- Migration: 0046_assets_metadata_index.sql
-- Purpose:   Add expression indexes and helper views over the `assets` table
--            for hot-path UI queries that reach into the `metadata` jsonb bag.
--
--            The base table + a generic GIN(metadata jsonb_path_ops) index
--            were created in 0042. That GIN is great for containment-style
--            predicates (e.g. `metadata @> '{"engine":"Lens"}'`) but is NOT
--            ideal for equality on a single scalar key like
--            `metadata->>'engine' = 'Lens'`. This migration adds targeted
--            B-tree expression indexes for those scalar lookups, plus two
--            convenience views the catalog UI will lean on.
--
--            This migration is INDEX/VIEW-ONLY. It does NOT add, drop, or
--            modify any column on `assets` — those live in 0042.
--
-- When:     2026-04-27
-- Author:   backend-2 / darkroom.catalog.assets-metadata
--
-- Idempotent:
--   - All indexes use CREATE INDEX IF NOT EXISTS.
--   - All views use CREATE OR REPLACE VIEW.
--   Re-running this migration is safe.
--
-- ROLLBACK:
--   See bottom of file for the full rollback block. Drop views first
--   (they may reference the indexed expressions in plans), then indexes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Expression indexes on metadata jsonb scalar fields
-- -----------------------------------------------------------------------------

-- Equality / IN filtering by engine name. The base table has an `engine`
-- column with its own partial index (assets_engine_created_idx, 0042), but
-- many call sites read engine off `metadata->>'engine'` for legacy /
-- vendor-bag rows where the top-level column was never populated. This
-- expression index covers those reads.
CREATE INDEX IF NOT EXISTS idx_assets_metadata_engine
    ON assets ((metadata->>'engine'));

-- "Find every generation that used seed N" — a common analytics + repro
-- query. Stored as text because `metadata->>'seed'` returns text; callers
-- comparing against integers should cast their RHS to text or wrap the
-- predicate to match the index expression.
CREATE INDEX IF NOT EXISTS idx_assets_metadata_seed
    ON assets (((metadata->>'seed')));

-- Numeric analytics over guidance_scale (e.g. histograms, "show me all
-- assets where guidance_scale > 4"). Cast to numeric so range predicates
-- can use the index.
CREATE INDEX IF NOT EXISTS idx_assets_metadata_guidance_scale
    ON assets ((((metadata->>'guidance_scale')::numeric)));

-- -----------------------------------------------------------------------------
-- View: live_assets
--   The "live" projection callers should use by default. Hides soft-deleted
--   rows (deleted_at IS NOT NULL) AND archived rows (archived = true).
--   Both fields exist on the base table per 0042.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW live_assets AS
    SELECT
        id,
        asset_type,
        parent_id,
        source_url,
        storage_path,
        mime_type,
        width,
        height,
        engine,
        edit_action,
        prompt,
        tags,
        metadata,
        user_id,
        starred,
        archived,
        created_at,
        updated_at,
        deleted_at
    FROM assets
    WHERE deleted_at IS NULL
      AND archived = false;

COMMENT ON VIEW live_assets IS
    'Live projection of assets: deleted_at IS NULL AND archived = false. '
    'UI list endpoints should read from this view by default. The base '
    'table is reserved for admin / restore flows that need to see archived '
    'or soft-deleted rows.';

-- -----------------------------------------------------------------------------
-- View: assets_with_chain_depth
--   For each asset, compute how many ancestors it has via the parent_id
--   self-reference (i.e. the depth of the edit chain leading to this row).
--   Useful for analytics ("average chain depth per engine") and for the UI
--   to render breadcrumbs / chain badges without N+1 walks.
--
--   Implementation: recursive CTE. Roots (parent_id IS NULL) have depth 0;
--   every child = parent.depth + 1.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW assets_with_chain_depth AS
    WITH RECURSIVE chain AS (
        -- Anchor: root-of-chain rows
        SELECT
            a.id,
            a.parent_id,
            0 AS chain_depth
        FROM assets a
        WHERE a.parent_id IS NULL

        UNION ALL

        -- Recursive step: each child inherits parent.depth + 1
        SELECT
            a.id,
            a.parent_id,
            c.chain_depth + 1 AS chain_depth
        FROM assets a
        JOIN chain c ON a.parent_id = c.id
    )
    SELECT
        a.id,
        a.asset_type,
        a.parent_id,
        a.engine,
        a.edit_action,
        a.user_id,
        a.created_at,
        COALESCE(c.chain_depth, 0) AS chain_depth
    FROM assets a
    LEFT JOIN chain c ON c.id = a.id;

COMMENT ON VIEW assets_with_chain_depth IS
    'Each asset annotated with its edit-chain depth (0 = root, N = N '
    'ancestors via parent_id). Computed via recursive CTE. Useful for '
    'breadcrumb rendering and chain-depth analytics.';

-- =============================================================================
-- ROLLBACK:
--   -- Drop views first (they don't depend on the new indexes, but order
--   -- here mirrors creation order for clarity).
--   DROP VIEW IF EXISTS assets_with_chain_depth;
--   DROP VIEW IF EXISTS live_assets;
--
--   -- Then drop the expression indexes.
--   DROP INDEX IF EXISTS idx_assets_metadata_guidance_scale;
--   DROP INDEX IF EXISTS idx_assets_metadata_seed;
--   DROP INDEX IF EXISTS idx_assets_metadata_engine;
-- =============================================================================
