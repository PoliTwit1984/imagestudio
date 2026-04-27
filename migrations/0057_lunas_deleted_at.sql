-- =============================================================================
-- Migration: 0057_lunas_deleted_at.sql
-- Purpose:   Add deleted_at column to darkroom_lunas to support soft-deletes.
--
--            The Luna API DELETE endpoint (DELETE /api/lunas/:id) sets
--            deleted_at = now() rather than hard-deleting the row. The GET
--            /api/lunas/me endpoint filters rows where deleted_at IS NULL so
--            soft-deleted Lunas are invisible to callers without losing the
--            underlying persona / voice / face-ref data (useful for audits
--            and potential undelete flows).
--
-- When:     2026-04-27
-- Author:   backend-1 / darkroom.luna.api-delete
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to re-run.
--
-- Note: getLunaForUser in lunaCompanion.ts should be updated after this
-- migration is applied to append &deleted_at=is.null to its PostgREST query
-- so that soft-deleted Lunas are transparently excluded from the "me" lookup.
-- The route handler in safe-edit.ts already delegates to getLunaForUser, so
-- that single change will cover both GET /api/lunas/me and any other caller
-- using the helper.
--
-- ROLLBACK:
--   ALTER TABLE darkroom_lunas DROP COLUMN IF EXISTS deleted_at;
-- =============================================================================

ALTER TABLE darkroom_lunas
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;

COMMENT ON COLUMN darkroom_lunas.deleted_at IS
    'Soft-delete timestamp. NULL = active. Non-null = deleted by owner via '
    'DELETE /api/lunas/:id. Rows with deleted_at IS NOT NULL are excluded from '
    'the GET /api/lunas/me response. Hard deletes are never performed — use '
    'this column + invalidated_at (on memories) for full lifecycle audit.';
