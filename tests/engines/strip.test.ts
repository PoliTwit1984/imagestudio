// Functional tests for Strip — P-Edit (PLAN.md house name).
//
// Strip is exposed via:
//   POST /api/edit             (engine="pedit") — single-image P-Edit
//   POST /api/wear-garment     — multi-image P-Edit (subject + garment refs)
//   POST /api/optimize-pedit-prompt — Grok-driven prompt optimizer
//
// All tests use input-validation paths (no live Replicate calls).

import { test, expect, beforeAll } from "bun:test";
import { handleGenerationRoutes } from "../../src/server/routes/generation";
import { handleSafeEditRoutes } from "../../src/server/routes/safe-edit";

const TEST_TOKEN = "test-token-strip";

beforeAll(() => {
  process.env.BEARER_TOKEN = TEST_TOKEN;
  process.env.DISABLE_AUTH = "";
});

function genStubDeps() {
  const fail = (name: string) => () => {
    throw new Error(`unexpected dep call: ${name}`);
  };
  return {
    CHAT_SYSTEM_DEFAULT: "",
    REALISM_DIRECTIVE_DEFAULT: "",
    REALISM_TAGS: "",
    analyzeImage: fail("analyzeImage") as any,
    enhancePrompt: fail("enhancePrompt") as any,
    generateImage: fail("generateImage") as any,
    generateMagnificPrompt: fail("generateMagnificPrompt") as any,
    getCharacter: fail("getCharacter") as any,
    getGenerations: fail("getGenerations") as any,
    getLoraByName: fail("getLoraByName") as any,
    getSetting: fail("getSetting") as any,
    saveGeneration: fail("saveGeneration") as any,
  };
}

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

// --- /api/edit (engine="pedit") ---

test("strip:edit-pedit — missing source_url returns 400", async () => {
  const { req, url } = buildPost("/api/edit", {
    edit_prompt: "swap the dress for jeans",
    engine: "pedit",
  });
  const resp = await handleGenerationRoutes(req, url, genStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("source_url");
});

test("strip:edit-pedit — missing edit_prompt returns 400", async () => {
  const { req, url } = buildPost("/api/edit", {
    source_url: "http://example.com/p.png",
    engine: "pedit",
  });
  const resp = await handleGenerationRoutes(req, url, genStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("edit_prompt");
});

// --- /api/wear-garment (multi-image P-Edit) ---

test("strip:wear-garment — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/wear-garment", {
    garment_url: "https://example.com/dress.png",
  });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

test("strip:wear-garment — no garment refs at all returns 400", async () => {
  const { req, url } = buildPost("/api/wear-garment", {
    image_url: "https://example.com/me.png",
  });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("garment_url");
});

test("strip:wear-garment — non-array garment_urls falls back to garment_url path gracefully", async () => {
  // garment_urls is not an array → handler should treat it as if absent and
  // fall through to garment_url. With both missing, expect the same 400.
  const { req, url } = buildPost("/api/wear-garment", {
    image_url: "https://example.com/me.png",
    garment_urls: "not-an-array",
  });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  // Validation rejects: "at least one garment_url required"
  const body = await resp!.json();
  expect(body.error).toBeDefined();
});

// --- /api/optimize-pedit-prompt ---

test("strip:optimize-pedit-prompt — missing prompt returns 400", async () => {
  const { req, url } = buildPost("/api/optimize-pedit-prompt", { num_images: 1 });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("prompt");
});

test("strip:optimize-pedit-prompt — empty whitespace-only prompt rejected", async () => {
  const { req, url } = buildPost("/api/optimize-pedit-prompt", { prompt: "   \t\n  " });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("prompt");
});

// --- describe-wear-prompt (Grok 2-image prompt builder for P-Edit) ---

test("strip:describe-wear-prompt — missing image_url returns 400", async () => {
  const { req, url } = buildPost("/api/describe-wear-prompt", {
    garment_url: "https://example.com/dress.png",
  });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("image_url");
});

test("strip:describe-wear-prompt — missing garment_url returns 400", async () => {
  const { req, url } = buildPost("/api/describe-wear-prompt", {
    image_url: "https://example.com/me.png",
  });
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("garment_url");
});

// --- auth gate on the whole strip family ---

test("strip:wear-garment — missing auth returns 401 before body validation", async () => {
  const { req, url } = buildPost(
    "/api/wear-garment",
    { /* deliberately empty — should hit auth first */ },
    /* withAuth */ false,
  );
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(401);
  const body = await resp!.json();
  expect(body.error).toBe("unauthorized");
});
