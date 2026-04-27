// Functional tests for Skin — Darkroom Skin (Grok-PRO based, PLAN.md house name)
// and supporting safe-edit primitives (resize, blend, smart-edit, surgical-edit).
//
// All tests target input-validation paths. No live API calls — handlers
// short-circuit on missing required fields before any fetch() to xAI/Replicate.

import { test, expect, beforeAll } from "bun:test";
import { handleSafeEditRoutes } from "../../src/server/routes/safe-edit";

const TEST_TOKEN = "test-token-skin";

beforeAll(() => {
  process.env.BEARER_TOKEN = TEST_TOKEN;
  process.env.DISABLE_AUTH = "";
});

function safeStubDeps() {
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

// --- /api/darkroom-skin (Skin engine) ---

test("skin:darkroom-skin — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/darkroom-skin", { intensity: "medium" });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

test("skin:darkroom-skin — missing auth returns 401", async () => {
  const { req, url } = buildPost(
    "/api/darkroom-skin",
    { image_url: "https://example.com/x.png" },
    /* withAuth */ false,
  );
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(401);
});

// --- /api/blend (Blend engine — multi-image blend) ---

test("skin:blend — missing base_url returns 400", async () => {
  const { req, url } = buildPost("/api/blend", {
    top_url: "https://example.com/t.png",
    alpha: 0.5,
  });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("base_url");
});

test("skin:blend — missing top_url returns 400", async () => {
  const { req, url } = buildPost("/api/blend", {
    base_url: "https://example.com/b.png",
    alpha: 0.5,
  });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("top_url");
});

// --- /api/resize (post-pipeline primitive) ---

test("skin:resize — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/resize", { target_size: 1200 });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

// --- /api/smart-edit (gpt-image-2 → fallback Grok orchestrator) ---

test("skin:smart-edit — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/smart-edit", { prompt: "darken background" });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

test("skin:smart-edit — missing prompt returns 400", async () => {
  const { req, url } = buildPost("/api/smart-edit", {
    image_url: "https://example.com/x.png",
  });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("prompt");
});

// --- /api/surgical-edit ---

test("skin:surgical-edit — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/surgical-edit", { prompt: "tighten lighting" });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

test("skin:surgical-edit — missing prompt returns 400", async () => {
  const { req, url } = buildPost("/api/surgical-edit", {
    image_url: "https://example.com/x.png",
  });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("prompt");
});

// --- /api/detect-nsfw ---

test("skin:detect-nsfw — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/detect-nsfw", {});
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

// --- Auth bypass via DISABLE_AUTH=1 — verifies the dev escape hatch works ---

test("skin:auth-bypass — DISABLE_AUTH=1 lets unauthenticated request through validation", async () => {
  const prevToken = process.env.BEARER_TOKEN;
  const prevDisable = process.env.DISABLE_AUTH;
  try {
    process.env.DISABLE_AUTH = "1";
    process.env.BEARER_TOKEN = "";
    // No Authorization header — should bypass auth and hit body validation.
    const url = new URL("http://localhost:3000/api/darkroom-skin");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
    // Auth bypassed, then "image_url required" 400 from validation.
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(String(body.error).toLowerCase()).toContain("image_url");
  } finally {
    process.env.BEARER_TOKEN = prevToken || "";
    process.env.DISABLE_AUTH = prevDisable || "";
  }
});
