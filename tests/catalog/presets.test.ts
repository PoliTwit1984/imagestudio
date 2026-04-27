// Functional tests for the presets CRUD routes (wave 10).
//
// Endpoints covered:
//   GET    /api/presets               — list (with preset_type / category / featured filters)
//   POST   /api/presets               — create (name + slug + preset_type required)
//   GET    /api/presets/:slug         — fetch by slug, 404 if missing
//   PATCH  /api/presets/:id           — update mutable fields, reject immutable ones
//   DELETE /api/presets/:id           — soft-delete (sets archived=true)
//
// Tests focus on input validation contract — the immutable-field guard, the
// preset_type whitelist, and the soft-delete behavior. Network fetches are
// mocked when a test needs to exercise post-validation paths.

import { test, expect, beforeAll, afterEach } from "bun:test";
import { handleSafeEditRoutes } from "../../src/server/routes/safe-edit";

const TEST_TOKEN = "test-token-presets";

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

function buildJson(
  method: string,
  path: string,
  body?: any,
  withAuth = true,
): { req: Request; url: URL } {
  const url = new URL(`http://localhost:3000${path}`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (withAuth) headers["Authorization"] = `Bearer ${TEST_TOKEN}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return { req: new Request(url.toString(), init), url };
}

// ----- GET /api/presets — auth + filter validation -----

test("presets GET — auth gate triggers without bearer", async () => {
  const url = new URL("http://localhost:3000/api/presets");
  const req = new Request(url.toString(), { method: "GET" });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
});

test("presets GET — invalid preset_type filter returns 400", async () => {
  const { req, url } = buildJson("GET", "/api/presets?preset_type=cheese");
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("preset_type");
});

test("presets GET — empty list returns { items: [], count: 0 }", async () => {
  globalThis.fetch = (async () =>
    new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as any;

  const { req, url } = buildJson("GET", "/api/presets");
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(Array.isArray(body.items)).toBe(true);
  expect(body.count).toBe(0);
});

// ----- POST /api/presets — required fields -----

test("presets POST — missing name returns 400", async () => {
  const { req, url } = buildJson("POST", "/api/presets", {
    slug: "darkroom-glow",
    preset_type: "lut",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("name");
});

test("presets POST — missing slug returns 400", async () => {
  const { req, url } = buildJson("POST", "/api/presets", {
    name: "Glow",
    preset_type: "lut",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("slug");
});

test("presets POST — missing preset_type returns 400", async () => {
  const { req, url } = buildJson("POST", "/api/presets", {
    name: "Glow",
    slug: "darkroom-glow",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("preset_type");
});

test("presets POST — invalid preset_type returns 400 listing valid values", async () => {
  const { req, url } = buildJson("POST", "/api/presets", {
    name: "Glow",
    slug: "darkroom-glow",
    preset_type: "filter", // not in {engine_config, lut, chain}
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.field).toBe("preset_type");
  // Error message lists the valid values for caller debugging
  expect(String(body.error)).toContain("engine_config");
  expect(String(body.error)).toContain("lut");
  expect(String(body.error)).toContain("chain");
});

test("presets POST — unparseable JSON body returns 400", async () => {
  const url = new URL("http://localhost:3000/api/presets");
  const req = new Request(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: "{ not json",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.error).toBe("invalid_json_body");
});

test("presets POST — slug conflict (PG 23505) returns 409", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        code: "23505",
        message: "duplicate key value violates unique constraint",
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    )) as any;

  const { req, url } = buildJson("POST", "/api/presets", {
    name: "Glow",
    slug: "existing-slug",
    preset_type: "lut",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(409);
  const body = await resp!.json();
  expect(body.error).toBe("slug_conflict");
  expect(body.field).toBe("slug");
});

// ----- PATCH /api/presets/:id — immutable-field guard -----

test("presets PATCH — slug in body rejected as immutable_field", async () => {
  const { req, url } = buildJson(
    "PATCH",
    "/api/presets/22222222-2222-2222-2222-222222222222",
    { slug: "renamed-slug" },
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.error).toBe("immutable_field");
  expect(String(body.detail)).toContain("slug");
});

test("presets PATCH — preset_type in body rejected as immutable_field", async () => {
  const { req, url } = buildJson(
    "PATCH",
    "/api/presets/22222222-2222-2222-2222-222222222222",
    { preset_type: "chain" },
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.error).toBe("immutable_field");
  expect(String(body.detail)).toContain("preset_type");
});

test("presets PATCH — is_system in body rejected as immutable_field", async () => {
  const { req, url } = buildJson(
    "PATCH",
    "/api/presets/22222222-2222-2222-2222-222222222222",
    { is_system: false },
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.error).toBe("immutable_field");
});

test("presets PATCH — body with only unknown fields returns no_mutable_fields_provided", async () => {
  // Body is a valid object but no whitelisted PATCH key — the updated_at
  // timestamp is the only thing that ends up in `updates`, which is treated
  // as "nothing to do".
  const { req, url } = buildJson(
    "PATCH",
    "/api/presets/22222222-2222-2222-2222-222222222222",
    { totally_unknown_field: "x" },
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.error).toBe("no_mutable_fields_provided");
});

test("presets PATCH — empty body returns invalid_json_body 400", async () => {
  const url = new URL("http://localhost:3000/api/presets/22222222-2222-2222-2222-222222222222");
  const req = new Request(url.toString(), {
    method: "PATCH",
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

// ----- DELETE /api/presets/:id — soft-delete contract -----

test("presets DELETE — sends archived=true PATCH (soft delete)", async () => {
  let captured: { url?: string; init?: any } = {};
  globalThis.fetch = (async (url: any, init?: any) => {
    captured.url = String(url);
    captured.init = init;
    // Echo the patched archived row back so handler gets a non-empty array.
    return new Response(
      JSON.stringify([
        {
          id: "22222222-2222-2222-2222-222222222222",
          archived: true,
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;

  const { req, url } = buildJson(
    "DELETE",
    "/api/presets/22222222-2222-2222-2222-222222222222",
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(body.ok).toBe(true);
  expect(body.id).toBe("22222222-2222-2222-2222-222222222222");
  // PATCH method (soft-delete pattern), with archived: true in the body.
  expect(captured.init?.method).toBe("PATCH");
  expect(String(captured.init?.body || "")).toContain('"archived":true');
});

test("presets DELETE — supabase returning empty array → 404", async () => {
  globalThis.fetch = (async () =>
    new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as any;

  const { req, url } = buildJson(
    "DELETE",
    "/api/presets/33333333-3333-3333-3333-333333333333",
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(404);
  const body = await resp!.json();
  expect(body.error).toBe("not_found");
});

// ----- GET /api/presets/:slug -----

test("presets GET by slug — 404 when no rows returned", async () => {
  globalThis.fetch = (async () =>
    new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as any;

  const { req, url } = buildJson("GET", "/api/presets/no-such-slug");
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(404);
  const body = await resp!.json();
  expect(body.error).toBe("not_found");
  expect(body.slug).toBe("no-such-slug");
});

test("presets GET by slug — returns row on hit", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        { id: "33333333-3333-3333-3333-333333333333", slug: "darkroom-glow", name: "Glow" },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as any;

  const { req, url } = buildJson("GET", "/api/presets/darkroom-glow");
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(body.slug).toBe("darkroom-glow");
});
