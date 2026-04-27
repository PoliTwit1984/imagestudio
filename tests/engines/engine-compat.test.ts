// Functional tests for the engine compatibility map and detail-brush registry.
//
// These two endpoints are pure data — no upstream API calls — so they make
// for high-confidence integration tests of the route handler shape.
//
//   GET /api/engine-compatibility — static map of (engine × content_profile)
//   GET /api/detail-brushes        — public catalog of detail brushes

import { test, expect, beforeAll } from "bun:test";
import { handleSafeEditRoutes } from "../../src/server/routes/safe-edit";

const TEST_TOKEN = "test-token-compat";
const HOUSE_ENGINES = ["lens", "glance", "strip", "brush", "eye", "frame", "skin", "blend", "lock"];

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

function buildGet(path: string, withAuth = true): { req: Request; url: URL } {
  const url = new URL(`http://localhost:3000${path}`);
  const headers: Record<string, string> = {};
  if (withAuth) headers["Authorization"] = `Bearer ${TEST_TOKEN}`;
  const req = new Request(url.toString(), { method: "GET", headers });
  return { req, url };
}

// --- engine-compatibility ---

test("engine-compat — auth gate triggers without bearer", async () => {
  const { req, url } = buildGet("/api/engine-compatibility", false);
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(401);
});

test("engine-compat — returns 200 with full engine map", async () => {
  const { req, url } = buildGet("/api/engine-compatibility");
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();

  expect(body.schema_version).toBe(1);
  expect(Array.isArray(body.content_profiles)).toBe(true);
  expect(body.content_profiles).toEqual(["sfw", "nsfw_topless"]);
  expect(Array.isArray(body.verdicts)).toBe(true);
  expect(body.verdicts).toEqual(["likely", "may-refuse", "will-refuse"]);
  expect(typeof body.engines).toBe("object");
});

test("engine-compat — every house engine present in PLAN.md §1.3 list", async () => {
  const { req, url } = buildGet("/api/engine-compatibility");
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  const body = await resp!.json();
  for (const eng of HOUSE_ENGINES) {
    expect(body.engines[eng]).toBeDefined();
    expect(typeof body.engines[eng]).toBe("object");
  }
});

test("engine-compat — every (engine, profile) pair has a known verdict", async () => {
  const { req, url } = buildGet("/api/engine-compatibility");
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  const body = await resp!.json();
  const validVerdicts = new Set(body.verdicts);
  for (const [engine, verdicts] of Object.entries(body.engines)) {
    for (const profile of body.content_profiles) {
      const v = (verdicts as any)[profile];
      expect(validVerdicts.has(v)).toBe(true);
    }
  }
});

test("engine-compat — eye and frame both will-refuse on nsfw_topless", async () => {
  // Spec invariant: gpt-image-2 (eye) and Bria FIBO-edit (frame) refuse NSFW.
  // If this changes, it's a deliberate product change — test guards against
  // accidental drift.
  const { req, url } = buildGet("/api/engine-compatibility");
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  const body = await resp!.json();
  expect(body.engines.eye.nsfw_topless).toBe("will-refuse");
  expect(body.engines.frame.nsfw_topless).toBe("will-refuse");
});

// --- detail-brushes ---

test("detail-brushes — auth gate triggers without bearer", async () => {
  const { req, url } = buildGet("/api/detail-brushes", false);
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(401);
});

test("detail-brushes — returns 200 with non-empty brushes array", async () => {
  const { req, url } = buildGet("/api/detail-brushes");
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(Array.isArray(body.brushes)).toBe(true);
  expect(body.brushes.length).toBeGreaterThan(0);
});

test("detail-brushes — public catalog hides hidden 'prompt' field", async () => {
  // Critical IP guarantee: the underlying brush prompts NEVER leak through
  // the public endpoint. This test enforces that.
  const { req, url } = buildGet("/api/detail-brushes");
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  const body = await resp!.json();
  for (const brush of body.brushes) {
    expect(brush.prompt).toBeUndefined();
    // Spot-check the public shape
    expect(typeof brush.id).toBe("string");
    expect(typeof brush.name).toBe("string");
    expect(typeof brush.category).toBe("string");
    expect(typeof brush.description).toBe("string");
    expect(typeof brush.brush_size_px).toBe("number");
    expect(typeof brush.intensity_label).toBe("string");
  }
});

test("detail-brushes — exposes brushes across multiple categories", async () => {
  const { req, url } = buildGet("/api/detail-brushes");
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  const body = await resp!.json();
  const categories = new Set(body.brushes.map((b: any) => b.category));
  // Expect at least Anatomy and one other (Fabric/Lighting/Hair/Mood/Removal)
  expect(categories.has("Anatomy")).toBe(true);
  expect(categories.size).toBeGreaterThanOrEqual(2);
});

test("detail-brushes — brush ids are unique", async () => {
  const { req, url } = buildGet("/api/detail-brushes");
  const resp = await handleSafeEditRoutes(req, url, safeStubDeps());
  const body = await resp!.json();
  const ids = body.brushes.map((b: any) => b.id);
  expect(new Set(ids).size).toBe(ids.length);
});
