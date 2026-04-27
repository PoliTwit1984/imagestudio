-- =============================================================================
-- Migration: 0045_create_projects.sql
-- Purpose:   Create the `projects` table and the `project_assets` join table.
--
--            A "project" is the user-facing organizational unit in Darkroom —
--            a named folder/board for a session, client, or shoot. Each
--            project contains many assets (uploads, generations, edits) and
--            one asset can live in many projects (many-to-many).
--
--            See PLAN.md Phase 1 (CATALOG, section 1.1) for the broader
--            catalog spec — projects sit alongside `assets`, `wardrobe`,
--            and `presets` as the org/persistence layer.
--
-- When:     2026-04-27
-- Author:   backend-3 / darkroom.catalog.projects-tables
--
-- Idempotent: every CREATE uses IF NOT EXISTS, so re-running this migration
--             is safe. Does NOT drop or alter existing rows.
--
-- ROLLBACK:
--   See bottom of file for the full rollback block. Drop `project_assets`
--   first (dependent), then `projects`.
-- =============================================================================

-- Required extensions (gen_random_uuid lives in pgcrypto on older PG, in
-- core on PG13+; using IF NOT EXISTS keeps this safe either way).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Table: projects
-- -----------------------------------------------------------------------------
-- A project is a named collection of assets the user is working on. Think
-- "folder" or "board" — one per session, client, shoot, or campaign. The
-- user-facing organizational unit in Darkroom.
--
-- Notes:
--   * cover_asset_id is intentionally NOT a hard FK to assets(id) here.
--     The reason: this migration must remain self-contained and
--     idempotent regardless of whether 0042_create_assets.sql has been
--     applied yet (e.g. fresh staging clones, partial re-runs). The
--     application layer is responsible for keeping cover_asset_id
--     pointing at a real assets row. A follow-up migration can promote
--     it to a constrained FK once both tables are universally present.
--   * user_id is nullable to support service-account / system-seeded
--     projects (e.g. starter templates) before per-user auth is enforced,
--     mirroring the pattern in `assets`.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    -- Identity
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Display
    name            text        NOT NULL,
    -- URL-safe slug. Uniqueness enforced as a composite (user_id, slug)
    -- partial unique index below — not a column constraint, because we
    -- want to allow NULL user_id to repeat slugs harmlessly during
    -- the pre-auth phase.
    slug            text        NULL,
    description     text        NULL,

    -- Thumbnail / hero asset for the project. See note above re: no FK.
    cover_asset_id  uuid        NULL,

    -- Tags array — fast filtering, GIN-indexed below.
    tags            text[]      NOT NULL DEFAULT '{}',

    -- Flexible per-project bag. Use cases:
    --   { "client": "Sasha", "shoot_date": "2026-05-01",
    --     "color_palette": ["#1a1a1a", "#c0392b"],
    --     "default_engine": "Lens", "share_link_id": "..." }
    metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- Ownership. NULL allowed to support service-account / system rows
    -- (e.g. seeded starter projects) before per-user auth is enforced.
    user_id         uuid        NULL,

    -- Lifecycle flags
    featured        boolean     NOT NULL DEFAULT false,
    archived        boolean     NOT NULL DEFAULT false,

    -- Timestamps. `updated_at` should auto-bump on UPDATE — the shared
    -- touch_updated_at() trigger pattern documented in 0042 will pick
    -- this table up when that follow-up migration ships.
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz NULL
);

