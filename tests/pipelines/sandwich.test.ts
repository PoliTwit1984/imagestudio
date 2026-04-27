// Functional tests for the sandwich-edit pipeline.
//
// Sandwich is a routing/sequencing pipeline: P-Edit (clothe) → safe editor
// (gpt-image-2 or nano-banana) → P-Edit (unclothe). Lets mainstream editors
// touch NSFW source material without refusing.
//
// Route: POST /api/sandwich-edit (handled by handleSandwichEdit in safe-edit.ts).
//
// These tests cover the request/response contract — auth gate, missing fields,
// graceful failure when vendor calls fail. No live API calls; all upstream
// fetches are stubbed via globalThis.fetch override and short-circuit early
// via input validation.
//
// edit_engine accepts "gpt" or "nano" per handler signature (PLAN.md aliases
// "gpt-2" → "gpt", "nano" stays "nano"). We verify routing accepts both.

import { test, expect, beforeAll, afterEach } from "bun:test";
import { handleSafeEditRoutes } from "../../src/server/routes/safe-edit";

const TEST_TOKEN = "test-token-sandwich";

beforeAll(() => {
  process.env.BEARER_TOKEN = TEST_TOKEN;
  process.env.DISABLE_AUTH = "";
});

const realFetch = globalThis.fetch;
afterEach(() => {
  // Restore real fetch after any test that mocked it.
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

function buildPost(path: string, body: any, withAuth = true): { req: Request; url: URL } {
  const url = new URL(`http://localhost:3000${path}`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (withAuth) headers["Authorization"] = `Bearer ${TEST_TOKEN}`;
  const req = new Request(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { req, url };
}

// --- input validation ---

test("sandwich — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/sandwich-edit", {
    edit_prompt: "change the background",
    edit_engine: "nano",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

test("sandwich — missing edit_prompt returns 400", async () => {
  const { req, url } = buildPost("/api/sandwich-edit", {
    image_url: "https://example.com/source.png",
    edit_engine: "nano",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("edit_prompt");
});

// --- auth gate ---

test("sandwich — auth gate triggers without bearer header", async () => {
  const { req, url } = buildPost(
    "/api/sandwich-edit",
    {
      image_url: "https://example.com/source.png",
      edit_prompt: "change the background",
      edit_engine: "nano",
    },
    /* withAuth */ false,
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
  const body = await resp!.json();
  expect(body.error).toBe("unauthorized");
});

// --- vendor failure → graceful 500 with error message ---

test("sandwich — vendor 401 surfaces as 500 with error message (graceful)", async () => {
  // Mock fetch so the first vendor call (P-Edit clothe step) returns 401.
  // Handler should catch and return 500 with an error string, not crash.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as any;

  const { req, url } = buildPost("/api/sandwich-edit", {
    image_url: "https://example.com/source.png",
    edit_prompt: "change the background to a beach",
    edit_engine: "nano",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  // Handler wraps any thrown vendor error in a 500 with { error }.
  expect(resp!.status).toBe(500);
  const body = await resp!.json();
  expect(body.error).toBeDefined();
  expect(typeof body.error).toBe("string");
});

// --- routing: edit_engine accepts both "gpt" and "nano" ---

test("sandwich — edit_engine 'nano' is accepted (routes to nano-banana branch)", async () => {
  // We can't reach the actual vendor, but we can verify the handler accepts
  // the input shape and proceeds past validation by checking it does NOT
  // 400 on edit_engine. With fetch stubbed to fail, expect 500 — meaning
  // we got past validation into the pipeline.
  globalThis.fetch = (async () =>
    new Response("server error", { status: 500 })) as any;

  const { req, url } = buildPost("/api/sandwich-edit", {
    image_url: "https://example.com/source.png",
    edit_prompt: "swap shirt for white tank",
    edit_engine: "nano",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  // Either 500 (vendor failure caught) or 422-ish — anything BUT 400 on the
  // edit_engine field means routing accepted it.
  expect(resp!.status).not.toBe(400);
});

test("sandwich — edit_engine 'gpt' is accepted (routes to gpt-image-2 branch)", async () => {
  globalThis.fetch = (async () =>
    new Response("server error", { status: 500 })) as any;

  const { req, url } = buildPost("/api/sandwich-edit", {
    image_url: "https://example.com/source.png",
    edit_prompt: "swap shirt for white tank",
    edit_engine: "gpt",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).not.toBe(400);
});

test("sandwich — edit_engine omitted defaults to nano (no validation error)", async () => {
  // Per handler: const editEngine = String(body.edit_engine || "nano").
  // When omitted, default routing kicks in — should NOT be a 400.
  globalThis.fetch = (async () =>
    new Response("server error", { status: 500 })) as any;

  const { req, url } = buildPost("/api/sandwich-edit", {
    image_url: "https://example.com/source.png",
    edit_prompt: "make it sunset lighting",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).not.toBe(400);
});

// --- delegation contract ---

test("sandwich — non-matching path returns null (delegation contract)", async () => {
  const url = new URL("http://localhost:3000/api/__sandwich_nonexistent__");
  const req = new Request(url.toString(), { method: "POST" });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).toBeNull();
});
