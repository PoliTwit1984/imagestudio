-- =============================================================================
-- Migration: 0055_luna_rls.sql
-- Purpose:   Enable Row Level Security on the three Darkroom Luna tables and
--            install per-user access policies so users can only read and write
--            their own data.
--
--            Tables covered:
--              darkroom_lunas          — guarded by user_id = auth.uid()
--              darkroom_luna_messages  — guarded via parent luna ownership
--              darkroom_luna_memories  — guarded via parent luna ownership
--
--            Policy design:
--              Each table gets four policies — SELECT, INSERT, UPDATE, DELETE.
--              For darkroom_lunas the predicate is the direct owner check:
--                  user_id = auth.uid()
--              For the child tables (messages, memories) the predicate is an
--              existence check through the parent:
--                  EXISTS (
--                      SELECT 1 FROM darkroom_lunas
--                      WHERE id = luna_id
--                        AND user_id = auth.uid()
--                  )
--              auth.uid() returns NULL for unauthenticated requests; all
--              equality / EXISTS checks against NULL evaluate to false, so
--              unauthenticated callers are implicitly denied without a
--              separate policy.
--
-- When:     2026-04-27
-- Author:   backend-3 / darkroom.luna.rls-policies
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is idempotent (safe to run if RLS
--             is already enabled). Every policy is preceded by a
--             DROP POLICY IF EXISTS so re-running is safe even on a DB that
--             already has these policies.
--
-- Prerequisites: 0054_create_lunas.sql (tables must exist).
--
-- ROLLBACK:
--   See bottom of file for the full rollback block.
-- =============================================================================

-- =============================================================================
-- TABLE: darkroom_lunas
-- =============================================================================

ALTER TABLE darkroom_lunas ENABLE ROW LEVEL SECURITY;

-- Force RLS to apply even to the table owner (service-role bypass is handled
-- by Supabase at the connection level, not here).
ALTER TABLE darkroom_lunas FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SELECT — a user can read only their own Luna record.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "lunas_select_own" ON darkroom_lunas;
CREATE POLICY "lunas_select_own"
    ON darkroom_lunas
    FOR SELECT
    USING (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- INSERT — a user can only insert a row that names themselves as the owner.
-- WITH CHECK prevents a client from writing user_id = <someone-else>.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "lunas_insert_own" ON darkroom_lunas;
CREATE POLICY "lunas_insert_own"
    ON darkroom_lunas
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- UPDATE — a user can update only their own Luna record, and the updated row
-- must still belong to them (cannot transfer ownership).
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "lunas_update_own" ON darkroom_lunas;
CREATE POLICY "lunas_update_own"
    ON darkroom_lunas
    FOR UPDATE
    USING     (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- DELETE — a user can delete only their own Luna record.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "lunas_delete_own" ON darkroom_lunas;
CREATE POLICY "lunas_delete_own"
    ON darkroom_lunas
    FOR DELETE
    USING (user_id = auth.uid());

-- =============================================================================
-- TABLE: darkroom_luna_messages
-- =============================================================================

ALTER TABLE darkroom_luna_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE darkroom_luna_messages FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SELECT — a user can read messages that belong to a Luna they own.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "luna_messages_select_own" ON darkroom_luna_messages;
CREATE POLICY "luna_messages_select_own"
    ON darkroom_luna_messages
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM   darkroom_lunas
            WHERE  id      = luna_id
              AND  user_id = auth.uid()
        )
    );

-- -----------------------------------------------------------------------------
-- INSERT — a user can only add messages to a Luna they own.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "luna_messages_insert_own" ON darkroom_luna_messages;
CREATE POLICY "luna_messages_insert_own"
    ON darkroom_luna_messages
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM   darkroom_lunas
            WHERE  id      = luna_id
              AND  user_id = auth.uid()
        )
    );

-- -----------------------------------------------------------------------------
-- UPDATE — a user can update only messages in a Luna they own.
-- The WITH CHECK re-verifies ownership so the row cannot be re-parented to a
-- different Luna (even one they also own, which would be a different record).
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "luna_messages_update_own" ON darkroom_luna_messages;
CREATE POLICY "luna_messages_update_own"
    ON darkroom_luna_messages
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1
            FROM   darkroom_lunas
            WHERE  id      = luna_id
              AND  user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM   darkroom_lunas
            WHERE  id      = luna_id
              AND  user_id = auth.uid()
        )
    );

