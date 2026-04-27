// Functional tests for the Brush + auto-mask pipeline.
//
// Two routes participate in this pipeline:
//   POST /api/auto-mask-garment — Grok Vision detects garment regions, returns
//                                 a soft mask (data URL).
//   POST /api/flux-edit         — auto_mask + Flux Fill Pro in one call. Has
//                                 a blank-detection 422 path for content
//                                 filter rejections.
//
// Tests cover:
//   - auth gate (both routes)
//   - missing required fields (image_url) returns 400
//   - delegation contract (non-matching paths return null)
//   - flux-edit with auto_mask path can be reached past validation
//
// All tests use input-validation paths or stubbed fetch; no live API calls.

import { test, expect, beforeAll, afterEach } from "bun:test";
import { handleSafeEditRoutes } from "../../src/server/routes/safe-edit";

const TEST_TOKEN = "test-token-brush-auto";

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

// =============================================================================
// /api/auto-mask-garment
// =============================================================================

test("auto-mask-garment — auth gate triggers without bearer", async () => {
  const { req, url } = buildPost(
    "/api/auto-mask-garment",
    { image_url: "https://example.com/x.png" },
    /* withAuth */ false,
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
  const body = await resp!.json();
  expect(body.error).toBe("unauthorized");
});

test("auto-mask-garment — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/auto-mask-garment", {
    garment_url: "https://example.com/dress.png",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

test("auto-mask-garment — completely empty body returns 400", async () => {
  const { req, url } = buildPost("/api/auto-mask-garment", {});
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.error).toBeDefined();
});

test("auto-mask-garment — vendor failure surfaces as 500 with error message", async () => {
  // With image_url provided but fetch stubbed to fail, the handler attempts
  // to download the source. Stub returns non-ok → handler returns 400 with
  // 'fetch source ...' OR 500 if a downstream throws. Either way, it doesn't
  // leak vendor secrets and returns a json error body.
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as any;

  const { req, url } = buildPost("/api/auto-mask-garment", {
    image_url: "https://example.com/source.png",
    garment_type: "bra",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  // Could be 400 ("fetch source 500") or 500 (caught error).
  expect([400, 500]).toContain(resp!.status);
  const body = await resp!.json();
  expect(body.error).toBeDefined();
});

// =============================================================================
// /api/flux-edit (auto-mask + Flux Fill Pro pipeline)
// =============================================================================

test("flux-edit — auth gate triggers without bearer", async () => {
  const { req, url } = buildPost(
    "/api/flux-edit",
    { image_url: "https://example.com/x.png", prompt: "swap shirt" },
    /* withAuth */ false,
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(401);
  const body = await resp!.json();
  expect(body.error).toBe("unauthorized");
});

test("flux-edit — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/flux-edit", {
    prompt: "change comforter to white linen",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

test("flux-edit — missing prompt returns 400", async () => {
  const { req, url } = buildPost("/api/flux-edit", {
    image_url: "https://example.com/x.png",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("prompt");
});

test("flux-edit — auto_mask path with vendor fetch failure surfaces 400/500", async () => {
  // Provide image_url + prompt → reach past validation. Fetch is stubbed to
  // fail the source download. Handler returns 400 with 'fetch source ...'.
  globalThis.fetch = (async () =>
    new Response("nope", { status: 502 })) as any;

  const { req, url } = buildPost("/api/flux-edit", {
    image_url: "https://example.com/source.png",
    prompt: "change the comforter to white linen",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  // Past validation → either fetch-source error (400) or generic 500.
  expect([400, 500]).toContain(resp!.status);
  const body = await resp!.json();
  expect(body.error).toBeDefined();
});

// --- request-shape verification: outgoing payload would carry user fields ---

test("flux-edit — auto_mask:true is accepted (no 400 from extra param)", async () => {
  // The handler tolerates extra fields like auto_mask. Ensure the validator
  // does not 400 on a documented param — it should pass through.
  globalThis.fetch = (async () =>
    new Response("nope", { status: 502 })) as any;

  const { req, url } = buildPost("/api/flux-edit", {
    image_url: "https://example.com/source.png",
    prompt: "change comforter to white linen",
    auto_mask: true,
    guidance_scale: 3.5,
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  // Whatever the status, the error must NOT be about auto_mask or guidance_scale
  // being unrecognized — the handler accepts those as documented params.
  const body = await resp!.json();
  expect(body.error).toBeDefined();
  expect(String(body.error).toLowerCase()).not.toContain("auto_mask");
  expect(String(body.error).toLowerCase()).not.toContain("guidance_scale");
});

// --- delegation contract ---

test("flux-edit / auto-mask — non-matching path returns null", async () => {
  const url = new URL("http://localhost:3000/api/__pipeline_brush_nonexistent__");
  const req = new Request(url.toString(), { method: "POST" });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).toBeNull();
});
