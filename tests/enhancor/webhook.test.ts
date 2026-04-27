// tests/enhancor/webhook.test.ts
//
// Purpose:  Verify the POST /api/enhancor/webhook handler:
//           (a) Idempotency — a second delivery with webhook_received_at already
//               set returns 200 { ok: true, idempotent: true } with no PATCH.
//           (b) Signature / auth — Enhancor does NOT sign callbacks (see handler
//               comment in safe-edit.ts: "intentionally auth-bypassed — Enhancor
//               can't send our internal bearer token"). Security is provided by
//               correlation-id matching (vendor_request_id). There is no
//               signature header to forge/validate.
//
//           Tests also cover the 400 / 404 error paths for completeness.
//
// Mocking:  globalThis.fetch is replaced to intercept PostgREST calls made by
//           handleEnhancorWebhook:
//           - GET  /rest/v1/jobs  → lookup by vendor_request_id
//           - PATCH /rest/v1/jobs → update status / webhook_received_at
//
//           NOTE: SUPABASE_URL is hardcoded in src/server/config.ts (not env),
//           so fetch mocks check URL path substrings rather than the domain.
//
// Inputs:   No real HTTP calls; no DB side-effects.
// Side effects: globalThis.fetch is replaced and restored around each test.
// Failure:  If the PostgREST call order in handleEnhancorWebhook changes,
//           update the mock routing logic accordingly.

import { test, expect, afterEach, beforeAll } from "bun:test";
import { handleSafeEditRoutes } from "../../src/server/routes/safe-edit";

const TEST_TOKEN = "test-token-webhook";

beforeAll(() => {
  process.env.BEARER_TOKEN = TEST_TOKEN;
  process.env.DISABLE_AUTH = "";
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildWebhookPost(body: unknown): { req: Request; url: URL } {
  const url = new URL("http://localhost:3000/api/enhancor/webhook");
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    // NOTE: no Authorization header — webhook is intentionally auth-bypassed.
    body: JSON.stringify(body),
  });
  return { req, url };
}

function stubDeps() {
  const fail = (name: string) => () => {
    throw new Error(`unexpected dep call: ${name}`);
  };
  return {
    saveGeneration: fail("saveGeneration") as any,
    getCharacter: fail("getCharacter") as any,
  };
}

// ---------------------------------------------------------------------------
// URL helpers for matching PostgREST calls.
// SUPABASE_URL is hardcoded in src/server/config.ts so we match on path only.
// ---------------------------------------------------------------------------

/** True when this is the job-lookup GET (includes vendor_request_id filter). */
function isJobLookup(url: string): boolean {
  return url.includes("/rest/v1/jobs") && url.includes("vendor_request_id=eq.");
}

/** True when this is the job-update PATCH (id=eq. filter, no vendor_request_id). */
function isJobPatch(url: string, method: string): boolean {
  return url.includes("/rest/v1/jobs") && url.includes("id=eq.") && method === "PATCH";
}

// ---------------------------------------------------------------------------
// Test 1: missing request_id → 400
// ---------------------------------------------------------------------------
test("webhook: missing request_id returns 400", async () => {
  const { req, url } = buildWebhookPost({ result: "https://cdn.enhancor.ai/result.jpg", status: "COMPLETED" });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.error).toBe("invalid_body");
});

// ---------------------------------------------------------------------------
// Test 2: invalid JSON body → 400
// ---------------------------------------------------------------------------
test("webhook: invalid JSON body returns 400", async () => {
  const url = new URL("http://localhost:3000/api/enhancor/webhook");
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not-json{{",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.error).toBe("invalid_body");
});

// ---------------------------------------------------------------------------
// Test 3: no matching job row → 404
// ---------------------------------------------------------------------------
test("webhook: unknown request_id returns 404", async () => {
  // PostgREST lookup returns empty array → no matching job row.
  globalThis.fetch = (async () => jsonResp([])) as typeof fetch;

  const { req, url } = buildWebhookPost({
    request_id: "req-unknown-9999",
    result: "https://cdn.enhancor.ai/result.jpg",
    status: "COMPLETED",
  });

  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(404);
  const body = await resp!.json();
  expect(body.error).toBe("not_found");
  expect(body.request_id).toBe("req-unknown-9999");
});

// ---------------------------------------------------------------------------
// Test 4: first delivery (webhook_received_at = null) → 200, PATCH fired
// ---------------------------------------------------------------------------
test("webhook: first delivery triggers DB PATCH and returns 200 ok=true", async () => {
  const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  let patchCalled = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(typeof input === "string" ? input : (input as URL).toString());
    const method = init?.method || "GET";

    if (isJobPatch(urlStr, method)) {
      patchCalled = true;
      // PostgREST PATCH with Prefer: return=minimal responds 204 with no body.
      return new Response("", { status: 204 });
    }

    if (isJobLookup(urlStr)) {
      // Row found, not yet processed.
      return jsonResp([{ id: jobId, webhook_received_at: null }]);
    }

    return jsonResp({ error: "unexpected fetch", url: urlStr }, 500);
  }) as typeof fetch;

  const { req, url } = buildWebhookPost({
    request_id: "req-first-delivery-001",
    result: "https://cdn.enhancor.ai/result.jpg",
    status: "COMPLETED",
    cost: 2,
  });

  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(body.ok).toBe(true);
  expect(body.job_id).toBe(jobId);
  expect(patchCalled).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 5: duplicate delivery (webhook_received_at already set)
//         → 200 idempotent=true, NO PATCH fired
// ---------------------------------------------------------------------------
test("webhook: duplicate delivery returns 200 idempotent=true without re-patching", async () => {
  const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  let patchCalled = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(typeof input === "string" ? input : (input as URL).toString());
    const method = init?.method || "GET";

    if (isJobPatch(urlStr, method)) {
      patchCalled = true;
      return new Response("", { status: 204 });
    }

    if (isJobLookup(urlStr)) {
      // webhook_received_at is already set — this is a duplicate delivery.
      return jsonResp([{ id: jobId, webhook_received_at: "2026-04-27T10:00:00.000Z" }]);
    }

    return jsonResp({ error: "unexpected fetch", url: urlStr }, 500);
  }) as typeof fetch;

  const { req, url } = buildWebhookPost({
    request_id: "req-duplicate-001",
    result: "https://cdn.enhancor.ai/result.jpg",
    status: "COMPLETED",
  });

  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(body.ok).toBe(true);
  expect(body.idempotent).toBe(true);
  expect(body.job_id).toBe(jobId);
  // Critically: no PATCH was issued for the duplicate.
  expect(patchCalled).toBe(false);
});

