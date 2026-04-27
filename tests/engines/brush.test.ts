// Functional tests for Brush — Flux Fill Pro (PLAN.md house name).
//
// Brush is exposed via two routes in safe-edit.ts:
//   POST /api/detail-brush — registry-driven brush prompts (e.g. tan-lines)
//   POST /api/flux-edit    — auto-mask + Flux Fill Pro
//   POST /api/inpaint      — paint-your-own mask + Flux Fill Pro
//
// Tests cover input validation contracts. No live API calls — validation
// rejects requests before any fetch() to fal.ai.

import { test, expect, beforeAll } from "bun:test";
import { handleSafeEditRoutes } from "../../src/server/routes/safe-edit";

const TEST_TOKEN = "test-token-brush";

beforeAll(() => {
  process.env.BEARER_TOKEN = TEST_TOKEN;
  process.env.DISABLE_AUTH = "";
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

// --- /api/flux-edit ---

test("brush:flux-edit — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/flux-edit", { prompt: "swap shirt" });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

test("brush:flux-edit — missing prompt returns 400", async () => {
  const { req, url } = buildPost("/api/flux-edit", {
    image_url: "https://example.com/x.png",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("prompt");
});

test("brush:flux-edit — missing auth returns 401 before body parse", async () => {
  const { req, url } = buildPost(
    "/api/flux-edit",
    { image_url: "https://example.com/x.png", prompt: "foo" },
    /* withAuth */ false,
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(401);
  const body = await resp!.json();
  expect(body.error).toBe("unauthorized");
});

// --- /api/detail-brush ---

test("brush:detail-brush — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/detail-brush", {
    mask_b64: "iVBORw0KGgo=",
    brush_id: "tan-lines-bikini",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

test("brush:detail-brush — missing mask_b64 returns 400", async () => {
  const { req, url } = buildPost("/api/detail-brush", {
    image_url: "https://example.com/x.png",
    brush_id: "tan-lines-bikini",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("mask_b64");
});

test("brush:detail-brush — missing brush_id returns 400", async () => {
  const { req, url } = buildPost("/api/detail-brush", {
    image_url: "https://example.com/x.png",
    mask_b64: "iVBORw0KGgo=",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("brush_id");
});

test("brush:detail-brush — unknown brush_id returns 400 'unknown brush'", async () => {
  const { req, url } = buildPost("/api/detail-brush", {
    image_url: "https://example.com/x.png",
    mask_b64: "iVBORw0KGgo=",
    brush_id: "this-brush-does-not-exist-zzz",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("brush");
});

// --- /api/inpaint ---

test("brush:inpaint — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/inpaint", {
    mask_b64: "iVBORw0KGgo=",
    prompt: "fill it in",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

test("brush:inpaint — missing mask_b64 returns 400", async () => {
  const { req, url } = buildPost("/api/inpaint", {
    image_url: "https://example.com/x.png",
    prompt: "fill it in",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("mask_b64");
});

test("brush:inpaint — missing prompt returns 400", async () => {
  const { req, url } = buildPost("/api/inpaint", {
    image_url: "https://example.com/x.png",
    mask_b64: "iVBORw0KGgo=",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("prompt");
});

test("brush:flux-edit — non-matching path returns null (delegation contract)", async () => {
  const url = new URL("http://localhost:3000/api/__nonexistent__");
  const req = new Request(url.toString(), { method: "POST" });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).toBeNull();
});
