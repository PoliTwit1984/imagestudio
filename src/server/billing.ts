// =============================================================================
// src/server/billing.ts
//
// Tier configuration + per-user quota helpers for Darkroom billing.
//
//   * BILLING_TIERS    — canonical free / pro / team config (limits, prices,
//                        Stripe price-id slots; price ids are null until the
//                        operator wires Stripe up post-foundation).
//   * getTierLimits    — pure function: tier -> per-metric monthly caps.
//   * getUserTier      — async: read subscriptions table via PostgREST and
//                        fall back to 'free' when missing / errored / no DB.
//   * getCurrentUsage  — async: read usage_quota for the current month.
//   * incrementUsage   — async: upsert +delta into usage_quota with
//                        merge-duplicates. Silent no-op when DB unconfigured.
//   * checkQuota       — async: convenience composition for "can this user
//                        do action X right now?".
//
// Pairs with migrations/0052_create_subscriptions.sql and
// migrations/0053_create_usage_quota.sql. Stripe API integration is
// intentionally out of scope here — that's the next slice.
// =============================================================================

import { SUPABASE_URL } from "./config";
import { encodeFilterValue, supaHeaders } from "./supabase";

export type BillingTier = "free" | "pro" | "team";
export type BillingMetric =
  | "generations"
  | "edits"
  | "upscales"
  | "jobs"
  | "chains_runs"
  | "lut_extracts";

export interface TierLimits {
  generations_per_month: number;
  edits_per_month: number;
  upscales_per_month: number;
  jobs_per_month: number;
  chains_runs_per_month: number;
  lut_extracts_per_month: number;
}

export interface TierConfig {
  tier: BillingTier;
  display_name: string;
  description: string;
  price_cents_monthly: number;
  // Populated post-Stripe-setup. Operator runs `stripe prices create` for
  // each tier and pastes the resulting `price_xxx` id here (or wires it
  // through env). Null = Stripe not yet configured for this tier.
  stripe_price_id_monthly: string | null;
  limits: TierLimits;
}

export const BILLING_TIERS: Record<BillingTier, TierConfig> = {
  free: {
    tier: "free",
    display_name: "Free",
    description: "For trying Darkroom",
    price_cents_monthly: 0,
    stripe_price_id_monthly: null,
    limits: {
      generations_per_month: 50,
      edits_per_month: 100,
      upscales_per_month: 5,
      jobs_per_month: 10,
      chains_runs_per_month: 5,
      lut_extracts_per_month: 3,
    },
  },
  pro: {
    tier: "pro",
    display_name: "Pro",
    description: "For working photographers and creators",
    price_cents_monthly: 2900,
    // operator fills in after creating Stripe price
    stripe_price_id_monthly: null,
    limits: {
      generations_per_month: 1000,
      edits_per_month: 2000,
      upscales_per_month: 200,
      jobs_per_month: 500,
      chains_runs_per_month: 200,
      lut_extracts_per_month: 100,
    },
  },
  team: {
    tier: "team",
    display_name: "Team",
    description: "For studios and teams",
    price_cents_monthly: 9900,
    stripe_price_id_monthly: null,
    limits: {
      generations_per_month: 10000,
      edits_per_month: 20000,
      upscales_per_month: 2000,
      jobs_per_month: 5000,
      chains_runs_per_month: 2000,
      lut_extracts_per_month: 1000,
    },
  },
};

export function getTierLimits(tier: BillingTier): TierLimits {
  return BILLING_TIERS[tier]?.limits || BILLING_TIERS.free.limits;
}

// =============================================================================
// Enhancor engine → quota metric mapping
//
// Each entry declares which BillingMetric counter is charged when that engine
// is invoked, and how many units (which may be fractional) to deduct per call.
// Keep this const adjacent to BILLING_TIERS so limits and costs stay in sync.
// =============================================================================

export type EnhancorEngineId =
  | "skin-pro"
  | "lens-pro"
  | "lens-cinema"
  | "lens-reality"
  | "develop"
  | "sharpen-portrait"
  | "sharpen";

export interface EngineCost {
  metric: "edits" | "generations" | "upscales";
  units: number;
}

export const ENHANCOR_QUOTA_MAP: Record<EnhancorEngineId, EngineCost> = {
  "skin-pro":        { metric: "edits",       units: 1   },
  "lens-pro":        { metric: "generations", units: 1   },
  "lens-cinema":     { metric: "generations", units: 1   },
  "lens-reality":    { metric: "generations", units: 1   },
  "develop":         { metric: "upscales",    units: 1   },
  "sharpen-portrait":{ metric: "upscales",    units: 1   },
  "sharpen":         { metric: "upscales",    units: 0.5 },
};

