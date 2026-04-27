-- =============================================================================
-- Migration: 0042_create_assets.sql
-- Purpose:   Create the `assets` table — Darkroom's universe-of-artifacts.
--            Replaces the prior `generations` table by absorbing every kind
--            of artifact (generations, uploads, edits, curated images, masks,
--            overlays) into one row-per-artifact model. `parent_id` links
--            edit chains; `metadata` jsonb is a flexible per-engine bag.
--
--            See PLAN.md Phase 1 (CATALOG) for the broader catalog spec.
--
-- When:     2026-04-27
-- Author:   backend-1 / darkroom.catalog.assets-table
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
-- Table: assets
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
    -- Identity
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What kind of artifact is this?
    --   generation : produced by a txt2img / img2img engine (Lens, Glance, etc.)
    --   upload     : raw user-supplied source file
    --   edit       : the result of an edit applied to a parent asset
    --   curated    : library / wardrobe / preset reference asset
    --   mask       : a mask image used by Brush / surgical edits
    --   overlay    : a garment cutout / sticker / overlay layer
    asset_type      text        NOT NULL
                    CHECK (asset_type IN (
                        'generation',
                        'upload',
                        'edit',
                        'curated',
                        'mask',
                        'overlay'
                    )),

    -- Edit-chain link. NULL = root-of-chain (uploaded source or fresh
    -- generation with no parent). Self-referential FK with ON DELETE SET NULL
    -- so deleting a parent does not orphan the chain.
    parent_id       uuid        NULL
                    REFERENCES assets(id)
                    ON DELETE SET NULL
                    DEFERRABLE INITIALLY DEFERRED,

    -- Where the bytes live. `source_url` is the canonical public URL
    -- (Supabase storage public URL or external CDN). `storage_path` is
    -- only set when Darkroom owns the storage object directly.
    source_url      text        NOT NULL,
    storage_path    text        NULL,

    -- Pixel + format metadata
    mime_type       text        NOT NULL DEFAULT 'image/png',
    width           int         NULL,
    height          int         NULL,

    -- Provenance
    --   engine: house engine name (Lens, Glance, Strip, Brush, Eye, Frame,
    --   Develop, Skin, Crisp, Reveal, Lock, Cutout, Watch). NULL for raw
    --   uploads. Stored as text (not enum) so we can add engines without
    --   a migration.
    engine          text        NULL,
    -- Edit-action verb when asset_type='edit' (e.g. 'wear', 'inpaint',
    -- 'face-swap', 'skin-pass', 'upscale'). Optional.
    edit_action     text        NULL,
    -- The user-facing prompt (or auto-generated description). NULL for
    -- raw uploads with no caption.
    prompt          text        NULL,

    -- Tags array — fast filtering, GIN-indexed below.
    tags            text[]      NOT NULL DEFAULT '{}',

    -- Flexible per-engine bag. Examples of fields that may live here:
    --   { "seed": 12345, "guidance_scale": 4.0, "steps": 17,
    --     "mask_url": "...", "lora": "LUNAV2", "vendor_model": "...",
    --     "edit_params": { ... }, "preset": "darkroom-skin-v1" }
    metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- Ownership. NULL allowed to support service-account / system rows
    -- (e.g. seeded curated assets) before per-user auth is enforced.
    user_id         uuid        NULL,

    -- Lifecycle flags
    starred         boolean     NOT NULL DEFAULT false,
    archived        boolean     NOT NULL DEFAULT false,

    -- Timestamps. `updated_at` should auto-bump on UPDATE — see TODO below.
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz NULL
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Edit-chain traversal (walk children of a parent)
CREATE INDEX IF NOT EXISTS assets_parent_id_idx
    ON assets (parent_id);

-- User history view: most recent first
CREATE INDEX IF NOT EXISTS assets_user_created_idx
    ON assets (user_id, created_at DESC);

-- Filter-by-type history (e.g. "show me only generations")
CREATE INDEX IF NOT EXISTS assets_type_created_idx
    ON assets (asset_type, created_at DESC);

