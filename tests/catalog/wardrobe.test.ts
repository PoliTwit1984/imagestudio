// Functional tests for the wardrobe catalog routes (waves 16, 18, 22).
//
// Endpoints covered:
//   GET    /api/wardrobe                  — list wardrobe rows (joined to assets)
//   POST   /api/wardrobe                  — create a wardrobe row from an asset_id
//   POST   /api/wardrobe/forge            — upload/from_image/generate dispatch
//   POST   /api/wardrobe/:id/angles       — add a non-front angle to an existing row
//
// Tests focus on input-validation contract — auth gate, required-field errors,
// invalid-mode errors, and the deferred 'generate' path returning 501. Network
// fetches to Supabase are mocked via globalThis.fetch when a test path needs to
// reach beyond the validation layer.
//
// No live API calls — every test either short-circuits on validation or
// stubs fetch to return a shaped fake response.

import { test, expect, beforeAll, afterEach } from "bun:test";
import { handleSafeEditRoutes } from "../../src/server/routes/safe-edit";

const TEST_TOKEN = "test-token-wardrobe";

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

function buildGet(path: string, withAuth = true): { req: Request; url: URL } {
  const url = new URL(`http://localhost:3000${path}`);
  const headers: Record<string, string> = {};
  if (withAuth) headers["Authorization"] = `Bearer ${TEST_TOKEN}`;
  const req = new Request(url.toString(), { method: "GET", headers });
  return { req, url };
}

// --- POST /api/wardrobe — auth + validation ---

test("wardrobe POST — missing Authorization header returns 401", async () => {
  const { req, url } = buildPost(
    "/api/wardrobe",
    { asset_id: "00000000-0000-0000-0000-000000000001", category: "top" },
    /* withAuth */ false,
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
  const body = await resp!.json();
  expect(body.error).toBe("unauthorized");
});

test("wardrobe POST — missing asset_id returns 400", async () => {
  const { req, url } = buildPost("/api/wardrobe", { category: "top" });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("asset_id");
  expect(body.field).toBe("asset_id");
});

test("wardrobe POST — missing category returns 400", async () => {
  const { req, url } = buildPost("/api/wardrobe", {
    asset_id: "00000000-0000-0000-0000-000000000001",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("category");
  expect(body.field).toBe("category");
});

test("wardrobe POST — empty body returns 400 with invalid_json_body", async () => {
  // Build a request with a literal empty body to force parser into the catch
  // branch. The handler treats null / non-object bodies as invalid JSON.
  const url = new URL("http://localhost:3000/api/wardrobe");
  const req = new Request(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: "",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.error).toBe("invalid_json_body");
});

test("wardrobe POST — FK violation on missing asset row surfaces as 422", async () => {
  // Mock supabase POST to return a 23503 (foreign key violation) — handler
  // upgrades that into a friendlier 422 with field=asset_id.
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        code: "23503",
        message: 'insert or update on table "wardrobe" violates foreign key constraint',
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    )) as any;

  const { req, url } = buildPost("/api/wardrobe", {
    asset_id: "11111111-1111-1111-1111-111111111111",
    category: "top",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(422);
  const body = await resp!.json();
  expect(body.error).toBe("asset_not_found");
  expect(body.field).toBe("asset_id");
});

// --- GET /api/wardrobe — auth + shape ---

test("wardrobe GET — auth gate triggers without bearer", async () => {
  const { req, url } = buildGet("/api/wardrobe", false);
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
});

test("wardrobe GET — empty list returns { items: [], count: 0 }", async () => {
  // PostgREST returns [] for an empty table — handler short-circuits before
  // the assets-enrichment fetch and returns the empty shape.
  globalThis.fetch = (async () =>
    new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) as any;

  const { req, url } = buildGet("/api/wardrobe");
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(Array.isArray(body.items)).toBe(true);
  expect(body.items.length).toBe(0);
  expect(body.count).toBe(0);
});

// --- POST /api/wardrobe/forge — mode validation ---

test("forge — missing mode returns 400", async () => {
  const { req, url } = buildPost("/api/wardrobe/forge", {});
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("mode");
  expect(body.field).toBe("mode");
});

test("forge — mode='generate' returns 501 (deferred future feature)", async () => {
  const { req, url } = buildPost("/api/wardrobe/forge", { mode: "generate" });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(501);
  const body = await resp!.json();
  expect(body.mode).toBe("generate");
  expect(String(body.error).toLowerCase()).toContain("generate");
});

test("forge — unknown mode returns 400", async () => {
  const { req, url } = buildPost("/api/wardrobe/forge", { mode: "nonsense" });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("mode");
});

test("forge — mode='upload' missing asset_url returns 400", async () => {
  const { req, url } = buildPost("/api/wardrobe/forge", {
    mode: "upload",
    category: "top",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("asset_url");
  expect(body.field).toBe("asset_url");
});

test("forge — mode='from_image' missing source_url returns 400", async () => {
  const { req, url } = buildPost("/api/wardrobe/forge", {
    mode: "from_image",
    category: "top",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error).toLowerCase()).toContain("source_url");
  expect(body.field).toBe("source_url");
});

test("forge — front angle without category returns 400", async () => {
  const { req, url } = buildPost("/api/wardrobe/forge", {
    mode: "upload",
    asset_url: "https://example.com/garment.png",
    // angle defaults to "front"; category required for front-path
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("category");
});

test("forge — non-front angle without wardrobe_id returns 400", async () => {
  const { req, url } = buildPost("/api/wardrobe/forge", {
    mode: "upload",
    asset_url: "https://example.com/garment.png",
    angle: "back",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("wardrobe_id");
});

test("forge — invalid angle name returns 400", async () => {
  const { req, url } = buildPost("/api/wardrobe/forge", {
    mode: "upload",
    asset_url: "https://example.com/garment.png",
    category: "top",
    angle: "above",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("angle");
});

// --- /api/wardrobe/:id/angles — angle add validation ---

test("wardrobe angles POST — missing angle field returns 400", async () => {
  const { req, url } = buildPost(
    "/api/wardrobe/00000000-0000-0000-0000-000000000abc/angles",
    { asset_url: "https://example.com/back.png" },
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("angle");
});

test("wardrobe angles POST — missing asset_url returns 400", async () => {
  const { req, url } = buildPost(
    "/api/wardrobe/00000000-0000-0000-0000-000000000abc/angles",
    { angle: "back" },
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("asset_url");
});

test("wardrobe angles DELETE — rejects 'front' (cannot delete canonical view)", async () => {
  const url = new URL(
    "http://localhost:3000/api/wardrobe/00000000-0000-0000-0000-000000000abc/angles/front",
  );
  const req = new Request(url.toString(), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TEST_TOKEN}` },
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("angle");
});

test("wardrobe angles DELETE — rejects unknown angle key with 400", async () => {
  const url = new URL(
    "http://localhost:3000/api/wardrobe/00000000-0000-0000-0000-000000000abc/angles/upsidedown",
  );
  const req = new Request(url.toString(), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TEST_TOKEN}` },
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("angle");
});
