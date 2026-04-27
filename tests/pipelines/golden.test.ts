// Functional tests for the golden pipeline orchestration endpoint.
//
// Per `project_image_studio_api.md` (memory reference, March 31): a single
// POST /api/pipeline endpoint should orchestrate the full pipeline:
//   generate (Flux LoRA) → Topaz (Bloom Realism) → skin enhancer
// and return a single { image_url, ... } response.
//
// CURRENT STATE: that consolidated route is not yet wired in this worktree's
// dispatcher. The component routes /api/generate, /api/topaz, /api/upscale,
// /api/enhancor, /api/darkroom-skin all exist independently. The single-call
// /api/pipeline does not.
//
// Tests below:
//   - Document the absence of /api/pipeline ([FOLLOWUP] marker) so the
//     scaffold is in place when the route lands.
//   - Verify the dispatcher correctly returns null (delegation contract) for
//     /api/pipeline today, so no other handler accidentally claims the path.
//   - Stub assertions for auth gate, missing prompt, and response shape — to
//     be replaced with real checks when the route is implemented.

import { test, expect, beforeAll } from "bun:test";
import { handleSafeEditRoutes } from "../../src/server/routes/safe-edit";
import { handleGenerationRoutes } from "../../src/server/routes/generation";
import { handleMediaRoutes } from "../../src/server/routes/media";

const TEST_TOKEN = "test-token-golden";

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

function mediaStubDeps() {
  const fail = (name: string) => () => {
    throw new Error(`unexpected dep call: ${name}`);
  };
  return {
    ALLOWED_UPLOAD_FOLDERS: new Set<string>(["uploads"]) as any,
    saveGeneration: fail("saveGeneration") as any,
    getCharacter: fail("getCharacter") as any,
  };
}

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
// /api/pipeline — golden pipeline single-call endpoint
// =============================================================================

test("[FOLLOWUP] /api/pipeline route not yet implemented in dispatcher", async () => {
  // When the consolidated golden-pipeline route lands, replace the body of
  // this test with the full assertions:
  //   1. auth gate returns 401 without bearer
  //   2. missing prompt returns 400 with error body
  //   3. valid request returns 200 with { image_url: string, ... }
  //
  // For now: assert that NONE of the existing route handlers claim /api/pipeline
  // (delegation contract) so we know the slot is empty and ready.
  const { req, url } = buildPost("/api/pipeline", {
    prompt: "luna in a leather jacket, magenta hair, dim bar light",
  });
  const safeResp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(safeResp).toBeNull();

  const { req: req2, url: url2 } = buildPost("/api/pipeline", {
    prompt: "luna in a leather jacket, magenta hair, dim bar light",
  });
  const genResp = await handleGenerationRoutes(req2, url2, genStubDeps());
  expect(genResp).toBeNull();

  const { req: req3, url: url3 } = buildPost("/api/pipeline", {
    prompt: "luna in a leather jacket, magenta hair, dim bar light",
  });
  const mediaResp = await handleMediaRoutes(req3, url3, mediaStubDeps());
  expect(mediaResp).toBeNull();
});

test("[FOLLOWUP] /api/pipeline auth gate — assertion deferred until route lands", () => {
  // Placeholder asserting test scaffold is wired. Replace with:
  //   const { req, url } = buildPost("/api/pipeline", { prompt: "x" }, false);
  //   const resp = await handle<X>Routes(req, url, deps());
  //   expect(resp!.status).toBe(401);
  expect(true).toBe(true);
});

test("[FOLLOWUP] /api/pipeline missing prompt — assertion deferred until route lands", () => {
  // Placeholder. Replace with a 400 assertion when the route is implemented.
  expect(true).toBe(true);
});

test("[FOLLOWUP] /api/pipeline response shape { image_url, ... } — deferred", () => {
  // Placeholder. Replace with structural shape check on the success response.
  expect(true).toBe(true);
});

// =============================================================================
// Component-route smoke tests — these DO exist today and represent the
// individual stages the golden pipeline orchestrates. Verify their auth gates
// hold so the eventual /api/pipeline can compose them safely.
// =============================================================================

test("golden:component /api/generate — auth gate triggers without bearer", async () => {
  const { req, url } = buildPost(
    "/api/generate",
    { prompt: "luna in leather" },
    /* withAuth */ false,
  );
  const resp = await handleGenerationRoutes(req, url, genStubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
});

test("golden:component /api/topaz — auth gate triggers without bearer", async () => {
  const { req, url } = buildPost(
    "/api/topaz",
    { image_url: "https://example.com/x.png" },
    /* withAuth */ false,
  );
  const resp = await handleMediaRoutes(req, url, mediaStubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
});

test("golden:component /api/darkroom-skin — auth gate triggers without bearer", async () => {
  const { req, url } = buildPost(
    "/api/darkroom-skin",
    { image_url: "https://example.com/x.png" },
    /* withAuth */ false,
  );
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
});

// --- delegation contract ---

test("golden — non-pipeline non-matching path returns null on every handler", async () => {
  const url = new URL("http://localhost:3000/api/__golden_nonexistent__");
  const req = new Request(url.toString(), { method: "POST" });

  const safeResp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(safeResp).toBeNull();

  const genResp = await handleGenerationRoutes(req, url, genStubDeps());
  expect(genResp).toBeNull();

  const mediaResp = await handleMediaRoutes(req, url, mediaStubDeps());
  expect(mediaResp).toBeNull();
});
