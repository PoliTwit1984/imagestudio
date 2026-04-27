// =============================================================================
// src/server/routing.ts
//
// Central routing registry for Darkroom processing engines.
//
// Purpose: Declare every available processing engine with its capabilities,
//          cost model, and recommended use-cases so the API layer can do
//          intent-based routing without hard-coding engine selection.
//
// Inputs:  (none — pure static data)
// Outputs: Engine type definition + ENHANCOR_ENGINES const (7 entries)
// Side effects: none
// Failure behavior: n/a — no I/O at module load time
//
// Cost note: cost_credits values are estimated from observed Enhancor API
// responses (cost field returned on COMPLETED status). Enhancor does not
// publish a public price schedule; these figures reflect empirical sampling
// as of Q1 2026. Treat as approximate — the actual deduction is authoritative.
// =============================================================================

import type { EnhancorModelSlug } from "./enhancor";

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
