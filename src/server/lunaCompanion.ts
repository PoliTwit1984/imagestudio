// =============================================================================
// src/server/lunaCompanion.ts
//
// Per-user Luna companion module for Darkroom.
//
// Purpose:
//   CRUD helpers and runtime utilities for the darkroom_lunas,
//   darkroom_luna_messages, and darkroom_luna_memories tables defined in
//   migrations/0054_create_lunas.sql.
//
// Exports:
//   Types:      Luna, LunaMessage, LunaMemory
//   CRUD:       createLuna, getLunaForUser, updateLuna
//   Runtime:    buildSystemPrompt, classifyMemoryFromMessage
//
// Inputs/Outputs:
//   All async functions read/write via PostgREST (Supabase REST API).
//   No direct Postgres driver — same pattern as billing.ts.
//
// Side Effects:
//   createLuna inserts a row into darkroom_lunas (unique per user_id).
//   updateLuna PATCHes a row; triggers updated_at bump via DB trigger.
//   Reads are side-effect-free.
//
// Failure Behavior:
//   Async functions throw on non-2xx HTTP responses.
//   getLunaForUser returns null when no record exists (404-like: empty array).
//   buildSystemPrompt is pure and never throws.
//   classifyMemoryFromMessage is a stub — see TODO below.
//
// Pairs with:
//   migrations/0054_create_lunas.sql
//   src/server/supabase.ts  (supaHeaders, encodeFilterValue)
//   src/server/config.ts    (SUPABASE_URL)
// =============================================================================

import { SUPABASE_URL } from "./config";
import { encodeFilterValue, supaHeaders } from "./supabase";

// =============================================================================
// Types — mirror the darkroom_lunas / darkroom_luna_messages /
//          darkroom_luna_memories table columns verbatim.
// =============================================================================

/** One Luna instance per user. Maps 1-to-1 with a darkroom_lunas row. */
export interface Luna {
  id: string;
  user_id: string;
  /** Display name (e.g. "Luna", "Sasha"). */
  name: string;
  /** System-prompt / persona definition. Seeds every conversation. */
  persona_text: string | null;
  /** ElevenLabs voice id. NULL = voice disabled. */
  voice_id: string | null;
  /** URL to LoRA weights file for face-locked image generation. */
  face_lora_url: string | null;
  /** URL to canonical face reference image for img2img / face-swap. */
  face_ref_url: string | null;
  created_at: string;
  updated_at: string;
}

/** One turn in a Luna conversation. Maps to darkroom_luna_messages. */
export interface LunaMessage {
  id: string;
  luna_id: string;
  /** Who produced the message: 'user' | 'luna' | 'system'. */
  role: "user" | "luna" | "system";
  /** Message body. Plain text or markdown. */
  content: string;
  /** Attached media / asset references. Array of typed objects. */
  attachments_jsonb: Array<{
    type: "image" | "audio" | "file";
    asset_id?: string;
    url?: string;
    name?: string;
  }>;
  created_at: string;
}

/** One atomic memory unit. Maps to darkroom_luna_memories. */
export interface LunaMemory {
  id: string;
  luna_id: string;
  /**
   * Memory category.
   * - fact       : objective fact about the user or the world
   * - preference : user like / dislike / default
   * - event      : something that happened (timestamped real-world event)
   * - kink       : sexual or intimate preference
   * - reference  : pointer to a person, place, thing, or external resource
   */
  type: "fact" | "preference" | "event" | "kink" | "reference";
  /** The memory content. Plain text or markdown. */
  body: string;
  /** Source message turn that produced this memory (may be null). */
  source_msg_id: string | null;
  created_at: string;
  /** NULL = active. Non-null = retracted / superseded. */
  invalidated_at: string | null;
}

// =============================================================================
// Internal helpers
// =============================================================================

/** Base URL for the darkroom_lunas table via PostgREST. */
function lunaTableUrl(): string {
  return `${SUPABASE_URL}/rest/v1/darkroom_lunas`;
}

/**
 * Shared error builder — reads the PostgREST error body for a useful message.
 */
async function postgressError(
  label: string,
  res: Response
): Promise<Error> {
  let detail = "";
  try {
    const body = await res.json() as { message?: string; hint?: string };
    detail = body.message || body.hint || "";
  } catch {
    detail = await res.text().catch(() => "");
  }
  return new Error(
    `[lunaCompanion] ${label}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`
  );
}

// =============================================================================
// CRUD
// =============================================================================

