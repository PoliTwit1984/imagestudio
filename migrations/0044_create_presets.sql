-- =============================================================================
-- Migration: 0044_create_presets.sql
-- Purpose:   Create the `presets` table — Darkroom's reusable bundles for
--            engine configurations, LUT (Hald-CLUT) color grades, and chain
--            definitions. Both house ("system") presets and user-created
--            presets share this table; `is_system` and `created_by`
--            distinguish ownership.
--
--            Three preset_types are supported:
--              - engine_config : an engine + prompt template + tuned params
--                                (Phase 2 — Preset System Architecture)
--              - lut           : a Hald-CLUT PNG reference (Phase 17 — LUT
--                                Extraction); pure pixel math, deterministic,
--                                NSFW-safe re-application of an AI-derived
--                                color grade
--              - chain         : a saved multi-stage chain definition
--                                (Phase 11 — Chains); sequence of steps stored
--                                as jsonb
--
--            See PLAN.md Phase 1 (CATALOG), Phase 2 (PRESETS),
--            Phase 11 (CHAINS), and Phase 17 (LUT EXTRACTION) for context.
--
-- When:     2026-04-27
-- Author:   backend-2 / darkroom.catalog.presets-table
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
-- Table: presets
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS presets (
    -- Identity
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Human-readable display name. e.g. "Darkroom Skin", "Kodak Portra 400",
    -- "Cinematic Teal & Orange". NOT slug — see `slug` below.
    name                text        NOT NULL,

    -- URL-safe stable identifier. e.g. "darkroom-skin", "portra-400",
    -- "teal-orange-cinematic". UNIQUE — used by the API at
    -- POST /api/preset/:slug for engine_config presets.
    slug                text        NOT NULL,

    -- What kind of preset is this?
    --   engine_config : an engine + prompt template + tuned params bundle.
    --                   `engine` and `config` are the load-bearing fields.
    --   lut           : a Hald-CLUT PNG reference (Phase 17). The actual
    --                   PNG lives in `assets` and is referenced via
    --                   `lut_asset_id`. `config` may carry intensity defaults.
    --   chain         : a saved multi-stage chain (Phase 11). The full
    --                   step graph lives in `chain_definition` jsonb.
    preset_type         text        NOT NULL
                        CHECK (preset_type IN (
                            'engine_config',
                            'lut',
                            'chain'
                        )),

    -- Optional human-readable explanation. Shown in UI tooltips and
    -- preset cards.
    description         text        NULL,

    -- For preset_type='engine_config': the house engine name this preset
    -- targets (e.g. 'lens', 'glance', 'strip', 'brush', 'eye', 'frame',
    -- 'develop', 'skin', 'crisp', 'reveal', 'lock', 'cutout', 'watch').
    -- NULL for non-engine_config preset types. Stored as text (not enum)
    -- so we can add engines without a migration.
    engine              text        NULL,

    -- Engine-specific parameter bag. Examples:
    --   { "prompt_template": "...", "guidance_scale": 4.0,
    --     "num_inference_steps": 17, "seed": null,
    --     "intensity_map": { "subtle": 0.4, "default": 0.6, "bold": 0.85 },
    --     "exposed_params": ["intensity"], "hidden": true }
    --
    -- For LUT presets, `config` may carry default intensity / blend mode:
    --   { "default_intensity": 0.85, "blend_mode": "normal" }
    --
    -- The preset registry / API layer interprets fields per preset_type.
    config              jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- For preset_type='lut': FK to the assets row holding the Hald-CLUT PNG
    -- (typically a 512×512 PNG encoding a 33×33×33 cube). NULL for
    -- non-LUT preset types. ON DELETE SET NULL so deleting the underlying
    -- asset does not orphan the preset row entirely — caller can re-bind.
    lut_asset_id        uuid        NULL
                        REFERENCES assets(id)
                        ON DELETE SET NULL
                        DEFERRABLE INITIALLY DEFERRED,

    -- For preset_type='chain': the full step graph. Shape (illustrative):
    --   {
    --     "steps": [
    --       { "id": "s1", "engine": "lens", "params": { ... } },
    --       { "id": "s2", "engine": "skin", "params": { ... },
    --         "input_from": "s1" }
    --     ],
    --     "version": 1
    --   }
    -- NULL for non-chain preset types.
    chain_definition    jsonb       NULL,

    -- Tags array — fast filtering, GIN-indexed below. e.g.
    -- ['film_emulation', 'warm', 'cinematic', 'low-light'].
    tags                text[]      NOT NULL DEFAULT '{}',

    -- Top-level browse bucket. e.g. 'film_emulation', 'cinematic',
    -- 'beauty', 'editorial', 'noir', 'glow'. NULL allowed for presets
    -- that don't fit a single bucket.
    category            text        NULL,

    -- UI promotion flags
    featured            boolean     NOT NULL DEFAULT false,

    -- Ownership / provenance
    --   is_system=true  : house preset, ships with Darkroom, often
    --                     prompt-hidden (Phase 2 IP rule). created_by
    --                     should be NULL.
    --   is_system=false : user-built preset. created_by should be set
    --                     (NULL allowed pre-auth-enforcement).
    is_system           boolean     NOT NULL DEFAULT false,
    created_by          uuid        NULL,

    -- Lifecycle
    archived            boolean     NOT NULL DEFAULT false,

    -- Timestamps. `updated_at` should auto-bump on UPDATE — same TODO
    -- as the assets table; until the shared trigger ships, callers
    -- should set updated_at = now() explicitly on UPDATE.
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Constraints
-- -----------------------------------------------------------------------------

-- Slug must be globally unique (used in URL paths).
CREATE UNIQUE INDEX IF NOT EXISTS presets_slug_unique_idx
    ON presets (slug);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Browse-by-type-and-category (e.g. "all film_emulation LUTs")
CREATE INDEX IF NOT EXISTS presets_type_category_idx
    ON presets (preset_type, category);

-- Tag search (text[] GIN)
CREATE INDEX IF NOT EXISTS presets_tags_gin_idx
    ON presets USING GIN (tags);

-- Config jsonb querying (e.g. find by config->>'prompt_template' or
-- config @> '{"hidden":true}')
CREATE INDEX IF NOT EXISTS presets_config_gin_idx
    ON presets USING GIN (config jsonb_path_ops);

-- Featured-row carousel: only live, featured rows.
CREATE INDEX IF NOT EXISTS presets_featured_idx
    ON presets (created_at DESC)
    WHERE featured = true AND archived = false;

-- Show system presets first / surface house presets quickly.
CREATE INDEX IF NOT EXISTS presets_system_idx
    ON presets (created_at DESC)
    WHERE is_system = true AND archived = false;

-- User-history view: a user's own presets, most recent first.
CREATE INDEX IF NOT EXISTS presets_created_by_idx
    ON presets (created_by, created_at DESC)
    WHERE created_by IS NOT NULL AND archived = false;

-- LUT lookup: jump from a preset to its underlying Hald-CLUT asset.
CREATE INDEX IF NOT EXISTS presets_lut_asset_id_idx
    ON presets (lut_asset_id)
    WHERE lut_asset_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Comments (self-documenting schema for downstream tooling)
-- -----------------------------------------------------------------------------
COMMENT ON TABLE  presets                  IS
    'Darkroom reusable bundles: engine configurations, LUT color grades, '
    'and saved chain definitions. House presets (is_system=true) ship with '
    'Darkroom; user presets (is_system=false) are built by users. See '
    'PLAN.md Phase 2 (Presets), Phase 11 (Chains), Phase 17 (LUT).';

COMMENT ON COLUMN presets.slug             IS
    'URL-safe stable identifier. UNIQUE. Used by '
    'POST /api/preset/:slug for engine_config presets.';
COMMENT ON COLUMN presets.preset_type      IS
    'engine_config | lut | chain';
COMMENT ON COLUMN presets.engine           IS
    'House engine name (lens, glance, strip, brush, etc.). Only meaningful '
    'when preset_type=''engine_config''. NULL otherwise.';
COMMENT ON COLUMN presets.config           IS
    'Per-preset_type flexible bag. engine_config: prompt_template, '
    'guidance_scale, steps, intensity_map, exposed_params, hidden. '
    'lut: default_intensity, blend_mode. Interpreted by the preset '
    'registry / API layer.';
COMMENT ON COLUMN presets.lut_asset_id     IS
    'For preset_type=''lut'': FK to assets row holding the Hald-CLUT PNG '
    '(typically 512×512 = 33×33×33 cube). ON DELETE SET NULL so the preset '
    'row survives asset deletion and can be re-bound.';
COMMENT ON COLUMN presets.chain_definition IS
    'For preset_type=''chain'': full step graph as jsonb. See PLAN.md '
    'Phase 11 (Chains) for shape.';
COMMENT ON COLUMN presets.is_system        IS
    'true = house preset (ships with Darkroom, often prompt-hidden per '
    'Phase 2 IP rule). false = user-built preset.';
COMMENT ON COLUMN presets.created_by       IS
    'User who built this preset. NULL for is_system=true rows or pre-auth '
    'seeded data.';

-- -----------------------------------------------------------------------------
-- TODO (follow-up task): updated_at auto-bump trigger
--
-- Same situation as the assets table — the shared touch_updated_at()
-- trigger function will be defined once in a dedicated migration and then
-- attached to presets via:
--
--   CREATE TRIGGER presets_touch_updated_at
--       BEFORE UPDATE ON presets
--       FOR EACH ROW
--       EXECUTE FUNCTION touch_updated_at();
--
-- Until that ships, callers should set updated_at = now() explicitly on
-- UPDATE.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- ROLLBACK:
--   DROP INDEX IF EXISTS presets_lut_asset_id_idx;
--   DROP INDEX IF EXISTS presets_created_by_idx;
--   DROP INDEX IF EXISTS presets_system_idx;
--   DROP INDEX IF EXISTS presets_featured_idx;
--   DROP INDEX IF EXISTS presets_config_gin_idx;
--   DROP INDEX IF EXISTS presets_tags_gin_idx;
--   DROP INDEX IF EXISTS presets_type_category_idx;
--   DROP INDEX IF EXISTS presets_slug_unique_idx;
--   DROP TABLE IF EXISTS presets CASCADE;
-- =============================================================================