/**
 * Returns the billing metric and unit cost for a given Enhancor engine.
 *
 * @param engineId  - one of the 7 recognised Enhancor engine ids
 * @param _params   - reserved for future per-call overrides (e.g. resolution
 *                    multipliers); unused in v1
 * @throws          if engineId is not in ENHANCOR_QUOTA_MAP
 */
export function getEngineCost(
  engineId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _params?: Record<string, unknown>
): EngineCost {
  const entry = ENHANCOR_QUOTA_MAP[engineId as EnhancorEngineId];
  if (!entry) {
    throw new Error(`[billing] Unknown Enhancor engine: "${engineId}"`);
  }
  return entry;
}

// Default tier when user not logged in / not in subscriptions table.
const DEFAULT_TIER: BillingTier = "free";

export async function getUserTier(
  userId: string | null | undefined
): Promise<BillingTier> {
  if (!userId || !SUPABASE_URL) return DEFAULT_TIER;
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/subscriptions` +
      `?user_id=eq.${encodeFilterValue(userId)}` +
      `&status=in.(trialing,active)` +
      `&select=tier&limit=1`;
    const r = await fetch(url, { headers: supaHeaders() });
    if (!r.ok) return DEFAULT_TIER;
    const rows = (await r.json()) as Array<{ tier?: string }>;
    const tier = rows[0]?.tier as BillingTier | undefined;
    if (tier && tier in BILLING_TIERS) return tier;
    return DEFAULT_TIER;
  } catch {
    return DEFAULT_TIER;
  }
}

// Period bounds: month-aligned (calendar month containing now). UTC so the
// boundary is stable regardless of the request origin's timezone.
function currentPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function getCurrentUsage(
  userId: string | null | undefined,
  metric: BillingMetric
): Promise<number> {
  if (!userId || !SUPABASE_URL) return 0;
  try {
    const { start } = currentPeriod();
    const url =
      `${SUPABASE_URL}/rest/v1/usage_quota` +
      `?user_id=eq.${encodeFilterValue(userId)}` +
      `&metric=eq.${metric}` +
      `&period_start=eq.${encodeURIComponent(start)}` +
      `&select=count&limit=1`;
    const r = await fetch(url, { headers: supaHeaders() });
    if (!r.ok) return 0;
    const rows = (await r.json()) as Array<{ count?: number }>;
    return rows[0]?.count || 0;
  } catch {
    return 0;
  }
}

export async function incrementUsage(
  userId: string | null | undefined,
  metric: BillingMetric,
  delta: number = 1
): Promise<void> {
  // Silently no-op when no user / no db — keeps quota-aware call sites
  // working in dev / branch envs without a Supabase project wired up.
  if (!userId || !SUPABASE_URL) return;
  try {
    const { start, end } = currentPeriod();
    // Upsert via PostgREST: use Prefer: resolution=merge-duplicates with
    // the unique constraint defined in 0053 (user_id, metric, period_start).
    const url =
      `${SUPABASE_URL}/rest/v1/usage_quota` +
      `?on_conflict=user_id,metric,period_start`;
    const body = {
      user_id: userId,
      metric,
      period_start: start,
      period_end: end,
      count: delta,
    };
    await fetch(url, {
      method: "POST",
      headers: {
        ...supaHeaders(),
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(body),
    });
    // Note: Postgres-side trigger or RPC needed for atomic +delta. For v1,
    // the upsert with merge-duplicates leaves us at risk of last-write-wins
    // on concurrent calls. Acceptable until users actually share infra;
    // revisit when chains.parent ships.
  } catch (e) {
    console.warn("[billing] incrementUsage failed:", e);
  }
}

export interface QuotaCheck {
  ok: boolean;
  metric: BillingMetric;
  used: number;
  limit: number;
  tier: BillingTier;
  remaining: number;
}

export async function checkQuota(
  userId: string | null | undefined,
  metric: BillingMetric
): Promise<QuotaCheck> {
  const tier = await getUserTier(userId);
  const limits = getTierLimits(tier);
  const limitKey = `${metric}_per_month` as keyof TierLimits;
  const limit = limits[limitKey] ?? Infinity;
  const used = await getCurrentUsage(userId, metric);
  return {
    ok: used < limit,
    metric,
    used,
    limit,
    tier,
    remaining: Math.max(0, limit - used),
  };
}
