-- =============================================================================
-- Migration: 0048_create_detail_assets.sql
-- Purpose:   Create the `detail_brush_assets` table — persisted catalog
--            of Darkroom's "detail brushes" (surgical NSFW-permissive
--            region edits). Today the catalog lives in code as the
--            DETAIL_BRUSH_REGISTRY constant in
--            src/server/routes/safe-edit.ts; this table mirrors that
--            shape so brushes can be added, edited, hidden, or
--            reordered at runtime without a code change.
--
--            The /api/detail-brushes route falls back to the in-code
--            registry if this table is empty/missing — see
--            getDetailBrushAssets() in safe-edit.ts.
--
-- When:     2026-04-27
-- Author:   backend-1 / darkroom.details.assets-table
--
-- Idempotent: every CREATE uses IF NOT EXISTS, so re-running this
--             migration is safe. Does NOT drop or alter existing rows.
--
-- ROLLBACK:
--   See bottom of file for the full rollback block.
-- =============================================================================

-- Required extensions (gen_random_uuid lives in pgcrypto on older PG, in
-- core on PG13+; using IF NOT EXISTS keeps this safe either way).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Table: detail_brush_assets
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS detail_brush_assets (
    -- Identity
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Stable, code-friendly slug. Matches the key used in
    -- DETAIL_BRUSH_REGISTRY (e.g. 'cameltoe-subtle', 'hard-nipples-bold').
    -- Frontend uses this as `brush_id` in /api/detail-brush calls.
    slug                text        NOT NULL UNIQUE,

    -- Display name shown in the brush picker UI.
    label               text        NOT NULL,

    -- Top-level grouping. Today: 'Anatomy' | 'Fabric' | 'Lighting' |
    -- 'Hair' | 'Mood' | 'Removal'. Stored as text (not enum) so new
    -- categories can be added without a schema change.
    category            text        NULL,

    -- The hidden edit prompt. NEVER returned to the client by
    -- /api/detail-brushes — only used server-side when a brush is
    -- actually applied.
    prompt              text        NOT NULL,

    -- Optional negative-prompt steering for engines that support it.
    negative_prompt     text        NULL,

    -- Preferred engine for this brush (e.g. 'brush' = Flux Fill Pro,
    -- 'strip' = P-Edit). Lets us route brushes to the engine that
    -- handles them best without hard-coding it in the route handler.
    engine_default      text        NULL,

    -- Flexible per-engine overrides. Examples of fields that may live
    -- here:
    --   { "brush_size_px": 30, "intensity": "medium",
    --     "intensity_label": "Medium", "dilate_pct": 0.012,
    --     "guidance_scale": 4.0, "steps": 17 }
    -- Captures everything DETAIL_BRUSH_REGISTRY currently encodes
    -- beyond the columns we promoted to first-class.
    params              jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- Optional thumbnail / preview image. FK to the unified `assets`
    -- table from migration 0042. ON DELETE SET NULL so wiping an
    -- asset doesn't break the brush row.
    preview_asset_id    uuid        NULL
                        REFERENCES assets(id)
                        ON DELETE SET NULL
                        DEFERRABLE INITIALLY DEFERRED,

    -- Content / visibility flags
    is_nsfw             boolean     NOT NULL DEFAULT false,
    is_hidden           boolean     NOT NULL DEFAULT false,
    featured            boolean     NOT NULL DEFAULT false,

    -- Manual ordering inside a category.
    position            int         NOT NULL DEFAULT 0,

    -- Timestamps. updated_at should auto-bump on UPDATE — see TODO
    -- in migration 0042 for the shared trigger plan. Until that ships,
    -- callers should set updated_at = now() on UPDATE.
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Slug lookup (already UNIQUE → implicit btree, but make the intent explicit).
-- Wrapped in IF NOT EXISTS so re-running the migration is safe even if PG
-- created the implicit index under a different name.
CREATE UNIQUE INDEX IF NOT EXISTS detail_brush_assets_slug_idx
    ON detail_brush_assets (slug);

-- Ordered browsing within a category: "give me Anatomy brushes in display
-- order". Covers the most common UI query.
CREATE INDEX IF NOT EXISTS detail_brush_assets_category_position_idx
    ON detail_brush_assets (category, position);

-- Default-list query path: visible brushes only, ordered for the UI.
-- Partial index keeps it small + the query plan obvious.
CREATE INDEX IF NOT EXISTS detail_brush_assets_visible_idx
    ON detail_brush_assets (category, position)
    WHERE NOT is_hidden;

-- Featured-brush filter (small set, partial index keeps it cheap).
CREATE INDEX IF NOT EXISTS detail_brush_assets_featured_idx
    ON detail_brush_assets (position)
    WHERE featured AND NOT is_hidden;

-- -----------------------------------------------------------------------------
-- Comments (self-documenting schema for downstream tooling)
-- -----------------------------------------------------------------------------
COMMENT ON TABLE  detail_brush_assets                    IS
    'DB-backed catalog of Darkroom detail brushes. Mirrors the in-code '
    'DETAIL_BRUSH_REGISTRY shape so brushes can be added/edited at runtime. '
    'getDetailBrushAssets() in safe-edit.ts reads this table and falls back '
    'to the in-code registry if the table is empty/missing.';

COMMENT ON COLUMN detail_brush_assets.slug               IS
    'Stable code-friendly id. Matches DETAIL_BRUSH_REGISTRY key. Used by the '
    'frontend as `brush_id` in /api/detail-brush calls.';
COMMENT ON COLUMN detail_brush_assets.prompt             IS
    'Hidden edit prompt. NEVER returned to clients by /api/detail-brushes — '
    'only used server-side when the brush is actually applied.';
COMMENT ON COLUMN detail_brush_assets.engine_default     IS
    'Preferred engine name (e.g. brush = Flux Fill Pro, strip = P-Edit). '
    'Server may override based on content profile.';
COMMENT ON COLUMN detail_brush_assets.params             IS
    'Engine-specific overrides — brush_size_px, intensity, intensity_label, '
    'dilate_pct, guidance_scale, steps, etc. Anything DETAIL_BRUSH_REGISTRY '
    'currently encodes beyond the promoted columns lives here.';
COMMENT ON COLUMN detail_brush_assets.preview_asset_id   IS
    'FK to assets(id). Optional thumbnail. ON DELETE SET NULL so wiping an '
    'asset does not break the brush row.';
COMMENT ON COLUMN detail_brush_assets.is_hidden          IS
    'True = exclude from the normal /api/detail-brushes catalog. Use for IP-'
    'leak-guarded contexts or for staging brush-edit work without exposing '
    'half-built prompts.';
COMMENT ON COLUMN detail_brush_assets.position           IS
    'Manual ordering within a category. Lower = earlier. Default 0.';

-- =============================================================================
-- ROLLBACK:
--   DROP INDEX IF EXISTS detail_brush_assets_featured_idx;
--   DROP INDEX IF EXISTS detail_brush_assets_visible_idx;
--   DROP INDEX IF EXISTS detail_brush_assets_category_position_idx;
--   DROP INDEX IF EXISTS detail_brush_assets_slug_idx;
--   DROP TABLE IF EXISTS detail_brush_assets CASCADE;
-- =============================================================================
