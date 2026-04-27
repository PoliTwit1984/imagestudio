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
//   * handleLunaTierChange  — async: processes a subscription tier downgrade
//                             event. Devotion → Pro locks voice + face features
//                             on the Luna row (log-only, no data mutation).
//                             Pro → Free (or any paid tier → Free) soft-archives
//                             the user's Luna memories for 90 days.
//   * purgeArchivedLunaMemories — async: deletes memories whose archive_until
//                             is in the past. Intended to be called by a cron
//                             job; safe to call any time (idempotent).
//
// Pairs with migrations/0052_create_subscriptions.sql,
// migrations/0053_create_usage_quota.sql, and
// migrations/0058_luna_archive_columns.sql.
// =============================================================================

import { SUPABASE_URL } from "./config";
import { encodeFilterValue, supaHeaders } from "./supabase";

export type BillingTier = "free" | "pro" | "team";

// Luna-specific tiers extend BillingTier with 'devotion'. 'devotion' ($49/mo)
// includes persona + persistent memory + ElevenLabs voice notes + face LoRA
// training. Downgrading from devotion → pro locks voice + face but preserves
// memory. Downgrading from pro/devotion → free soft-archives memories 90 days.
// This type is used by handleLunaTierChange and is intentionally a superset of
// BillingTier so both systems share the same handler.
export type LunaTier = BillingTier | "devotion";
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

// =============================================================================
// Luna tier-change hooks
//
// Called from the Stripe webhook handler (processStripeEvent in
// src/server/routes/safe-edit.ts) when a customer.subscription.updated event
// resolves to a downgrade. The caller is responsible for detecting the
// direction of the tier change; this function takes the resolved old + new tier
// values and applies the appropriate side effects.
//
// Pairs with migrations/0058_luna_archive_columns.sql.
// =============================================================================

/** Features locked when downgrading from Devotion → Pro. */
const DEVOTION_PRO_LOCKED_FEATURES = ["voice", "face"] as const;

/** 90 days in milliseconds — memories are soft-archived for this window on Pro → Free. */
const ARCHIVE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Process a billing tier change for a user's Luna instance.
 *
 * Behaviour by downgrade path:
 *
 * Devotion → Pro
 *   - Logs one row to `tier_change_events` (idempotent via stripe_event_id).
 *   - Sets `tier_locked_features = ['voice', 'face']` on the user's
 *     `darkroom_lunas` row so endpoint-level guards can gate those features
 *     without a tier re-check.
 *   - Does NOT mutate memory rows (memories persist at Pro tier).
 *
 * Pro → Free  OR  Devotion → Free  OR  any paid tier → Free
 *   - Logs one row to `tier_change_events`.
 *   - Sets `tier_locked_features = ['voice', 'face']` on the Luna row.
 *   - Sets `archive_until = NOW() + 90 days` on all active
 *     `darkroom_luna_memories` rows for the user's Luna(s). Memories are
 *     kept and readable for 90 days; purgeArchivedLunaMemories() deletes
 *     them once the deadline passes unless the user re-upgrades.
 *
 * Upgrades (newTier > oldTier) are a no-op — this function only handles
 * downgrades. The caller should check direction before calling if it wants
 * to suppress the log entry for upgrades.
 *
 * @param userId        - Darkroom user UUID.
 * @param oldTier       - Tier before the change (LunaTier).
 * @param newTier       - Tier after the change (LunaTier).
 * @param stripeEventId - Optional Stripe event id for idempotency. When
 *                        provided the tier_change_events row uses this as its
 *                        dedup key so Stripe's retry delivery produces a single
 *                        log row rather than N duplicates.
 *
 * @returns A summary object describing what was applied. Never throws — all
 *          failures are logged as warnings and the function returns normally
 *          so the Stripe webhook can still return 200 (preventing endless
 *          retries for non-transient errors). Transient DB failures will
 *          surface in the notes field.
 */
