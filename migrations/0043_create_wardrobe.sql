-- =============================================================================
-- Migration: 0043_create_wardrobe.sql
-- Purpose:   Create the `wardrobe` table — Darkroom's curated garment library.
--            Each row is a curated garment overlay / outfit reference (typically
--            a transparent-PNG cutout) that can be used as a ref by Brush,
--            Lock+List, Wear Garment, Place Overlay, and chain stages.
--
--            Rows reference a row in `assets` (migration 0042) via `asset_id` —
--            the actual image bytes / source URL live there. This table is the
--            curated catalog layer on top of that universe-of-artifacts.
--
--            See PLAN.md Phase 1.4 (Wardrobe — persistent garment library) and
--            Phase 12 (Outfit Generator / Wardrobe Forge) for the broader spec.
--
-- When:     2026-04-27
-- Author:   backend-1 / darkroom.catalog.wardrobe-table
--
-- Idempotent: every CREATE uses IF NOT EXISTS, so re-running this migration
--             is safe. Does NOT drop or alter existing rows.
--
-- ROLLBACK:
--   See bottom of file for the full rollback block.
-- =============================================================================

-- Required extensions (gen_random_uuid lives in pgcrypto on older PG, in
-- core on PG13+; using IF NOT EXISTS keeps this safe either way).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Table: wardrobe
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wardrobe (
    -- Identity
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The actual image asset. Points at a row in `assets` (typically an
    -- asset_type='curated' or 'overlay' row holding a transparent-PNG
    -- cutout). ON DELETE CASCADE: if the underlying asset is hard-deleted,
    -- the wardrobe entry is meaningless and should go with it.
    --
    -- NOTE: `assets` ships in 0042 — assumed present. If applying this
    -- migration in an environment where 0042 has not yet run, comment the
    -- REFERENCES clause below and re-add it after 0042 lands.
    asset_id        uuid        NOT NULL
                    REFERENCES assets(id)
                    ON DELETE CASCADE,

    -- Coarse garment region. NOT NULL because catalog browsing always
    -- groups by category. Common values: top, bottom, dress, lingerie,
    -- outerwear, swimwear, accessory, footwear, hosiery. Stored as text
    -- (not enum) so we can add categories without a migration.
    category        text        NOT NULL,

    -- Optional finer-grained type within the category. Examples:
    --   category='top',       subcategory='crop tank'
    --   category='lingerie',  subcategory='bralette'
    --   category='bottom',    subcategory='thong'
    --   category='hosiery',   subcategory='thigh-high stocking'
    subcategory     text        NULL,

    -- Display label shown in the wardrobe grid. Free-form, e.g.
    -- "silk crop tank — black" or "lace thigh-highs — ivory".
    name            text        NULL,

    -- Tag array — fast filtering, GIN-indexed below. e.g.
    --   {'silk','black','damp','sleeveless','low-cut'}
    tags            text[]      NOT NULL DEFAULT '{}',

    -- Flexible per-garment bag. Examples of fields that may live here:
    --   { "color": "black",
    --     "fit": "cropped",
    --     "opacity": 0.6,
    --     "transparency_required": true,
    --     "material": "silk",
    --     "raw_asset_id": "...",          -- optional white-bg twin
    --     "cutout_asset_id": "...",       -- optional alpha-cut twin
    --     "angles": { "front": "...", "back": "...", "side": "..." },
    --     "auto_classified": true,
    --     "vision_confidence": 0.92 }
    attributes      jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- Curated highlights. Featured rows surface in the default wardrobe
    -- grid + landing-page galleries.
    featured        boolean     NOT NULL DEFAULT false,

    -- Lifecycle flag. Archived rows hide from the default wardrobe grid
    -- but remain available for replays of older edit chains.
    archived        boolean     NOT NULL DEFAULT false,

    -- Timestamps. `updated_at` should auto-bump on UPDATE — see TODO below.
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Catalog browsing: group by category, drill into subcategory.
CREATE INDEX IF NOT EXISTS wardrobe_category_subcategory_idx
    ON wardrobe (category, subcategory);

-- Join-back to assets when materializing the wardrobe grid.
CREATE INDEX IF NOT EXISTS wardrobe_asset_id_idx
    ON wardrobe (asset_id);

-- Tag search (text[] GIN) — wardrobe filter chips ("show me all silk").
CREATE INDEX IF NOT EXISTS wardrobe_tags_gin_idx
    ON wardrobe USING GIN (tags);

-- Attribute querying (e.g. attributes @> '{"color":"black"}' or
-- attributes->>'material' = 'silk').
CREATE INDEX IF NOT EXISTS wardrobe_attributes_gin_idx
    ON wardrobe USING GIN (attributes jsonb_path_ops);

-- Featured-but-live partial index. Cheap, hot, used on every wardrobe
-- landing render.
CREATE INDEX IF NOT EXISTS wardrobe_featured_live_idx
    ON wardrobe (created_at DESC)
    WHERE featured = true AND archived = false;

-- -----------------------------------------------------------------------------
-- Comments (self-documenting schema for downstream tooling)
-- -----------------------------------------------------------------------------
COMMENT ON TABLE  wardrobe              IS
    'Darkroom curated garment library. Each row is a curated garment '
    'overlay / outfit reference (typically a transparent-PNG cutout) '
    'available to use as a ref by Brush, Lock+List, Wear Garment, etc. '
    'Rows reference an entry in the assets table via asset_id.';

COMMENT ON COLUMN wardrobe.asset_id     IS
    'FK to assets.id — the actual image (transparent-PNG cutout or raw '
    'reference). ON DELETE CASCADE.';
COMMENT ON COLUMN wardrobe.category     IS
    'Coarse garment region: top | bottom | dress | lingerie | outerwear '
    '| swimwear | accessory | footwear | hosiery. Stored as text so new '
    'categories do not require a migration.';
COMMENT ON COLUMN wardrobe.subcategory  IS
    'Finer-grained type within category. e.g. crop tank, bralette, thong, '
    'thigh-high stocking.';
COMMENT ON COLUMN wardrobe.name         IS
    'Display label shown in the wardrobe grid. Free-form.';
COMMENT ON COLUMN wardrobe.tags         IS
    'text[] — fast filter chips (silk, black, damp, sleeveless, etc.). '
    'GIN indexed.';
COMMENT ON COLUMN wardrobe.attributes   IS
    'Per-garment flexible bag. color, fit, opacity, transparency_required, '
    'material, raw_asset_id, cutout_asset_id, angles, auto_classified, '
    'vision_confidence. GIN indexed (jsonb_path_ops).';
COMMENT ON COLUMN wardrobe.featured     IS
    'Curated highlight flag. Featured rows surface on the wardrobe '
    'landing + default grid.';
COMMENT ON COLUMN wardrobe.archived     IS
    'Hide from the default wardrobe grid; remain available for replays '
    'of older edit chains.';

-- -----------------------------------------------------------------------------
-- TODO (follow-up task): updated_at auto-bump trigger
--
-- Same pattern as `assets` — once a shared touch_updated_at() function
-- ships in a dedicated migration, attach it here:
--
--   CREATE TRIGGER wardrobe_touch_updated_at
--       BEFORE UPDATE ON wardrobe
--       FOR EACH ROW
--       EXECUTE FUNCTION touch_updated_at();
--
-- Until then, callers should set updated_at = now() explicitly on UPDATE.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- ROLLBACK:
--   DROP INDEX IF EXISTS wardrobe_featured_live_idx;
--   DROP INDEX IF EXISTS wardrobe_attributes_gin_idx;
--   DROP INDEX IF EXISTS wardrobe_tags_gin_idx;
--   DROP INDEX IF EXISTS wardrobe_asset_id_idx;
--   DROP INDEX IF EXISTS wardrobe_category_subcategory_idx;
--   DROP TABLE IF EXISTS wardrobe CASCADE;
-- =============================================================================
