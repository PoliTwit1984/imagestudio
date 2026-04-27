// Functional tests for /api/asset-chain (wave 27) and /api/replay-chain (wave 31).
//
// /api/asset-chain GET resolves an asset → walks parent_id up to root → BFS
// down through children. Used by the history-graph drawer in the UI.
//
// /api/replay-chain POST re-executes a saved edit chain on a new source URL,
// spawning an async job. We verify the synchronous validation contract — the
// route should reject without a chain_root_asset_id or new_source_url before
// it ever hits the job queue.
//
// Tests use globalThis.fetch override to mock Supabase PostgREST responses
// when a path needs to reach beyond the validation layer.

import { test, expect, beforeAll, afterEach } from "bun:test";
import { handleSafeEditRoutes } from "../../src/server/routes/safe-edit";

const TEST_TOKEN = "test-token-asset-chain";

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

function buildGet(path: string, withAuth = true): { req: Request; url: URL } {
  const url = new URL(`http://localhost:3000${path}`);
  const headers: Record<string, string> = {};
  if (withAuth) headers["Authorization"] = `Bearer ${TEST_TOKEN}`;
  const req = new Request(url.toString(), { method: "GET", headers });
  return { req, url };
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

// ----- /api/asset-chain — auth + required params -----

test("asset-chain GET — auth gate triggers without bearer", async () => {
  const { req, url } = buildGet("/api/asset-chain?id=00000000-0000-0000-0000-000000000001", false);
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
});

test("asset-chain GET — neither id nor source_url returns 400", async () => {
  const { req, url } = buildGet("/api/asset-chain");
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error)).toContain("id or source_url");
});

test("asset-chain GET — id resolves to no rows returns 404 'asset not found'", async () => {
  // Seed lookup returns an empty array — handler short-circuits with 404.
  globalThis.fetch = (async () =>
    new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as any;

  const { req, url } = buildGet("/api/asset-chain?id=99999999-9999-9999-9999-999999999999");
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(404);
  const body = await resp!.json();
  expect(body.error).toBe("asset not found");
});

test("asset-chain GET — root-only asset returns ok shape with seed and zero descendants", async () => {
  // Sequence:
  //   1. seed lookup    → return one row (no parent_id, no children)
  //   2. BFS down       → returns [] (no descendants)
  // Handler should produce: { ok, seed_id, root, nodes: [seed], ancestors_walked: 0, descendants_found: 0 }
  let call = 0;
  globalThis.fetch = (async (urlIn: any) => {
    call++;
    const u = String(urlIn);
    if (u.includes("rest/v1/assets") && call === 1) {
      // seed lookup
      return new Response(
        JSON.stringify([
          {
            id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            source_url: "https://example.com/seed.png",
            parent_id: null,
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // Subsequent BFS-down call: no children
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;

  const { req, url } = buildGet(
    "/api/asset-chain?id=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  // Shape contract from PLAN.md / wave 27
  expect(body.ok).toBe(true);
  expect(body.seed_id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  expect(body.root).toBeDefined();
  expect(Array.isArray(body.nodes)).toBe(true);
  expect(body.ancestors_walked).toBe(0);
  expect(body.descendants_found).toBe(0);
});

test("asset-chain GET — source_url query also resolves seed", async () => {
  // Same seed-only flow, but using source_url= rather than id=.
  globalThis.fetch = (async (urlIn: any) => {
    const u = String(urlIn);
    if (u.includes("source_url=eq.")) {
      return new Response(
        JSON.stringify([
          {
            id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            source_url: "https://example.com/x.png",
            parent_id: null,
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;

  const { req, url } = buildGet(
    "/api/asset-chain?source_url=https%3A%2F%2Fexample.com%2Fx.png",
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(200);
  const body = await resp!.json();
  expect(body.seed_id).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
});

test("asset-chain GET — supabase 5xx on seed lookup surfaces as 502", async () => {
  globalThis.fetch = (async () =>
    new Response("upstream broke", { status: 503 })) as any;

  const { req, url } = buildGet("/api/asset-chain?id=cccccccc-cccc-cccc-cccc-cccccccccccc");
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(502);
  const body = await resp!.json();
  expect(String(body.error)).toContain("seed lookup");
});

// ----- /api/replay-chain — synchronous validation -----

test("replay-chain POST — auth gate triggers without bearer", async () => {
  const { req, url } = buildPost(
    "/api/replay-chain",
    {
      chain_root_asset_id: "11111111-1111-1111-1111-111111111111",
      new_source_url: "https://example.com/new.png",
    },
    /* withAuth */ false,
  );
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(401);
});

test("replay-chain POST — missing chain_root_asset_id returns 400", async () => {
  const { req, url } = buildPost("/api/replay-chain", {
    new_source_url: "https://example.com/new.png",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error)).toContain("chain_root_asset_id");
});

test("replay-chain POST — missing new_source_url returns 400", async () => {
  const { req, url } = buildPost("/api/replay-chain", {
    chain_root_asset_id: "11111111-1111-1111-1111-111111111111",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error)).toContain("new_source_url");
});

test("replay-chain POST — unparseable JSON returns 400", async () => {
  const url = new URL("http://localhost:3000/api/replay-chain");
  const req = new Request(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: "{not-json",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(body.error).toBe("invalid_json_body");
});

test("replay-chain POST — chain with only root (no descendants) returns 400 with helpful error", async () => {
  // The handler resolves the chain synchronously before spawning a job,
  // and rejects an empty sequence with a 4xx so the user sees the failure
  // immediately rather than as a job-row failure.
  let call = 0;
  globalThis.fetch = (async (urlIn: any) => {
    call++;
    const u = String(urlIn);
    if (u.includes("rest/v1/assets") && call === 1) {
      // Root row exists.
      return new Response(
        JSON.stringify([
          { id: "11111111-1111-1111-1111-111111111111", parent_id: null },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // BFS-down returns no descendants → sequence has no edits.
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;

  const { req, url } = buildPost("/api/replay-chain", {
    chain_root_asset_id: "11111111-1111-1111-1111-111111111111",
    new_source_url: "https://example.com/new.png",
  });
  const resp = await handleSafeEditRoutes(req, url, stubDeps());
  expect(resp).not.toBeNull();
  expect(resp!.status).toBe(400);
  const body = await resp!.json();
  expect(String(body.error)).toContain("no edit steps");
  expect(body.chain_root_asset_id).toBe("11111111-1111-1111-1111-111111111111");
});