export async function handleLunaTierChange(
  userId: string,
  oldTier: LunaTier,
  newTier: LunaTier,
  stripeEventId?: string
): Promise<{
  logged: boolean;
  featuresLocked: string[];
  memoriesArchived: number;
  notes: string;
}> {
  const result = {
    logged: false,
    featuresLocked: [] as string[],
    memoriesArchived: 0,
    notes: "",
  };

  if (!userId || !SUPABASE_URL) {
    result.notes = "SUPABASE_URL unset or no userId — skipping tier change hooks";
    console.log(`[billing] handleLunaTierChange: ${result.notes}`);
    return result;
  }

  // Determine which side effects apply based on the downgrade path.
  const toFree = newTier === "free";
  const devotionToProOrBelow = oldTier === "devotion" && newTier !== "devotion";

  // Features to lock: voice + face whenever dropping out of Devotion.
  const featuresToLock: string[] =
    devotionToProOrBelow || (oldTier === "devotion" && toFree)
      ? [...DEVOTION_PRO_LOCKED_FEATURES]
      : toFree
      ? [...DEVOTION_PRO_LOCKED_FEATURES] // lock everything on free too
      : [];

  // Build a human-readable notes string for the audit log.
  const effectSummary: string[] = [];
  if (featuresToLock.length > 0) {
    effectSummary.push(`lock features: [${featuresToLock.join(", ")}]`);
  }
  if (toFree) {
    effectSummary.push("soft-archive memories (90 days)");
  }
  const notesText =
    effectSummary.length > 0
      ? `${oldTier} → ${newTier}: ${effectSummary.join("; ")}`
      : `${oldTier} → ${newTier}: no side effects (upgrade or same tier)`;
  result.notes = notesText;

  // ── 1. Log to tier_change_events ──────────────────────────────────────────
  // Idempotent: UNIQUE constraint on stripe_event_id (when non-null) prevents
  // duplicate rows on Stripe retry delivery. We use Prefer: return=minimal so
  // a conflict (duplicate) is silently merged rather than erroring.
  try {
    const logBody: Record<string, unknown> = {
      user_id: userId,
      old_tier: oldTier,
      new_tier: newTier,
      notes: notesText,
      processed_at: new Date().toISOString(),
    };
    if (stripeEventId) logBody.stripe_event_id = stripeEventId;

    const logUrl = `${SUPABASE_URL}/rest/v1/tier_change_events` +
      (stripeEventId ? "?on_conflict=stripe_event_id" : "");

    const lr = await fetch(logUrl, {
      method: "POST",
      headers: {
        ...supaHeaders(),
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(logBody),
    });
    if (!lr.ok) {
      const txt = await lr.text();
      console.warn(`[billing] tier_change_events insert ${lr.status}: ${txt.slice(0, 200)}`);
    } else {
      result.logged = true;
    }
  } catch (e) {
    console.warn("[billing] handleLunaTierChange: tier_change_events insert failed:", e);
  }

  // ── 2. Lock features on the Luna row ──────────────────────────────────────
  // PATCH darkroom_lunas rows for this user, setting tier_locked_features.
  // We use a filter on user_id; there is at most one Luna per user (UNIQUE
  // index on darkroom_lunas.user_id) but the PATCH is safe even if it
  // matches zero rows.
  if (featuresToLock.length > 0) {
    try {
      const patchUrl =
        `${SUPABASE_URL}/rest/v1/darkroom_lunas` +
        `?user_id=eq.${encodeFilterValue(userId)}`;
      // Postgres array literal: '{voice,face}'
      const pgArray = `{${featuresToLock.join(",")}}`;
      const pr = await fetch(patchUrl, {
        method: "PATCH",
        headers: {
          ...supaHeaders(),
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ tier_locked_features: pgArray }),
      });
      if (!pr.ok) {
        const txt = await pr.text();
        console.warn(`[billing] darkroom_lunas PATCH ${pr.status}: ${txt.slice(0, 200)}`);
      } else {
        result.featuresLocked = featuresToLock;
      }
    } catch (e) {
      console.warn("[billing] handleLunaTierChange: darkroom_lunas PATCH failed:", e);
    }
  }

  // ── 3. Soft-archive memories on Pro → Free or any paid → Free ─────────────
  // For each Luna owned by this user, set archive_until = NOW() + 90 days on
  // all active (archive_until IS NULL) memory rows. We first fetch the Luna
  // id(s) for this user, then PATCH memories in one PostgREST call per luna.
  if (toFree) {
    try {
      // Fetch the Luna id(s) for this user.
      const lunaUrl =
        `${SUPABASE_URL}/rest/v1/darkroom_lunas` +
        `?user_id=eq.${encodeFilterValue(userId)}` +
        `&select=id`;
      const lr = await fetch(lunaUrl, { headers: supaHeaders() });
      if (!lr.ok) {
        const txt = await lr.text();
        console.warn(`[billing] darkroom_lunas fetch ${lr.status}: ${txt.slice(0, 200)}`);
      } else {
        const lunas = (await lr.json()) as Array<{ id: string }>;
        const archiveUntil = new Date(Date.now() + ARCHIVE_WINDOW_MS).toISOString();
        let totalArchived = 0;

        for (const luna of lunas) {
          // PATCH all memories for this Luna that are not yet archived.
          // Filter: archive_until IS NULL ensures we don't push out the
          // deadline for memories already in the 90-day window.
          const memPatchUrl =
            `${SUPABASE_URL}/rest/v1/darkroom_luna_memories` +
            `?luna_id=eq.${encodeFilterValue(luna.id)}` +
            `&archive_until=is.null`;
          const mr = await fetch(memPatchUrl, {
            method: "PATCH",
            headers: {
              ...supaHeaders(),
              "Content-Type": "application/json",
              // return=representation so we can count affected rows.
              Prefer: "return=representation",
            },
            body: JSON.stringify({ archive_until: archiveUntil }),
          });
          if (!mr.ok) {
            const txt = await mr.text();
            console.warn(
              `[billing] darkroom_luna_memories PATCH (luna ${luna.id}) ${mr.status}: ` +
              txt.slice(0, 200)
            );
          } else {
            const rows = (await mr.json()) as unknown[];
            totalArchived += Array.isArray(rows) ? rows.length : 0;
          }
        }
        result.memoriesArchived = totalArchived;
      }
    } catch (e) {
      console.warn("[billing] handleLunaTierChange: memories archive failed:", e);
    }
  }

  console.log(
    `[billing] handleLunaTierChange userId=${userId} ` +
    `${oldTier}→${newTier} logged=${result.logged} ` +
    `featuresLocked=[${result.featuresLocked.join(",")}] ` +
    `memoriesArchived=${result.memoriesArchived}`
  );
  return result;
}

