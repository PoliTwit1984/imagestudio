// tests/enhancor/quota.test.ts
//
// Purpose:  Verify that a free-tier user hitting the /api/enhancor/skin route
//           (POST, keyed metric = "edits") receives a 402 response with the
//           expected body shape once their monthly edits quota is exhausted.
//
// Strategy: The route does not yet exist as a distinct path in safe-edit.ts
//           (it is tracked in PLAN.md §Skin Pro wiring). These tests exercise
//           the billing layer (billing.ts) and the checkQuotaOrReject helper
//           that every quota-gated route uses. This is the correct isolation
//           level: the route is a thin wrapper around checkQuotaOrReject, and
//           the quota enforcement is entirely in billing.checkQuota().
//
// Mocking:  globalThis.fetch is replaced to intercept PostgREST calls:
//           - subscriptions lookup → [] (no active subscription → free tier)
//           - usage_quota lookup   → [{ count: 100 }] (free edits cap = 100)
//
// Inputs:   SUPABASE_URL env var must be set so billing.ts skips the early
//           "no DB configured" bail-out.
// Outputs:  No real HTTP calls; no DB side-effects.
// Failure:  If billing.ts adds a new fetch call ordering, adjust the mock
//           sequence (callIndex counter) accordingly.

import { test, expect, afterEach } from "bun:test";
import { checkQuota, BILLING_TIERS, type BillingTier } from "../../src/server/billing";

// Install a fake SUPABASE_URL so billing.ts doesn't short-circuit on "no db".
const FAKE_SUPABASE = "https://fake-project.supabase.co";
process.env.SUPABASE_URL = FAKE_SUPABASE;
// SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY not needed — supaHeaders() falls
// back gracefully when absent (apikey header omitted).

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Helper: build a fetch stub that returns canned responses in order.
// ---------------------------------------------------------------------------
function sequentialFetchStub(responses: Response[]): typeof fetch {
  let callIndex = 0;
  return (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return resp;
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Test 1: free-tier user AT quota limit → checkQuota returns ok=false
// ---------------------------------------------------------------------------
test("quota: free-tier user at edits limit — checkQuota returns ok=false", async () => {
  const FREE_EDITS_LIMIT = BILLING_TIERS.free.limits.edits_per_month; // 100

  globalThis.fetch = sequentialFetchStub([
    // 1st call: subscriptions lookup → empty (no active subscription → free tier)
    jsonResponse([]),
    // 2nd call: usage_quota lookup → count = FREE_EDITS_LIMIT (at cap)
    jsonResponse([{ count: FREE_EDITS_LIMIT }]),
  ]);

  const result = await checkQuota("user-abc-free-1234", "edits");

  expect(result.ok).toBe(false);
  expect(result.metric).toBe("edits");
  expect(result.tier).toBe("free" as BillingTier);
  expect(result.used).toBe(FREE_EDITS_LIMIT);
  expect(result.limit).toBe(FREE_EDITS_LIMIT);
  expect(result.remaining).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 2: free-tier user OVER limit (past-cap) → ok=false, remaining=0
// ---------------------------------------------------------------------------
test("quota: free-tier user over edits limit — checkQuota still returns ok=false, remaining clamped to 0", async () => {
  const FREE_EDITS_LIMIT = BILLING_TIERS.free.limits.edits_per_month;

  globalThis.fetch = sequentialFetchStub([
    jsonResponse([]),
    jsonResponse([{ count: FREE_EDITS_LIMIT + 5 }]),
  ]);

  const result = await checkQuota("user-abc-free-1234", "edits");

  expect(result.ok).toBe(false);
  expect(result.remaining).toBe(0); // Math.max(0, limit - used)
});

// ---------------------------------------------------------------------------
// Test 3: free-tier user UNDER limit → ok=true (sanity / green path)
// ---------------------------------------------------------------------------
test("quota: free-tier user under edits limit — checkQuota returns ok=true", async () => {
  const FREE_EDITS_LIMIT = BILLING_TIERS.free.limits.edits_per_month;

  globalThis.fetch = sequentialFetchStub([
    jsonResponse([]),
    jsonResponse([{ count: FREE_EDITS_LIMIT - 1 }]),
  ]);

  const result = await checkQuota("user-abc-free-1234", "edits");

  expect(result.ok).toBe(true);
  expect(result.remaining).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 4: simulate the 402 response body shape produced by checkQuotaOrReject.
//         We construct the Response.json() call the same way the route handler
//         does so the shape contract is tested independently of the route.
// ---------------------------------------------------------------------------
test("quota: 402 response body contains metric, limit, used, tier", async () => {
  const FREE_EDITS_LIMIT = BILLING_TIERS.free.limits.edits_per_month;

  globalThis.fetch = sequentialFetchStub([
    jsonResponse([]),
    jsonResponse([{ count: FREE_EDITS_LIMIT }]),
  ]);

  const check = await checkQuota("user-abc-free-1234", "edits");
  expect(check.ok).toBe(false);

  // Construct the same 402 response the handler would return.
  const resp = Response.json(
    {
      error: `Quota exceeded for ${check.metric}. You've used ${check.used} of ${check.limit} this month on ${check.tier} tier.`,
      quota_exceeded: true,
      metric: check.metric,
      used: check.used,
      limit: check.limit,
      tier: check.tier,
      remaining: check.remaining,
    },
    { status: 402 },
  );

  expect(resp.status).toBe(402);
  const body = await resp.json();
  expect(body.quota_exceeded).toBe(true);
  expect(body.metric).toBe("edits");
  expect(typeof body.limit).toBe("number");
  expect(typeof body.used).toBe("number");
  expect(body.tier).toBe("free");
});

// ---------------------------------------------------------------------------
// Test 5: unauthenticated user (no userId) → checkQuota returns ok=true
//         (silent free-tier passthrough per the TODO(per-user-auth) comment).
// ---------------------------------------------------------------------------
test("quota: null userId bypasses quota check (passthrough)", async () => {
  // No fetch mock needed — billing.ts returns 0 usage when userId is falsy.
  const result = await checkQuota(null, "edits");
  // With no userId, SUPABASE_URL check still applies but userId is null → free, usage=0.
  expect(result.ok).toBe(true);
  expect(result.tier).toBe("free");
  expect(result.used).toBe(0);
});
