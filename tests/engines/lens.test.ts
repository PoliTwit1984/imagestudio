// Functional tests for Lens — Grok img2img (PLAN.md house name).
//
// Lens is exposed via POST /api/edit with engine="grok" (the default).
// Tests cover: auth gate, missing source_url, missing edit_prompt.
// No live external API calls — every test short-circuits on input
// validation before the upstream fetch is attempted.

import { test, expect, beforeAll } from "bun:test";
import { handleGenerationRoutes } from "../../src/server/routes/generation";

const TEST_TOKEN = "test-token-lens";

// Auth bypass via BEARER_TOKEN — set at module load so checkAuth() picks it up.
beforeAll(() => {
  process.env.BEARER_TOKEN = TEST_TOKEN;
  process.env.DISABLE_AUTH = "";
});

// Minimal stub deps. Lens validation rejects before any of these are called,
// so every method just throws if accidentally invoked — that surfaces a
// regression where validation slipped past the early-return.
function stubDeps() {
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

function buildEditRequest(body: any, withAuth = true): { req: Request; url: URL } {
  const url = new URL("http://localhost:3000/api/edit");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (withAuth) headers["Authorization"] = `Bearer ${TEST_TOKEN}`;
  const req = new Request(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { req, url };
}

test("lens — auth gate triggers when missing Authorization header", async () => {
  const { req, url } = buildEditRequest(
    { source_url: "http://x.com/a.png", edit_prompt: "make it red", engine: "grok" },
    /* withAuth */ false,
  );
  const resp = await handleGenerationRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
  const body = await resp!.json();
  expect(body.error).toBe("unauthorized");
});

test("lens — missing source_url returns 400 with error", async () => {
  const { req, url } = buildEditRequest({ edit_prompt: "change background", engine: "grok" });
  const resp = await handleGenerationRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.error).toBeDefined();
  expect(String(body.error).toLowerCase()).toContain("source_url");
});

test("lens — missing edit_prompt returns 400 with error", async () => {
  const { req, url } = buildEditRequest({
    source_url: "http://example.com/a.png",
    engine: "grok",
  });
  const resp = await handleGenerationRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.error).toBeDefined();
  expect(String(body.error).toLowerCase()).toContain("edit_prompt");
});

test("lens — both source_url and edit_prompt empty rejected at 400", async () => {
  const { req, url } = buildEditRequest({ engine: "grok" });
  const resp = await handleGenerationRoutes(req, url, stubDeps());
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  // Either-message is acceptable; the contract is "this never reaches Grok"
  expect(body.error).toBeDefined();
});

test("lens — non-edit path on the route handler returns null (delegation contract)", async () => {
  // /api/something-else should fall through this handler returning null,
  // so the parent multiplexer can try the next handler. This guards the
  // "don't accidentally claim every URL" contract.
  const url = new URL("http://localhost:3000/api/this-is-not-edit");
  const req = new Request(url.toString(), { method: "POST" });
  const resp = await handleGenerationRoutes(req, url, stubDeps());
  expect(resp).toBeNull();
});