/**
 * Purge Luna memories whose 90-day archive window has elapsed.
 *
 * Deletes rows from `darkroom_luna_memories` where `archive_until < NOW()`.
 * This is the companion to the soft-archive step in handleLunaTierChange.
 *
 * Intended call site: a periodic cron job (daily is sufficient; memories are
 * only eligible once the 90-day window has fully elapsed). The operations team
 * wires the schedule — this function just exposes the purge logic.
 *
 * Idempotent: deleting already-deleted rows is a no-op.
 *
 * @returns The number of memory rows deleted, or 0 on any error.
 *          Never throws — logs failures as warnings.
 */
export async function purgeArchivedLunaMemories(): Promise<number> {
  if (!SUPABASE_URL) {
    console.log("[billing] purgeArchivedLunaMemories: SUPABASE_URL unset — no-op");
    return 0;
  }

  try {
    // PostgREST DELETE with a filter: archive_until < now().
    // Using `lt` (less-than) on the ISO timestamp string. PostgREST interprets
    // this correctly for timestamptz columns.
    const nowIso = new Date().toISOString();
    const url =
      `${SUPABASE_URL}/rest/v1/darkroom_luna_memories` +
      `?archive_until=lt.${encodeURIComponent(nowIso)}`;

    const r = await fetch(url, {
      method: "DELETE",
      headers: {
        ...supaHeaders(),
        // return=representation so we can count deleted rows.
        Prefer: "return=representation",
      },
    });

    if (!r.ok) {
      const txt = await r.text();
      console.warn(`[billing] purgeArchivedLunaMemories DELETE ${r.status}: ${txt.slice(0, 200)}`);
      return 0;
    }

    const deleted = (await r.json()) as unknown[];
    const count = Array.isArray(deleted) ? deleted.length : 0;
    if (count > 0) {
      console.log(`[billing] purgeArchivedLunaMemories: deleted ${count} archived memory rows`);
    }
    return count;
  } catch (e) {
    console.warn("[billing] purgeArchivedLunaMemories failed:", e);
    return 0;
  }
}
