// =============================================================================
// src/server/routing.ts
//
// Central routing registry for Darkroom processing engines.
//
// Purpose: Declare every available processing engine with its capabilities,
//          cost model, and recommended use-cases so the API layer can do
//          intent-based routing without hard-coding engine selection.
//          Also exports pickEngine() for intent-based engine selection and
//          retryWithFallback() for failure recovery with legacy engine fallback.
//
// Inputs:  (none for static data; pickEngine/retryWithFallback take strings)
// Outputs: Engine type definition + ENHANCOR_ENGINES const (7 entries)
//          pickEngine — best-matching Engine or null
//          retryWithFallback — fallback engine id string or null; logs failure
// Side effects: retryWithFallback makes an async POST to the engine_failures
//               table via PostgREST (fire-and-forget, silent on error).
// Failure behavior: pickEngine/retryWithFallback return null on no match.
//                   retryWithFallback log POST failures are swallowed.
//
// Cost note: cost_credits values are estimated from observed Enhancor API
// responses (cost field returned on COMPLETED status). Enhancor does not
// publish a public price schedule; these figures reflect empirical sampling
// as of Q1 2026. Treat as approximate — the actual deduction is authoritative.
// =============================================================================

import type { EnhancorModelSlug } from "./enhancor";
import { SUPABASE_URL } from "./config";
import { encodeFilterValue, supaHeaders } from "./supabase";

// ---------------------------------------------------------------------------
// Quality tiers — coarse resolution bands to aid routing decisions.
// The vendor may upscale internally; these represent the *output* resolution
// class the engine is designed to deliver, not the input requirement.
// ---------------------------------------------------------------------------

export type QualityTier = "SD" | "HD" | "2K" | "4K";

// ---------------------------------------------------------------------------
// Input / output shape identifiers.
// These are string literals rather than a union enum so new vendors can extend
// the set without changing shared types.
// ---------------------------------------------------------------------------

export type InputShape =
  | "image"
  | "image+area_locks"
  | "image+mode"
  | "prompt"
  | "prompt+optional_image";

export type OutputShape = "image";

// ---------------------------------------------------------------------------
// Engine — one entry per processing engine in the routing registry.
// ---------------------------------------------------------------------------

export interface Engine {
  /** Unique stable identifier for this engine entry (kebab-case). */
  id: string;
  /** Vendor namespace — used for routing and billing attribution. */
  vendor: string;
  /** Human-readable display name shown in the UI. */
  house_name: string;
  /**
   * API slug forwarded to the vendor endpoint.
   * For Enhancor this maps to `EnhancorModelSlug` but is typed as string so
   * other vendors can register without importing Enhancor types.
   */
  slug: string;
  /** Shape of the primary input(s) this engine requires. */
  input_shape: InputShape;
  /** Shape of what the engine produces. */
  output_shape: OutputShape;
  /**
   * Estimated credit cost per call.
   * See module-level note — these are empirical estimates, not guaranteed rates.
   */
  cost_credits: number;
  /** Coarse output resolution class. */
  quality_tier: QualityTier;
  /**
   * Intent tags — callers can match on these to find suitable engines.
   * Tags are lowercase kebab-case strings; no canonical list is enforced here.
   */
  recommended_for: string[];
}

// ---------------------------------------------------------------------------
// Enhancor vendor block — 7 engines.
// Slugs cross-reference EnhancorModelSlug values in src/server/enhancor.ts.
// ---------------------------------------------------------------------------

// Cost assumption: Enhancor charges 480 credits for most enhancement and
// generation endpoints; the image-upscaler (sharpen) endpoint was observed
// at 240 credits (lighter compute path, no generation model).
// All values verified against live API responses; resample if pricing changes.

export const ENHANCOR_ENGINES: Engine[] = [
  {
    id: "skin-pro",
    vendor: "enhancor",
    house_name: "Skin Pro",
    slug: "realistic-skin" satisfies EnhancorModelSlug,
    input_shape: "image+area_locks",
    output_shape: "image",
    cost_credits: 480,
    quality_tier: "HD",
    recommended_for: ["portrait-skin", "face-realism", "preserve-features"],
  },
  {
    id: "lens-pro",
    vendor: "enhancor",
    house_name: "Lens Pro",
    slug: "kora" satisfies EnhancorModelSlug,
    input_shape: "prompt+optional_image",
    output_shape: "image",
    cost_credits: 480,
    quality_tier: "HD",
    recommended_for: ["txt2img", "img2img", "general-generation"],
  },
  {
    id: "lens-cinema",
    vendor: "enhancor",
    house_name: "Lens Cinema",
    slug: "kora" satisfies EnhancorModelSlug,
    input_shape: "prompt+optional_image",
    output_shape: "image",
    cost_credits: 480,
    quality_tier: "2K",
    recommended_for: ["cinematic", "movie-look", "dramatic"],
  },
  {
    id: "lens-reality",
    vendor: "enhancor",
    house_name: "Lens Reality",
    slug: "kora-reality" satisfies EnhancorModelSlug,
    input_shape: "prompt",
    output_shape: "image",
    cost_credits: 480,
    quality_tier: "HD",
    recommended_for: ["photo-realism", "unfiltered-realism"],
  },
  {
    id: "develop",
    vendor: "enhancor",
    house_name: "Develop",
    slug: "detailed" satisfies EnhancorModelSlug,
    input_shape: "image",
    output_shape: "image",
    cost_credits: 480,
    quality_tier: "4K",
    recommended_for: ["one-call-finish", "upscale-and-enhance"],
  },
  {
    id: "sharpen-portrait",
    vendor: "enhancor",
    house_name: "Sharpen Portrait",
    slug: "upscaler" satisfies EnhancorModelSlug,
    input_shape: "image+mode",
    output_shape: "image",
    cost_credits: 480,
    quality_tier: "4K",
    recommended_for: ["portrait-upscale", "face-detail"],
  },
  {
    id: "sharpen",
    vendor: "enhancor",
    house_name: "Sharpen",
    slug: "image-upscaler" satisfies EnhancorModelSlug,
    input_shape: "image",
    output_shape: "image",
    cost_credits: 240,
    quality_tier: "4K",
    recommended_for: ["general-upscale", "cheap-fallback"],
  },
];

