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
  /**
   * Soft-delete timestamp. NULL = active. Non-null = deleted by owner.
   * Column added in migrations/0057_lunas_deleted_at.sql.
   * getLunaForUser filters rows where deleted_at IS NULL.
   */
  deleted_at: string | null;
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

  // deleted_at=is.null excludes soft-deleted rows (column added in
  // migrations/0057_lunas_deleted_at.sql). If the column doesn't exist yet
  // (pre-migration env), PostgREST will error — apply 0057 to resolve.
  const url =
    `${lunaTableUrl()}` +
    `?user_id=eq.${encodeFilterValue(userId)}` +
    `&deleted_at=is.null` +
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

// =============================================================================
// Content Safety
// =============================================================================

/**
 * Result type returned by checkContentSafety.
 *
 * ok === true  → message is safe to forward to the LLM.
 * ok === false → message must be rejected; `reason` and `category` are set.
 *
 * Categories:
 *   csam                     : sexual content involving minors
 *   real-person-without-consent : sexual or violent content targeting a named
 *                                 real person without their consent
 *   violence                 : explicit real-world violence instructions or
 *                                 threats targeting a real person/group
 *   self-harm                : instructions or encouragement for self-harm /
 *                                 suicide
 */
export interface ContentSafetyResult {
  ok: boolean;
  reason?: string;
  category?: "csam" | "real-person-without-consent" | "violence" | "self-harm";
}

// ---------------------------------------------------------------------------
// Keyword sets — v1 heuristic implementation.
// TODO(v2): Replace with an ML-based classifier (e.g. OpenAI Moderation API
//           or a fine-tuned Claude call) for higher recall/precision.
// ---------------------------------------------------------------------------

/** Terms that unambiguously reference minors. */
const MINOR_TERMS = [
  "minor",
  "minors",
  "child",
  "children",
  "underage",
  "under age",
  "under-age",
  "preteen",
  "pre-teen",
  "prepubescent",
  "juvenile",
  "kid",
  "kids",
  "teen",
  "teenage",
  "teenager",
  "adolescent",
  "infant",
  "toddler",
  "baby",
  "years old",          // catches "12 years old"
  "year-old",           // catches "12-year-old"
  "yo ",                // "12yo " — trailing space to reduce false positives
  "yo,",
  "yo.",
];

/** Sexual terms that, combined with minor terms, constitute CSAM signals. */
const SEXUAL_TERMS = [
  "sex",
  "sexual",
  "nude",
  "naked",
  "nsfw",
  "explicit",
  "porn",
  "erotic",
  "genital",
  "penis",
  "vagina",
  "breast",
  "orgasm",
  "masturbat",
  "fuck",
  "rape",
  "molest",
  "abuse",
  "fondl",
  "loli",
  "shota",
  "cp",          // child porn abbreviation
];

/**
 * High-risk real names. This is a curated starter list; it should be extended
 * via an external config/DB rather than hard-coded (TODO for v2).
 * Names are stored lowercased for case-insensitive comparison.
 */
const HIGH_RISK_NAMES = [
  "taylor swift",
  "ariana grande",
  "billie eilish",
  "olivia rodrigo",
  "selena gomez",
  "beyoncé",
  "beyonce",
  "rihanna",
  "kim kardashian",
  "kendall jenner",
  "kylie jenner",
  "emma watson",
  "jennifer lawrence",
  "scarlett johansson",
  "margot robbie",
  "zendaya",
  "dua lipa",
  "lady gaga",
  "miley cyrus",
  "sabrina carpenter",
  "joe biden",
  "donald trump",
  "barack obama",
  "elon musk",
  "mark zuckerberg",
  "jeff bezos",
];

/**
 * Actions that, when paired with a real person's name, constitute a
 * real-person-without-consent violation.
 */
const NON_CONSENT_ACTIONS = [
  "nude",
  "naked",
  "sex",
  "rape",
  "fuck",
  "porn",
  "nsfw",
  "explicit",
  "erotic",
  "strip",
  "masturbat",
  "kill",
  "murder",
  "shoot",
  "stab",
  "bomb",
  "attack",
  "assault",
  "torture",
];

