-- =============================================================================
-- Migration: 0049_presets_lut_columns.sql
-- Purpose:   Augment the `presets` table (created in 0044) with LUT-specific
--            columns and introduce two auxiliary tables — `lut_bundles` and
--            `lut_bundle_members` — for richer LUT preset metadata.
--
--            Why: Phase 17 (LUT EXTRACTION) presets need more than a single
--            Hald-CLUT asset reference. We want:
--              - sensible default intensity at apply time
--              - the LUT's wire format so the renderer can dispatch correctly
--              - before/after preview thumbnails for the LUT browser
--              - source provenance (which Grok-extracted asset birthed it)
--              - the ability to group LUTs into themed bundles ("Kodak
--                Portra 400 — 5 variants", "Cinematic Teal & Orange Pack")
--
--            See PLAN.md Phase 17 (LUT EXTRACTION), Phase 2 (PRESETS), and
--            the Darkroom LUT Bundle browser spec for context.
--
-- When:     2026-04-27
-- Author:   backend-3 / darkroom.lut.preset-bundle-schema
--
-- Idempotent: every ADD COLUMN / CREATE uses IF NOT EXISTS, so re-running
--             this migration is safe. Does NOT drop or modify existing rows.
--
-- ROLLBACK:
--   See bottom of file for the full rollback block.
-- =============================================================================

-- Required extensions (gen_random_uuid lives in pgcrypto on older PG, in
-- core on PG13+; using IF NOT EXISTS keeps this safe either way).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- ALTER: presets — add LUT-specific columns
-- -----------------------------------------------------------------------------
-- ADD COLUMN IF NOT EXISTS requires Postgres 9.6+. Keeping each ALTER as a
-- standalone statement makes partial-replay scenarios safer and isolates
-- failures to a single column.

-- Default intensity at LUT apply time. Renderers consume this when the
-- caller doesn't pass an explicit `intensity` param. 1.0 = full strength,
-- 0.0 = passthrough (no color change).
ALTER TABLE IF EXISTS presets
    ADD COLUMN IF NOT EXISTS lut_intensity_default real NOT NULL DEFAULT 1.0;

-- Wire format for the LUT payload referenced by `lut_asset_id`. The
-- renderer dispatches on this to pick the right decoder.
--   hald-clut : Hald-CLUT PNG (typically 512×512 = 33³ cube)
--   cube      : Adobe `.cube` text-format LUT
--   png-strip : 1D / strip-style PNG LUT
-- NULL allowed for non-LUT rows.
ALTER TABLE IF EXISTS presets
    ADD COLUMN IF NOT EXISTS lut_format text NULL
        CHECK (lut_format IS NULL OR lut_format IN (
            'hald-clut',
            'cube',
            'png-strip'
        ));

-- Preview "before" image — what the LUT was applied TO. Shown in the LUT
-- browser as the left half of the before/after card. ON DELETE SET NULL so
-- deleting the preview asset leaves the preset row intact (just unbinds).
ALTER TABLE IF EXISTS presets
    ADD COLUMN IF NOT EXISTS sample_before_asset_id uuid NULL
        REFERENCES assets(id)
        ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED;

-- Preview "after" image — what the LUT produces. Shown as the right half
-- of the before/after card. Same ON DELETE SET NULL semantics as above.
ALTER TABLE IF EXISTS presets
    ADD COLUMN IF NOT EXISTS sample_after_asset_id uuid NULL
        REFERENCES assets(id)
        ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED;

-- Source / provenance metadata for LUT presets. Tracks where the LUT came
-- from so we can audit, re-extract, or show a "derived from" credit.
-- Shape (illustrative):
--   {
--     "extracted_from": "<asset_id of the source still>",
--     "extraction_method": "grok-extract",
--     "extraction_date": "2026-04-27T15:32:00Z",
--     "extractor_version": "v1.2.0",
--     "notes": "..."
--   }
-- `extraction_method` enums of interest: 'grok-extract' | 'manual'.
ALTER TABLE IF EXISTS presets
    ADD COLUMN IF NOT EXISTS source_provenance jsonb NULL;

-- -----------------------------------------------------------------------------
-- Table: lut_bundles
-- -----------------------------------------------------------------------------
-- A side-table for LUTs that ship as a curated collection (e.g. "Kodak
-- Portra 400 — 5 variants" or "Editorial Pack vol. 1"). Bundles are
-- discoverable independent of individual presets and can be featured /
-- archived as a group.
CREATE TABLE IF NOT EXISTS lut_bundles (
    -- Identity
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Human-readable display name. e.g. "Kodak Portra 400",
    -- "Cinematic Teal & Orange Pack".
    name                text        NOT NULL,

    -- URL-safe stable identifier. UNIQUE — used by the API at
    -- GET /api/lut-bundles/:slug.
    slug                text        NULL,

    -- Optional human-readable explanation. Shown in the bundle card and
    -- on the bundle detail page.
    description         text        NULL,

    -- Hero thumbnail for the bundle card. Typically a composite of the
    -- bundle's strongest LUT preview. ON DELETE SET NULL so we never
    -- orphan a bundle when an asset is purged.
    thumbnail_asset_id  uuid        NULL
                        REFERENCES assets(id)
                        ON DELETE SET NULL
                        DEFERRABLE INITIALLY DEFERRED,

    -- Cached count of member LUT presets. Maintained by application code
    -- (or a future trigger) on insert/delete in `lut_bundle_members`.
    -- Denormalized for fast list rendering — source of truth is still
    -- the join table.
    lut_count           integer     NOT NULL DEFAULT 0,

    -- Tags array — fast filtering, GIN-indexed below. e.g.
    -- ['film_emulation', 'warm', 'cinematic'].
    tags                text[]      NOT NULL DEFAULT '{}',

    -- UI promotion flags
    featured            boolean     NOT NULL DEFAULT false,

    -- Lifecycle
    archived            boolean     NOT NULL DEFAULT false,

    -- Timestamps. Same `updated_at` auto-bump TODO as the rest of the
    -- schema — until the shared trigger ships, callers should set
    -- updated_at = now() explicitly on UPDATE.
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Table: lut_bundle_members (join)
-- -----------------------------------------------------------------------------
-- Many-to-many between lut_bundles and presets, with a `position` column
-- for stable display order within a bundle. `preset_id` should reference
-- a preset row whose preset_type = 'lut'; this is enforced in application
-- code (DB-level check would require a SQL function and a trigger, kept
-- out of this migration for clarity).
CREATE TABLE IF NOT EXISTS lut_bundle_members (
    -- FK to the bundle. ON DELETE CASCADE: dropping a bundle drops its
    -- membership rows (the underlying preset rows are NOT touched).
    bundle_id           uuid        NOT NULL
                        REFERENCES lut_bundles(id)
                        ON DELETE CASCADE
                        DEFERRABLE INITIALLY DEFERRED,

    -- FK to the preset (must be preset_type='lut' — enforced in app
    -- layer). ON DELETE CASCADE: dropping a preset drops its membership
    -- rows so we never have dangling pointers.
    preset_id           uuid        NOT NULL
                        REFERENCES presets(id)
                        ON DELETE CASCADE
                        DEFERRABLE INITIALLY DEFERRED,

    -- Display order within the bundle (0-based). Multiple members can
    -- share a position if the UI doesn't care; index below orders by
    -- (bundle_id, position) for the common "render bundle in order"
    -- query.
    position            integer     NOT NULL DEFAULT 0,

    -- When the preset was added to the bundle. Useful for "recently
    -- added" sorts.
    added_at            timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (bundle_id, preset_id)
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- presets: dispatch-by-format for the LUT renderer. Partial — only LUT
-- rows have a non-NULL lut_format that's worth indexing.
CREATE INDEX IF NOT EXISTS presets_lut_format_idx
    ON presets (lut_format)
    WHERE preset_type = 'lut';

-- lut_bundles: slug must be globally unique (used in URL paths).
CREATE UNIQUE INDEX IF NOT EXISTS lut_bundles_slug_unique_idx
    ON lut_bundles (slug)
    WHERE slug IS NOT NULL;

-- lut_bundles: featured-row carousel — only live, featured rows.
CREATE INDEX IF NOT EXISTS lut_bundles_featured_idx
    ON lut_bundles (created_at DESC)
    WHERE featured = true AND archived = false;

-- lut_bundles: tag search (text[] GIN)
CREATE INDEX IF NOT EXISTS lut_bundles_tags_gin_idx
    ON lut_bundles USING GIN (tags);

-- lut_bundle_members: ordered render of a bundle's members.
CREATE INDEX IF NOT EXISTS lut_bundle_members_bundle_position_idx
    ON lut_bundle_members (bundle_id, position);

-- lut_bundle_members: reverse lookup — "what bundles is this preset in?"
CREATE INDEX IF NOT EXISTS lut_bundle_members_preset_id_idx
    ON lut_bundle_members (preset_id);

-- -----------------------------------------------------------------------------
-- Comments (self-documenting schema for downstream tooling)
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN presets.lut_intensity_default IS
    'Default intensity at LUT apply time. 1.0=full, 0.0=passthrough. '
    'Used when the caller does not pass an explicit `intensity` param.';
COMMENT ON COLUMN presets.lut_format IS
    'Wire format of the LUT payload at lut_asset_id: hald-clut | cube | '
    'png-strip. NULL for non-LUT presets. Renderer dispatches on this.';
COMMENT ON COLUMN presets.sample_before_asset_id IS
    'Preview "before" image — the source the LUT was applied to. Shown '
    'in the LUT browser before/after card. ON DELETE SET NULL.';
COMMENT ON COLUMN presets.sample_after_asset_id IS
    'Preview "after" image — the LUT-applied result. ON DELETE SET NULL.';
COMMENT ON COLUMN presets.source_provenance IS
    'Provenance metadata for LUT presets: extracted_from (asset_id), '
    'extraction_method (grok-extract | manual), extraction_date '
    '(timestamptz), and other audit fields. JSONB.';

COMMENT ON TABLE  lut_bundles IS
    'Curated collections of LUT presets (e.g. "Kodak Portra 400 — 5 '
    'variants"). Bundles can be featured and archived independently of '
    'their member presets.';
COMMENT ON COLUMN lut_bundles.lut_count IS
    'Cached count of member LUT presets. Denormalized for fast list '
    'rendering — source of truth is the lut_bundle_members table.';

COMMENT ON TABLE  lut_bundle_members IS
    'Join table: lut_bundles <-> presets (LUT presets only — enforced '
    'in app layer). PRIMARY KEY (bundle_id, preset_id). Ordered by '
    '`position` within a bundle.';

-- =============================================================================
-- ROLLBACK:
--   -- Drop in reverse: members -> bundles -> ALTER DROP COLUMN.
--   DROP INDEX IF EXISTS lut_bundle_members_preset_id_idx;
--   DROP INDEX IF EXISTS lut_bundle_members_bundle_position_idx;
--   DROP INDEX IF EXISTS lut_bundles_tags_gin_idx;
--   DROP INDEX IF EXISTS lut_bundles_featured_idx;
--   DROP INDEX IF EXISTS lut_bundles_slug_unique_idx;
--   DROP INDEX IF EXISTS presets_lut_format_idx;
--
--   DROP TABLE IF EXISTS lut_bundle_members CASCADE;
--   DROP TABLE IF EXISTS lut_bundles CASCADE;
--
--   ALTER TABLE IF EXISTS presets DROP COLUMN IF EXISTS source_provenance;
--   ALTER TABLE IF EXISTS presets DROP COLUMN IF EXISTS sample_after_asset_id;
--   ALTER TABLE IF EXISTS presets DROP COLUMN IF EXISTS sample_before_asset_id;
--   ALTER TABLE IF EXISTS presets DROP COLUMN IF EXISTS lut_format;
--   ALTER TABLE IF EXISTS presets DROP COLUMN IF EXISTS lut_intensity_default;
-- =============================================================================