// ---------------------------------------------------------------------------
// Test 6: same payload delivered twice in sequence (end-to-end idempotency)
//         First call processes; second call is a no-op.
// ---------------------------------------------------------------------------
test("webhook: same payload twice — only one PATCH total (idempotency end-to-end)", async () => {
  const jobId = "cccccccc-dddd-eeee-ffff-111111111111";
  let patchCount = 0;
  let firstCallProcessed = false;

  // After the first delivery, simulate webhook_received_at being set.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(typeof input === "string" ? input : (input as URL).toString());
    const method = init?.method || "GET";

    if (isJobPatch(urlStr, method)) {
      patchCount++;
      firstCallProcessed = true;
      return new Response("", { status: 204 });
    }

    if (isJobLookup(urlStr)) {
      // Lookup: first delivery sees null; subsequent deliveries see timestamp.
      const receivedAt = firstCallProcessed ? "2026-04-27T10:00:00.000Z" : null;
      return jsonResp([{ id: jobId, webhook_received_at: receivedAt }]);
    }

    return jsonResp({ error: "unexpected fetch", url: urlStr }, 500);
  }) as typeof fetch;

  const payload = {
    request_id: "req-e2e-idempotent-001",
    result: "https://cdn.enhancor.ai/e2e.jpg",
    status: "COMPLETED",
  };

  // First delivery.
  const { req: req1, url: url1 } = buildWebhookPost(payload);
  const resp1 = await handleSafeEditRoutes(req1, url1, stubDeps());
  expect(resp1!.status).toBe(200);
  const body1 = await resp1!.json();
  expect(body1.ok).toBe(true);
  expect(body1.idempotent).toBeUndefined(); // First delivery is not flagged as idempotent.

  // Second delivery — identical payload.
  const { req: req2, url: url2 } = buildWebhookPost(payload);
  const resp2 = await handleSafeEditRoutes(req2, url2, stubDeps());
  expect(resp2!.status).toBe(200);
  const body2 = await resp2!.json();
  expect(body2.ok).toBe(true);
  expect(body2.idempotent).toBe(true); // Duplicate flagged.

  // Only one PATCH was issued across both deliveries.
  expect(patchCount).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 7: no signature enforcement (documented behavior)
//         Enhancor does not sign payloads; the handler accepts unsigned requests.
//         A "forged" payload with a valid request_id succeeds if the DB row
//         exists — this is the intended design (correlation-id security model).
// ---------------------------------------------------------------------------
test("webhook: no signature required — unsigned payload with valid request_id is accepted", async () => {
  const jobId = "dddddddd-eeee-ffff-aaaa-222222222222";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(typeof input === "string" ? input : (input as URL).toString());
    const method = init?.method || "GET";

    if (isJobPatch(urlStr, method)) return new Response("", { status: 204 });
    if (isJobLookup(urlStr)) return jsonResp([{ id: jobId, webhook_received_at: null }]);

    return jsonResp({ error: "unexpected fetch", url: urlStr }, 500);
  }) as typeof fetch;

  // No Authorization header, no signature header — intentionally "unsigned".
  const url = new URL("http://localhost:3000/api/enhancor/webhook");
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    // No x-enhancor-signature or similar.
    body: JSON.stringify({
      request_id: "req-unsigned-001",
      result: "https://cdn.enhancor.ai/unsigned.jpg",
      status: "COMPLETED",
    }),
  });

  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  // Handler accepts the request — no 401 because Enhancor doesn't sign.
  // The security model is correlation-id based (vendor_request_id matching).
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(body.ok).toBe(true);
});