-- Tag search (text[] GIN)
CREATE INDEX IF NOT EXISTS assets_tags_gin_idx
    ON assets USING GIN (tags);

-- Metadata jsonb querying (e.g. find by metadata->>'preset' or
-- metadata @> '{"engine":"Lens"}')
CREATE INDEX IF NOT EXISTS assets_metadata_gin_idx
    ON assets USING GIN (metadata jsonb_path_ops);

-- Engine-filtered history (cheap partial index, only non-null engines)
CREATE INDEX IF NOT EXISTS assets_engine_created_idx
    ON assets (engine, created_at DESC)
    WHERE engine IS NOT NULL;

-- Soft-delete-aware lookups: by default callers SHOULD `WHERE deleted_at
-- IS NULL`. This partial index makes that fast.
CREATE INDEX IF NOT EXISTS assets_live_created_idx
    ON assets (created_at DESC)
    WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- Comments (self-documenting schema for downstream tooling)
-- -----------------------------------------------------------------------------
COMMENT ON TABLE  assets               IS
    'Darkroom universe-of-artifacts. Replaces `generations`. Every image, '
    'mask, overlay, upload, edit, or curated asset is a row here. parent_id '
    'links edit chains; metadata jsonb is a per-engine bag.';

COMMENT ON COLUMN assets.asset_type    IS
    'generation | upload | edit | curated | mask | overlay';
COMMENT ON COLUMN assets.parent_id     IS
    'NULL for root-of-chain (raw upload or fresh generation). Self-FK; '
    'ON DELETE SET NULL so chains are not orphaned.';
COMMENT ON COLUMN assets.source_url    IS
    'Canonical public URL (Supabase public URL or external CDN).';
COMMENT ON COLUMN assets.storage_path  IS
    'Path within Supabase storage if Darkroom owns the bytes; NULL '
    'when the asset only lives at an external URL.';
COMMENT ON COLUMN assets.engine        IS
    'House engine name (Lens, Glance, Strip, Brush, Eye, Frame, Develop, '
    'Skin, Crisp, Reveal, Lock, Cutout, Watch). NULL for raw uploads.';
COMMENT ON COLUMN assets.edit_action   IS
    'Verb describing the edit when asset_type=''edit''. e.g. wear, '
    'inpaint, face-swap, skin-pass, upscale.';
COMMENT ON COLUMN assets.metadata      IS
    'Per-engine flexible bag. seed, guidance_scale, steps, mask_url, '
    'lora, vendor_model, preset, edit_params, etc.';
COMMENT ON COLUMN assets.deleted_at    IS
    'Soft delete. Callers should filter `WHERE deleted_at IS NULL` by '
    'default; the assets_live_created_idx partial index makes that fast.';

-- -----------------------------------------------------------------------------
-- TODO (follow-up task): updated_at auto-bump trigger
--
-- The standard pattern is:
--
--   CREATE OR REPLACE FUNCTION touch_updated_at()
--   RETURNS trigger LANGUAGE plpgsql AS $$
--   BEGIN
--       NEW.updated_at = now();
--       RETURN NEW;
--   END;
--   $$;
--
--   CREATE TRIGGER assets_touch_updated_at
--       BEFORE UPDATE ON assets
--       FOR EACH ROW
--       EXECUTE FUNCTION touch_updated_at();
--
-- Left out of this migration so the trigger function can be defined once
-- and reused across tables in a dedicated migration. Until that ships,
-- callers should set updated_at = now() explicitly on UPDATE.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- ROLLBACK:
--   DROP INDEX IF EXISTS assets_live_created_idx;
--   DROP INDEX IF EXISTS assets_engine_created_idx;
--   DROP INDEX IF EXISTS assets_metadata_gin_idx;
--   DROP INDEX IF EXISTS assets_tags_gin_idx;
--   DROP INDEX IF EXISTS assets_type_created_idx;
--   DROP INDEX IF EXISTS assets_user_created_idx;
--   DROP INDEX IF EXISTS assets_parent_id_idx;
--   DROP TABLE IF EXISTS assets CASCADE;
-- =============================================================================