-- -----------------------------------------------------------------------------
-- Table: project_assets (many-to-many join)
-- -----------------------------------------------------------------------------
-- Joins `projects` <-> `assets`. One project has many assets; one asset
-- can live in many projects (e.g. a hero shot used in both a portfolio
-- project and a client deliverable project).
--
-- Composite primary key (project_id, asset_id) prevents duplicate
-- inclusions of the same asset in the same project. ON DELETE CASCADE
-- on both FKs cleans up the join row when either side disappears.
--
-- The FK to projects(id) is always safe to declare here — the table
-- was just created above. The FK to assets(id) is declared and assumes
-- 0042_create_assets.sql has been applied (an earlier migration in
-- numerical order). If you hit a "relation \"assets\" does not exist"
-- error, run 0042 first.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_assets (
    project_id      uuid        NOT NULL
                    REFERENCES projects(id)
                    ON DELETE CASCADE
                    DEFERRABLE INITIALLY DEFERRED,

    asset_id        uuid        NOT NULL
                    REFERENCES assets(id)
                    ON DELETE CASCADE
                    DEFERRABLE INITIALLY DEFERRED,

    -- Manual ordering of assets within a project (drag-to-reorder UX).
    -- Sparse integers are fine; the app picks the spacing convention
    -- (e.g. 100, 200, 300 to allow easy inserts).
    position        int         NULL,

    -- Per-membership flags / annotations
    pinned          boolean     NOT NULL DEFAULT false,
    note            text        NULL,

    added_at        timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (project_id, asset_id)
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Live-projects-by-user view: most recent first, archived rows excluded
-- via partial predicate. Powers the default sidebar / dashboard list.
CREATE INDEX IF NOT EXISTS projects_user_live_created_idx
    ON projects (user_id, archived, created_at DESC)
    WHERE NOT archived;

-- Per-user slug uniqueness. NULL user_id allowed to repeat (pre-auth
-- service rows). Slugs themselves can be NULL during draft creation;
-- the partial index excludes those too.
CREATE UNIQUE INDEX IF NOT EXISTS projects_user_slug_unique_idx
    ON projects (user_id, slug)
    WHERE slug IS NOT NULL AND user_id IS NOT NULL;

-- Tag search (text[] GIN) — same pattern as assets.
CREATE INDEX IF NOT EXISTS projects_tags_gin_idx
    ON projects USING GIN (tags);

-- Soft-delete-aware partial index for global "all live projects" lookups.
CREATE INDEX IF NOT EXISTS projects_live_created_idx
    ON projects (created_at DESC)
    WHERE deleted_at IS NULL;

-- Forward traversal: list the assets in a project, in user-defined order.
-- The composite (project_id, position) supports both the project_id
-- equality filter and the ORDER BY position in one index.
CREATE INDEX IF NOT EXISTS project_assets_project_position_idx
    ON project_assets (project_id, position);

-- Reverse lookup: which projects contain asset X? Cheap, single column.
CREATE INDEX IF NOT EXISTS project_assets_asset_idx
    ON project_assets (asset_id);

-- -----------------------------------------------------------------------------
-- Comments (self-documenting schema for downstream tooling)
-- -----------------------------------------------------------------------------
COMMENT ON TABLE  projects                 IS
    'Darkroom organizational unit. A named folder/board for a session, '
    'client, shoot, or campaign. User-facing — every asset can be added '
    'to many projects via project_assets.';

COMMENT ON COLUMN projects.slug            IS
    'URL-safe slug; unique per user via projects_user_slug_unique_idx. '
    'Nullable during draft creation.';
COMMENT ON COLUMN projects.cover_asset_id  IS
    'Thumbnail asset for the project. Not a hard FK in this migration — '
    'application layer keeps it consistent. Will be promoted to a '
    'constrained FK once both tables are universally present.';
COMMENT ON COLUMN projects.metadata        IS
    'Per-project flexible bag. client, shoot_date, color_palette, '
    'default_engine, share_link_id, etc.';
COMMENT ON COLUMN projects.featured        IS
    'Surface the project on the home/dashboard featured row.';
COMMENT ON COLUMN projects.archived        IS
    'Hidden from the default sidebar list. Distinct from soft-delete '
    '(deleted_at) — archived projects are still recoverable in a '
    'one-click "show archived" view.';
COMMENT ON COLUMN projects.deleted_at      IS
    'Soft delete. Callers should filter `WHERE deleted_at IS NULL` by '
    'default; the projects_live_created_idx partial index makes that fast.';

COMMENT ON TABLE  project_assets           IS
    'Many-to-many join between projects and assets. Composite PK '
    '(project_id, asset_id) prevents duplicates. ON DELETE CASCADE on '
    'both sides keeps the join clean.';
COMMENT ON COLUMN project_assets.position  IS
    'Manual ordering within a project (drag-to-reorder). Sparse '
    'integers allowed (e.g. 100, 200, 300) so inserts do not require '
    'rewriting siblings.';
COMMENT ON COLUMN project_assets.pinned    IS
    'Asset is pinned to the top of the project regardless of position.';
COMMENT ON COLUMN project_assets.note      IS
    'Free-form note attached to the membership (not the asset itself). '
    'e.g. "use this one for the cover", "client liked this best".';

-- =============================================================================
-- ROLLBACK:
--   -- Drop join indexes first
--   DROP INDEX IF EXISTS project_assets_asset_idx;
--   DROP INDEX IF EXISTS project_assets_project_position_idx;
--   -- Drop projects indexes
--   DROP INDEX IF EXISTS projects_live_created_idx;
--   DROP INDEX IF EXISTS projects_tags_gin_idx;
--   DROP INDEX IF EXISTS projects_user_slug_unique_idx;
--   DROP INDEX IF EXISTS projects_user_live_created_idx;
--   -- Drop tables — project_assets first (dependent on projects)
--   DROP TABLE IF EXISTS project_assets CASCADE;
--   DROP TABLE IF EXISTS projects CASCADE;
-- =============================================================================
