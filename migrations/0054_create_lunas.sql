-- =============================================================================
-- Migration: 0054_create_lunas.sql
-- Purpose:   Create three tables for Darkroom's Luna feature — per-user AI
--            companion state, conversation history, and long-term memory.
--
--            darkroom_lunas        — one Luna per user (persona, voice, face refs)
--            darkroom_luna_messages — conversation history (user / luna / system)
--            darkroom_luna_memories — long-term facts, preferences, events, kinks,
--                                     references; supports invalidation lifecycle.
--
--            See PLAN.md Phase 18.1 (LUNA) for the broader spec. This migration
--            is pure schema; no auth wiring. Authentication integration is a
--            follow-up task.
--
-- When:     2026-04-27
-- Author:   backend-1 / darkroom.luna.tables-migration
--
-- Idempotent: every CREATE uses IF NOT EXISTS, so re-running this migration
--             is safe. Does NOT drop or alter existing rows.
--
-- Note on user_id: stored as a bare uuid (no FK) — auth.users may not be
-- present at apply time in every environment (CI, branch DBs, fresh
-- staging). Same convention as 0042 / 0050 / 0052.
--
-- ROLLBACK:
--   See bottom of file for the full rollback block.
-- =============================================================================

-- Required extensions (gen_random_uuid lives in pgcrypto on older PG, in
-- core on PG13+; using IF NOT EXISTS keeps this safe either way).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Table: darkroom_lunas
-- -----------------------------------------------------------------------------
-- One row per user. Enforced by UNIQUE constraint on user_id below.
-- Stores the persona definition, voice configuration, and face reference
-- URLs that shape the Luna instance for that user. All content fields are
-- nullable so a Luna record can be created before it is fully configured.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS darkroom_lunas (
    -- Identity
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Owning user. Bare uuid — see header note about no FK.
    -- UNIQUE enforces one Luna per user.
    user_id         uuid        NOT NULL,

    -- Display name for this Luna instance (e.g. "Luna", "Sasha").
    name            text        NOT NULL DEFAULT 'Luna',

    -- System-prompt / persona definition. Free-form text that seeds the
    -- character's voice, style, and behavior in every conversation.
    persona_text    text        NULL,

    -- ElevenLabs voice id used for TTS on this Luna instance.
    -- e.g. 'tQ4MEZFJOzsahSEEZtHK' (Ivanna). NULL = voice disabled.
    voice_id        text        NULL,

    -- URL to the LoRA weights file that encodes this Luna's face.
    -- e.g. 'content/models/lora/luna-v2.safetensors'. NULL = no face LoRA.
    face_lora_url   text        NULL,

    -- URL to a canonical face reference image for img2img / face-swap.
    -- e.g. 'content/images/refs/luna-ref1.jpg'. NULL = no face ref.
    face_ref_url    text        NULL,

    -- Timestamps. updated_at auto-bumped by lunas_touch_updated_at trigger
    -- defined below.
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One Luna per user: a second INSERT for the same user_id must fail.
CREATE UNIQUE INDEX IF NOT EXISTS darkroom_lunas_user_id_unique_idx
    ON darkroom_lunas (user_id);

-- -----------------------------------------------------------------------------
-- Trigger: auto-bump updated_at on darkroom_lunas
-- -----------------------------------------------------------------------------
-- Defined inline here; when a shared touch_updated_at() function is promoted
-- to a dedicated migration (see the TODO in 0042), this trigger can be
-- redefined to use that shared function instead.
CREATE OR REPLACE FUNCTION darkroom_lunas_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lunas_touch_updated_at ON darkroom_lunas;
CREATE TRIGGER lunas_touch_updated_at
    BEFORE UPDATE ON darkroom_lunas
    FOR EACH ROW
    EXECUTE FUNCTION darkroom_lunas_set_updated_at();

-- -----------------------------------------------------------------------------
-- Table: darkroom_luna_messages
-- -----------------------------------------------------------------------------
-- Conversation history between a user and their Luna instance. One row per
-- turn. Role is constrained to 'user' | 'luna' | 'system'. attachments_jsonb
-- holds a list of asset references or inline data for any media attached to
-- the message (images, audio clips, etc.).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS darkroom_luna_messages (
    -- Identity
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which Luna conversation this message belongs to.
    luna_id         uuid        NOT NULL
                    REFERENCES darkroom_lunas(id)
                    ON DELETE CASCADE
                    DEFERRABLE INITIALLY DEFERRED,

    -- Who produced this message.
    --   user   : the human user
    --   luna   : the Luna AI response
    --   system : injected system context (persona refreshes, tool results, etc.)
    role            text        NOT NULL
                    CHECK (role IN (
                        'user',
                        'luna',
                        'system'
                    )),

    -- Message body. Plain text or markdown. Required — a message with no
    -- content is meaningless; use attachments_jsonb for media-only turns
    -- and set content to an empty string if truly content-free.
    content         text        NOT NULL,

    -- Attached media / asset references. Default empty array. Each element
    -- may be:
    --   { "type": "image", "asset_id": "<uuid>", "url": "..." }
    --   { "type": "audio", "url": "..." }
    --   { "type": "file",  "url": "...", "name": "..." }
    attachments_jsonb jsonb     NOT NULL DEFAULT '[]'::jsonb,

    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Messages by Luna ordered newest-first. The hot-path query is "give me
-- the last N messages for luna_id <X>" — this composite index serves
-- both the equality filter on luna_id and the ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS darkroom_luna_messages_luna_created_idx
    ON darkroom_luna_messages (luna_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Table: darkroom_luna_memories
-- -----------------------------------------------------------------------------
-- Long-term memory store for a Luna instance. One row per atomic memory unit.
-- Memories have a lifecycle: active when invalidated_at IS NULL, superseded
-- or retracted when invalidated_at is set. The partial index below excludes
-- invalidated rows from the hot lookup path.
--
-- source_msg_id links a memory back to the conversation turn that produced it
-- (optional — seeded / imported memories have no source message).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS darkroom_luna_memories (
    -- Identity
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which Luna this memory belongs to.
    luna_id         uuid        NOT NULL
                    REFERENCES darkroom_lunas(id)
                    ON DELETE CASCADE
                    DEFERRABLE INITIALLY DEFERRED,

    -- Memory category. CHECK-constrained so queries can filter efficiently.
    --   fact        : objective fact about the user or the world
    --   preference  : user like / dislike / default
    --   event       : something that happened (timestamped real-world event)
    --   kink        : sexual or intimate preference (handled with discretion)
    --   reference   : pointer to a person, place, thing, or external resource
    type            text        NOT NULL
                    CHECK (type IN (
                        'fact',
                        'preference',
                        'event',
                        'kink',
                        'reference'
                    )),

    -- The memory content itself. Plain text or markdown.
    body            text        NOT NULL,

    -- Optional: the message turn that produced this memory. ON DELETE SET
    -- NULL so deleting chat history does not destroy the memory record.
    source_msg_id   uuid        NULL
                    REFERENCES darkroom_luna_messages(id)
                    ON DELETE SET NULL
                    DEFERRABLE INITIALLY DEFERRED,

    -- Timestamps. created_at fires on insert.
    -- invalidated_at is NULL for active memories; set to a non-null
    -- timestamptz when the memory is retracted, superseded, or corrected.
    -- Use SELECT ... WHERE invalidated_at IS NULL to get the active set.
    created_at      timestamptz NOT NULL DEFAULT now(),
    invalidated_at  timestamptz NULL
);

-- Active memories by Luna + type. The partial predicate (WHERE invalidated_at
-- IS NULL) keeps the index lean — invalidated rows are excluded automatically
-- and won't inflate over time as memories are superseded.
CREATE INDEX IF NOT EXISTS darkroom_luna_memories_luna_type_active_idx
    ON darkroom_luna_memories (luna_id, type)
    WHERE invalidated_at IS NULL;

-- -----------------------------------------------------------------------------
-- Comments (self-documenting schema for downstream tooling)
-- -----------------------------------------------------------------------------
COMMENT ON TABLE  darkroom_lunas                           IS
    'Darkroom per-user Luna instance. One row per user (UNIQUE on user_id). '
    'Stores persona definition, voice id, and face reference URLs that shape '
    'the AI companion for that user.';

COMMENT ON COLUMN darkroom_lunas.user_id                   IS
    'Owning user. Bare uuid (no FK) — auth.users not guaranteed at apply time. '
    'UNIQUE: one Luna per user.';
COMMENT ON COLUMN darkroom_lunas.name                      IS
    'Display name for this Luna instance (e.g. "Luna", "Sasha").';
COMMENT ON COLUMN darkroom_lunas.persona_text              IS
    'System-prompt / character definition. Seeded into every conversation '
    'to establish voice, style, and behavior.';
COMMENT ON COLUMN darkroom_lunas.voice_id                  IS
    'ElevenLabs voice id for TTS. NULL = voice disabled.';
COMMENT ON COLUMN darkroom_lunas.face_lora_url             IS
    'URL to LoRA weights file for face-locked image generation. '
    'NULL = no face LoRA configured.';
COMMENT ON COLUMN darkroom_lunas.face_ref_url              IS
    'URL to canonical face reference image for img2img / face-swap. '
    'NULL = no face reference configured.';

COMMENT ON TABLE  darkroom_luna_messages                   IS
    'Conversation history for a Luna instance. One row per turn. '
    'role: user | luna | system. attachments_jsonb holds media refs.';

COMMENT ON COLUMN darkroom_luna_messages.luna_id           IS
    'Parent Luna instance. ON DELETE CASCADE — deleting a Luna clears its history.';
COMMENT ON COLUMN darkroom_luna_messages.role              IS
    'Who produced the message: user | luna | system. CHECK-constrained.';
COMMENT ON COLUMN darkroom_luna_messages.content           IS
    'Message body. Plain text or markdown. Required.';
COMMENT ON COLUMN darkroom_luna_messages.attachments_jsonb IS
    'Attached media / asset references. Array of {type, asset_id?, url, name?} '
    'objects. Default empty array.';

COMMENT ON TABLE  darkroom_luna_memories                   IS
    'Long-term memory store for a Luna instance. One row per atomic memory unit. '
    'Active memories have invalidated_at IS NULL; retracted / superseded memories '
    'have invalidated_at set. The luna_type_active partial index serves the '
    'hot active-memory lookup.';

COMMENT ON COLUMN darkroom_luna_memories.luna_id           IS
    'Parent Luna instance. ON DELETE CASCADE — deleting a Luna clears its memories.';
COMMENT ON COLUMN darkroom_luna_memories.type              IS
    'Memory category: fact | preference | event | kink | reference. CHECK-constrained.';
COMMENT ON COLUMN darkroom_luna_memories.body              IS
    'The memory content. Plain text or markdown.';
COMMENT ON COLUMN darkroom_luna_memories.source_msg_id     IS
    'The conversation turn that produced this memory. ON DELETE SET NULL so '
    'clearing chat history does not destroy the memory record.';
COMMENT ON COLUMN darkroom_luna_memories.invalidated_at    IS
    'NULL = active memory. Non-null = retracted / superseded. Never delete stale '
    'memories — set invalidated_at instead to preserve audit history.';

-- =============================================================================
-- ROLLBACK:
--   -- Drop indexes first
--   DROP INDEX IF EXISTS darkroom_luna_memories_luna_type_active_idx;
--   DROP INDEX IF EXISTS darkroom_luna_messages_luna_created_idx;
--   DROP INDEX IF EXISTS darkroom_lunas_user_id_unique_idx;
--   -- Drop trigger and function
--   DROP TRIGGER IF EXISTS lunas_touch_updated_at ON darkroom_lunas;
--   DROP FUNCTION IF EXISTS darkroom_lunas_set_updated_at();
--   -- Drop tables — dependent tables first
--   DROP TABLE IF EXISTS darkroom_luna_memories CASCADE;
--   DROP TABLE IF EXISTS darkroom_luna_messages CASCADE;
--   DROP TABLE IF EXISTS darkroom_lunas CASCADE;
-- =============================================================================
