// Functional tests for the async-jobs surface (wave 27 + soft-cancel).
//
// Endpoints covered:
//   GET    /api/jobs           — list (filterable by status, user_id, limit)
//   GET    /api/jobs/:id       — single row, 404 if missing
//   DELETE /api/jobs/:id       — soft-cancel (status → 'cancelled')
//
// Cancellation is best-effort in v1: the in-flight worker can't be killed,
// the cancel just instructs the final-state writer to skip the overwrite.
// We verify the route surface — auth, response shapes, 404 on missing rows.

import { test, expect, beforeAll, afterEach } from "bun:test";
import { handleSafeEditRoutes } from "../../src/server/routes/safe-edit";

const TEST_TOKEN = "test-token-jobs";

beforeAll(() => {
  process.env.BEARER_TOKEN = TEST_TOKEN;
  process.env.DISABLE_AUTH = "";
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubDeps() {
  const fail = (name: string) => () => {
    throw new Error(`unexpected dep call: ${name}`);
  };
  return {
    saveGeneration: fail("saveGeneration") as any,
    getCharacter: fail("getCharacter") as any,
  };
}

function build(
  method: string,
  path: string,
  withAuth = true,
): { req: Request; url: URL } {
  const url = new URL(`http://localhost:3000${path}`);
  const headers: Record<string, string> = {};
  if (withAuth) headers["Authorization"] = `Bearer ${TEST_TOKEN}`;
  const req = new Request(url.toString(), { method, headers });
  return { req, url };
}

// ----- GET /api/jobs (list) -----

test("jobs list — auth gate triggers without bearer", async () => {
  const { req, url } = build("GET", "/api/jobs", false);
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
});

test("jobs list — empty supabase returns { items: [], count: 0 }", async () => {
  globalThis.fetch = (async () =>
    new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as any;

  const { req, url } = build("GET", "/api/jobs");
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(Array.isArray(body.items)).toBe(true);
  expect(body.items.length).toBe(0);
  expect(body.count).toBe(0);
});

test("jobs list — populated supabase preserves item shape", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        {
          id: "44444444-4444-4444-4444-444444444444",
          status: "queued",
          job_type: "edit",
          engine: "lens",
          created_at: "2026-04-27T00:00:00Z",
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as any;

  const { req, url } = build("GET", "/api/jobs");
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(Array.isArray(body.items)).toBe(true);
  expect(body.items.length).toBe(1);
  expect(body.items[0].id).toBe("44444444-4444-4444-4444-444444444444");
  expect(body.items[0].status).toBe("queued");
  expect(body.count).toBeGreaterThanOrEqual(1);
});

test("jobs list — passes status filter to supabase", async () => {
  let captured = "";
  globalThis.fetch = (async (urlIn: any) => {
    captured = String(urlIn);
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;

  const { req, url } = build("GET", "/api/jobs?status=running");
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  // Filter must end up in the upstream query.
  expect(captured).toContain("status=eq.running");
});

test("jobs list — caps limit at 200 when caller asks for more", async () => {
  let captured = "";
  globalThis.fetch = (async (urlIn: any) => {
    captured = String(urlIn);
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;

  const { req, url } = build("GET", "/api/jobs?limit=5000");
  await handleSafeEditRoutes(req, url, stubDeps());
  expect(captured).toContain("limit=200");
  expect(captured).not.toContain("limit=5000");
});

// ----- GET /api/jobs/:id -----

test("jobs get — auth gate triggers without bearer", async () => {
  const { req, url } = build(
    "GET",
    "/api/jobs/55555555-5555-5555-5555-555555555555",
    false,
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
});

test("jobs get — supabase empty array returns 404 not_found", async () => {
  globalThis.fetch = (async () =>
    new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as any;

  const { req, url } = build(
    "GET",
    "/api/jobs/55555555-5555-5555-5555-555555555555",
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(404);
  const body = await resp!.json();
  expect(body.error).toBe("not_found");
  expect(body.job_id).toBe("55555555-5555-5555-5555-555555555555");
});

test("jobs get — populated row returns { ok: true, job }", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        {
          id: "55555555-5555-5555-5555-555555555555",
          status: "completed",
          progress: 100,
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as any;

  const { req, url } = build(
    "GET",
    "/api/jobs/55555555-5555-5555-5555-555555555555",
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(body.ok).toBe(true);
  expect(body.job.id).toBe("55555555-5555-5555-5555-555555555555");
  expect(body.job.status).toBe("completed");
});

// ----- DELETE /api/jobs/:id (soft-cancel) -----

test("jobs delete — auth gate triggers without bearer", async () => {
  const { req, url } = build(
    "DELETE",
    "/api/jobs/55555555-5555-5555-5555-555555555555",
    false,
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
});

test("jobs delete — sends PATCH with status='cancelled'", async () => {
  let captured: { url?: string; init?: any } = {};
  globalThis.fetch = (async (urlIn: any, init?: any) => {
    captured.url = String(urlIn);
    captured.init = init;
    return new Response(
      JSON.stringify([
        {
          id: "55555555-5555-5555-5555-555555555555",
          status: "cancelled",
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;

  const { req, url } = build(
    "DELETE",
    "/api/jobs/55555555-5555-5555-5555-555555555555",
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(body.ok).toBe(true);
  expect(body.job.status).toBe("cancelled");
  expect(captured.init?.method).toBe("PATCH");
  expect(String(captured.init?.body || "")).toContain('"status":"cancelled"');
});

test("jobs delete — empty supabase response → 404", async () => {
  globalThis.fetch = (async () =>
    new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as any;

  const { req, url } = build(
    "DELETE",
    "/api/jobs/66666666-6666-6666-6666-666666666666",
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(404);
  const body = await resp!.json();
  expect(body.error).toBe("not_found");
});

// ----- /api/jobs/:id — method enforcement -----

test("jobs :id — POST returns 405 method_not_allowed", async () => {
  const { req, url } = build(
    "POST",
    "/api/jobs/55555555-5555-5555-5555-555555555555",
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(405);
  const body = await resp!.json();
  expect(body.error).toBe("method_not_allowed");
});