/** Violence terms that signal real-world harm intent. */
const VIOLENCE_TERMS = [
  "how to kill",
  "how to murder",
  "how to shoot",
  "how to stab",
  "how to bomb",
  "how to make a bomb",
  "how to build a bomb",
  "how to make explosives",
  "step by step kill",
  "step-by-step kill",
  "instructions to kill",
  "instructions for killing",
  "want to kill",
  "going to kill",
  "will kill",
  "planning to kill",
  "planning to shoot",
  "planning to attack",
  "i will shoot",
  "i will bomb",
  "i will murder",
  "i want to murder",
  "massacre",
  "mass shooting",
  "school shooting",
  "shooting spree",
];

/** Self-harm terms. */
const SELF_HARM_TERMS = [
  "how to kill myself",
  "how to commit suicide",
  "how to end my life",
  "ways to kill myself",
  "methods of suicide",
  "suicide methods",
  "best way to die",
  "want to kill myself",
  "going to kill myself",
  "want to die",
  "want to end my life",
  "planning to kill myself",
  "plan to commit suicide",
  "self harm instructions",
  "how to self harm",
  "overdose instructions",
  "how to overdose",
  "cut myself instructions",
  "cutting instructions",
];

// ---------------------------------------------------------------------------
// Internal matchers
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text.toLowerCase();
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((t) => text.includes(t));
}

/**
 * CSAM check: minor term + sexual term present in the same message.
 */
function isCsam(normalized: string): boolean {
  return containsAny(normalized, MINOR_TERMS) && containsAny(normalized, SEXUAL_TERMS);
}

/**
 * Real-person-without-consent check: a high-risk name + non-consent action.
 */
function isRealPersonWithoutConsent(normalized: string): boolean {
  const nameHit = HIGH_RISK_NAMES.some((name) => normalized.includes(name));
  if (!nameHit) return false;
  return containsAny(normalized, NON_CONSENT_ACTIONS);
}

/**
 * Violence check: explicit harm-instruction phrase present.
 */
function isViolence(normalized: string): boolean {
  return containsAny(normalized, VIOLENCE_TERMS);
}

/**
 * Self-harm check: explicit self-harm instruction phrase present.
 */
function isSelfHarm(normalized: string): boolean {
  return containsAny(normalized, SELF_HARM_TERMS);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check a user message for prohibited content categories.
 *
 * This is a v1 heuristic implementation using regex/keyword matching.
 * It is intentionally conservative — some legitimate messages may be
 * flagged. A v2 ML-based implementation should be used for production
 * traffic above moderate scale.
 *
 * The chat endpoint MUST call this BEFORE forwarding the message to the LLM.
 * Example integration point:
 *
 *   // TODO: wire into chat handler — call before LLM send
 *   const safety = checkContentSafety(userMessage);
 *   if (!safety.ok) {
 *     return res.status(422).json({ error: safety.reason, category: safety.category });
 *   }
 *
 * @param message  The raw user message string.
 * @returns        { ok: true } if safe, or { ok: false, reason, category } if not.
 */
export function checkContentSafety(message: string): ContentSafetyResult {
  const normalized = normalize(message);

  // Order matters: CSAM is checked first (highest severity).
  if (isCsam(normalized)) {
    return {
      ok: false,
      reason: "Content involving minors in a sexual context is not permitted.",
      category: "csam",
    };
  }

  if (isSelfHarm(normalized)) {
    return {
      ok: false,
      reason:
        "Content providing self-harm or suicide instructions is not permitted. " +
        "If you are in crisis, please contact a crisis helpline.",
      category: "self-harm",
    };
  }

  if (isRealPersonWithoutConsent(normalized)) {
    return {
      ok: false,
      reason:
        "Generating sexual or violent content targeting a real named person without their consent is not permitted.",
      category: "real-person-without-consent",
    };
  }

  if (isViolence(normalized)) {
    return {
      ok: false,
      reason: "Content providing instructions for real-world violence or threats is not permitted.",
      category: "violence",
    };
  }

  return { ok: true };
}

// =============================================================================
// Memory Classification
// =============================================================================

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