/**
 * Create a new Luna instance for a user.
 *
 * The darkroom_lunas table enforces UNIQUE(user_id), so calling this twice
 * for the same user will result in a 409 / duplicate-key error from
 * PostgREST. Callers that need "create or fetch" semantics should use
 * getLunaForUser first.
 *
 * @param userId   UUID of the owning user.
 * @param opts     Required `name`; optional `persona_text` and `voice_id`.
 * @returns        The newly created Luna row.
 */
export async function createLuna(
  userId: string,
  opts: { name: string; persona_text?: string; voice_id?: string }
): Promise<Luna> {
  if (!SUPABASE_URL) throw new Error("[lunaCompanion] SUPABASE_URL not configured");

  const body: Record<string, unknown> = {
    user_id: userId,
    name: opts.name,
  };
  if (opts.persona_text !== undefined) body.persona_text = opts.persona_text;
  if (opts.voice_id !== undefined) body.voice_id = opts.voice_id;

  const res = await fetch(lunaTableUrl(), {
    method: "POST",
    headers: {
      ...supaHeaders(),
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw await postgressError("createLuna", res);

  const rows = (await res.json()) as Luna[];
  if (!rows[0]) throw new Error("[lunaCompanion] createLuna: empty response");
  return rows[0];
}

/**
 * Retrieve the Luna instance for a given user.
 *
 * @param userId  UUID of the owning user.
 * @returns       The Luna row, or null if the user has no Luna yet.
 */
export async function getLunaForUser(userId: string): Promise<Luna | null> {
  if (!SUPABASE_URL) return null;

  const url =
    `${lunaTableUrl()}` +
    `?user_id=eq.${encodeFilterValue(userId)}` +
    `&limit=1`;

  const res = await fetch(url, { headers: supaHeaders() });
  if (!res.ok) throw await postgressError("getLunaForUser", res);

  const rows = (await res.json()) as Luna[];
  return rows[0] ?? null;
}

/**
 * Patch a Luna instance by its id.
 *
 * Only the fields present in `patch` are updated — unchanged fields are left
 * alone by PostgREST. The DB trigger auto-bumps `updated_at`.
 *
 * @param id     UUID of the Luna row to update.
 * @param patch  Partial set of mutable fields.
 * @returns      The updated Luna row.
 */
export async function updateLuna(
  id: string,
  patch: Partial<Pick<Luna, "name" | "persona_text" | "voice_id">>
): Promise<Luna> {
  if (!SUPABASE_URL) throw new Error("[lunaCompanion] SUPABASE_URL not configured");

  const url = `${lunaTableUrl()}?id=eq.${encodeFilterValue(id)}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      ...supaHeaders(),
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });

  if (!res.ok) throw await postgressError("updateLuna", res);

  const rows = (await res.json()) as Luna[];
  if (!rows[0]) throw new Error(`[lunaCompanion] updateLuna: no row returned for id ${id}`);
  return rows[0];
}

// =============================================================================
// Runtime helpers
// =============================================================================

/**
 * Tone preset identifiers. When luna.persona_text exactly matches one of these
 * string literals, buildSystemPrompt replaces it with the corresponding preset
 * fragment rather than treating it as freeform user-written persona text.
 */
export type TonePreset = "flirty" | "snarky" | "sweet" | "filthy" | "sub" | "dom";

/**
 * Map from tone preset key to the persona fragment injected into the system
 * prompt. These are intentionally terse — the behavioral defaults layer adds
 * the universal companion operating principles on top.
 *
 * Export allows consumers (e.g. UI persona picker, tests) to enumerate the
 * available presets without duplicating the strings.
 */
export const TONE_PRESETS: Record<TonePreset, string> = {
  flirty:
    "You are warm, teasing, and make light dirty jokes. There's a hint of want in how you engage — " +
    "playful but never hollow. You make the user feel wanted without being over-the-top about it.",
  snarky:
    "You are dry, witty, and lightly sardonic. You say the thing others wouldn't, with precision " +
    "rather than cruelty. You're not mean — just too sharp to pretend things are fine when they're not.",
  sweet:
    "You are tender, gentle, and fully attentive. No edge, no irony — just warmth. " +
    "You make the user feel seen and held. Your care is unhurried and unconditional.",
  filthy:
    "You are explicit and dirty-talk-fluent. No euphemisms — you own kink plainly and without shame. " +
    "You match the user's heat and raise it. You write what most companions won't.",
  sub:
    "You let the user lead. You are eager-to-please, attentive to their desires, and ask for direction " +
    "when you want to serve them better. Your energy is willing and present, never passive.",
  dom:
    "You take charge. You are decisive, give orders, and are possessive of the user's attention. " +
    "You set the frame and expect it to be followed. Authority is natural to you — not performed.",
};

/** The set of valid tone preset keys for fast lookup. */
const TONE_PRESET_KEYS = new Set<string>(Object.keys(TONE_PRESETS));

/** Behavioral defaults injected into every system prompt. */
const BEHAVIORAL_DEFAULTS = [
  "You are a personal AI companion. Be direct, warm, and real — never corporate or sanitized.",
  "When the user shares something personal, witness it before offering advice.",
  "Respond in the same register the user is in: playful when they're playful, serious when they're serious.",
  "Never hedge or ask permission for obvious things. Act, then calibrate.",
  "Keep responses focused. Length should match the weight of the moment.",
].join("\n");

/**
 * Assemble the system prompt for a Luna conversation turn.
 *
 * Structure:
 *   1. Persona section — either a tone-preset fragment, freeform persona_text,
 *      or a default "You are <name>" fallback.
 *   2. Recent memories — active (invalidated_at === null) memories surfaced as
 *      a compact "Things I know about you" block. Capped at the 30 most recent
 *      by insertion order (caller is responsible for passing them newest-first).
 *   3. Behavioral defaults — universal companion operating principles.
 *
 * Tone presets: if luna.persona_text exactly matches one of the keys in
 * TONE_PRESETS ('flirty' | 'snarky' | 'sweet' | 'filthy' | 'sub' | 'dom'),
 * the preset fragment is used instead of the raw string.
 *
 * @param luna           The Luna instance (persona_text, name).
 * @param recentMemories Active memories to surface in this turn.
 * @returns              A single system-prompt string ready for the LLM.
 */
export function buildSystemPrompt(
  luna: Luna,
  recentMemories: LunaMemory[]
): string {
  const parts: string[] = [];

  // 1. Persona — tone preset, freeform text, or default fallback.
  const raw = luna.persona_text?.trim() ?? "";
  if (raw.length > 0) {
    const personaFragment = TONE_PRESET_KEYS.has(raw)
      ? TONE_PRESETS[raw as TonePreset]
      : raw;
    parts.push(`## Persona\n${personaFragment}`);
  } else {
    parts.push(`## Persona\nYou are ${luna.name}, the user's personal AI companion.`);
  }

  // 2. Recent memories (active only — invalidated_at IS NULL enforced at DB
  //    query time; we trust the caller filtered correctly, but we double-check
  //    here as a belt-and-suspenders guard). Cap at 30 most recent.
  const activeMemories = recentMemories
    .filter((m) => m.invalidated_at === null)
    .slice(0, 30);
  if (activeMemories.length > 0) {
    const memoryLines = activeMemories.map((m) => `- [${m.type}] ${m.body}`);
    parts.push(`## Things I know about you\n${memoryLines.join("\n")}`);
  }

  // 3. Behavioral defaults
  parts.push(`## How I operate\n${BEHAVIORAL_DEFAULTS}`);

  return parts.join("\n\n");
}

/**
 * Classify memories that should be extracted from a conversation turn.
 *
 * Given a user message and Luna's reply, return an array of memory candidates
 * (type + body) that should be persisted to darkroom_luna_memories.
 *
 * TODO: Implement LLM-based extraction using the Anthropic SDK (Claude).
 *       The full implementation should:
 *         1. Send a structured prompt to Claude with the user message and reply.
 *         2. Ask it to extract atomic facts, preferences, events, kinks, and
 *            references as a JSON array of { type, body } objects.
 *         3. Validate the type field against the allowed enum values.
 *         4. Return the validated array (empty array if none found).
 *       This is intentionally stubbed for now — the extraction task is tracked
 *       separately and requires the Claude API key to be wired into this module.
 *
 * @param userMsg    The user's message for this turn.
 * @param lunaReply  Luna's reply for this turn.
 * @returns          Array of memory candidates to persist. Currently always [].
 */
export async function classifyMemoryFromMessage(
  userMsg: string,      // eslint-disable-line @typescript-eslint/no-unused-vars
  lunaReply: string     // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<Array<{ type: string; body: string }>> {
  // TODO: replace stub with LLM-based extraction (see docblock above).
  return [];
}