-- -----------------------------------------------------------------------------
-- DELETE — a user can delete only messages in a Luna they own.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "luna_messages_delete_own" ON darkroom_luna_messages;
CREATE POLICY "luna_messages_delete_own"
    ON darkroom_luna_messages
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1
            FROM   darkroom_lunas
            WHERE  id      = luna_id
              AND  user_id = auth.uid()
        )
    );

-- =============================================================================
-- TABLE: darkroom_luna_memories
-- =============================================================================

ALTER TABLE darkroom_luna_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE darkroom_luna_memories FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SELECT — a user can read memories that belong to a Luna they own.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "luna_memories_select_own" ON darkroom_luna_memories;
CREATE POLICY "luna_memories_select_own"
    ON darkroom_luna_memories
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM   darkroom_lunas
            WHERE  id      = luna_id
              AND  user_id = auth.uid()
        )
    );

-- -----------------------------------------------------------------------------
-- INSERT — a user can only add memories to a Luna they own.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "luna_memories_insert_own" ON darkroom_luna_memories;
CREATE POLICY "luna_memories_insert_own"
    ON darkroom_luna_memories
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM   darkroom_lunas
            WHERE  id      = luna_id
              AND  user_id = auth.uid()
        )
    );

-- -----------------------------------------------------------------------------
-- UPDATE — a user can update only memories in a Luna they own.
-- WITH CHECK prevents re-parenting to a different Luna.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "luna_memories_update_own" ON darkroom_luna_memories;
CREATE POLICY "luna_memories_update_own"
    ON darkroom_luna_memories
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1
            FROM   darkroom_lunas
            WHERE  id      = luna_id
              AND  user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM   darkroom_lunas
            WHERE  id      = luna_id
              AND  user_id = auth.uid()
        )
    );

-- -----------------------------------------------------------------------------
-- DELETE — a user can delete only memories in a Luna they own.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "luna_memories_delete_own" ON darkroom_luna_memories;
CREATE POLICY "luna_memories_delete_own"
    ON darkroom_luna_memories
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1
            FROM   darkroom_lunas
            WHERE  id      = luna_id
              AND  user_id = auth.uid()
        )
    );

-- =============================================================================
-- ROLLBACK:
--   -- Drop policies — darkroom_luna_memories
--   DROP POLICY IF EXISTS "luna_memories_delete_own"  ON darkroom_luna_memories;
--   DROP POLICY IF EXISTS "luna_memories_update_own"  ON darkroom_luna_memories;
--   DROP POLICY IF EXISTS "luna_memories_insert_own"  ON darkroom_luna_memories;
--   DROP POLICY IF EXISTS "luna_memories_select_own"  ON darkroom_luna_memories;
--   ALTER TABLE darkroom_luna_memories NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE darkroom_luna_memories DISABLE ROW LEVEL SECURITY;
--
--   -- Drop policies — darkroom_luna_messages
--   DROP POLICY IF EXISTS "luna_messages_delete_own"  ON darkroom_luna_messages;
--   DROP POLICY IF EXISTS "luna_messages_update_own"  ON darkroom_luna_messages;
--   DROP POLICY IF EXISTS "luna_messages_insert_own"  ON darkroom_luna_messages;
--   DROP POLICY IF EXISTS "luna_messages_select_own"  ON darkroom_luna_messages;
--   ALTER TABLE darkroom_luna_messages NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE darkroom_luna_messages DISABLE ROW LEVEL SECURITY;
--
--   -- Drop policies — darkroom_lunas
--   DROP POLICY IF EXISTS "lunas_delete_own"          ON darkroom_lunas;
--   DROP POLICY IF EXISTS "lunas_update_own"          ON darkroom_lunas;
--   DROP POLICY IF EXISTS "lunas_insert_own"          ON darkroom_lunas;
--   DROP POLICY IF EXISTS "lunas_select_own"          ON darkroom_lunas;
--   ALTER TABLE darkroom_lunas NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE darkroom_lunas DISABLE ROW LEVEL SECURITY;
-- =============================================================================