// ---------------------------------------------------------------------------
// pickEngine — intent-based engine selection
//
// Maps a free-text intent string (and optional inputShape hint) to the best
// matching Engine from ENHANCOR_ENGINES using tag matching rules.
//
// Matching rules (evaluated in priority order — first match wins):
//   "skin realism" / "portrait" / "make this skin look real" → skin-pro
//   "cinematic" / "movie look" / "dramatic"                  → lens-cinema
//   "realistic" / "photorealism"                             → lens-reality
//   "upscale" + portrait inputShape                          → sharpen-portrait
//   "upscale" (general)                                      → sharpen
//   "finish" / "make it pop" / "cinematic finish"            → develop
//   "generate" (no other modifier)                           → lens-pro
//
// Returns null if no rule matches.
// ---------------------------------------------------------------------------

export function pickEngine(intent: string, inputShape?: string): Engine | null {
  const i = intent.toLowerCase();
  const shape = (inputShape ?? "").toLowerCase();

  // Skin / portrait realism — highest specificity first
  if (
    i.includes("skin realism") ||
    i.includes("make this skin look real") ||
    i.includes("portrait")
  ) {
    return ENHANCOR_ENGINES.find((e) => e.id === "skin-pro") ?? null;
  }

  // Cinematic / movie look / dramatic
  if (i.includes("movie look") || i.includes("cinematic") || i.includes("dramatic")) {
    // "cinematic finish" belongs to develop — check that it's not a finish intent
    if (!i.includes("finish") && !i.includes("make it pop")) {
      return ENHANCOR_ENGINES.find((e) => e.id === "lens-cinema") ?? null;
    }
  }

  // Photorealism / realistic
  if (i.includes("photorealism") || i.includes("realistic")) {
    return ENHANCOR_ENGINES.find((e) => e.id === "lens-reality") ?? null;
  }

  // Upscale — check portrait hint first
  if (i.includes("upscale")) {
    if (shape.includes("portrait") || i.includes("portrait")) {
      return ENHANCOR_ENGINES.find((e) => e.id === "sharpen-portrait") ?? null;
    }
    return ENHANCOR_ENGINES.find((e) => e.id === "sharpen") ?? null;
  }

  // Finish / make it pop / cinematic finish
  if (i.includes("finish") || i.includes("make it pop")) {
    return ENHANCOR_ENGINES.find((e) => e.id === "develop") ?? null;
  }

  // Generate (no other modifier — must be checked after more specific rules above)
  if (i.includes("generate")) {
    return ENHANCOR_ENGINES.find((e) => e.id === "lens-pro") ?? null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// retryWithFallback — failure recovery routing
//
// When an Enhancor engine returns FAILED, returns the id of the appropriate
// legacy fallback engine and logs the failure to the engine_failures table.
//
// Fallback table:
//   skin-pro                        → "topaz_skin"
//   lens-pro / lens-cinema / lens-reality → "grok_image"
//   develop / sharpen-portrait / sharpen  → "topaz_upscale"
//
// Returns null if originalEngineId is unrecognised.
//
// NOTE: The engine_failures table is expected to be created by a separate
// database migration (not in scope for this file). The PostgREST INSERT will
// silently fail until that migration is applied — this is intentional so the
// fallback path remains available in dev / branch envs without a DB.
// ---------------------------------------------------------------------------

const FALLBACK_MAP: Record<string, string> = {
  "skin-pro": "topaz_skin",
  "lens-pro": "grok_image",
  "lens-cinema": "grok_image",
  "lens-reality": "grok_image",
  "develop": "topaz_upscale",
  "sharpen-portrait": "topaz_upscale",
  "sharpen": "topaz_upscale",
};

export async function retryWithFallback(
  originalEngineId: string,
  intent: string,
  inputShape?: string
): Promise<string | null> {
  const fallbackEngine = FALLBACK_MAP[originalEngineId] ?? null;

  // Fire-and-forget: log the failure to engine_failures via PostgREST.
  // Swallow all errors — a logging failure must never block the fallback path.
  if (SUPABASE_URL) {
    const logUrl = `${SUPABASE_URL}/rest/v1/engine_failures`;
    const body = {
      original_engine: originalEngineId,
      fallback_engine: fallbackEngine,
      reason: `engine FAILED — intent: "${intent}"${inputShape ? `, inputShape: "${inputShape}"` : ""}`,
      created_at: new Date().toISOString(),
    };
    fetch(logUrl, {
      method: "POST",
      headers: {
        ...supaHeaders(),
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(body),
    }).catch(() => {
      // Intentionally swallowed — logging is best-effort.
    });
  }

  return fallbackEngine;
}
