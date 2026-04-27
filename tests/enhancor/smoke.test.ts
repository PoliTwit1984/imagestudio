// tests/enhancor/smoke.test.ts
//
// Purpose:  Per-engine smoke tests for the Enhancor API wrapper.
//           Submits a known-good payload to each of the 7 typed wrappers,
//           mocks fetch, and verifies that the correct URL is hit and that
//           the returned requestId matches what the mock returned.
//
// Engines tested (7):
//   skin            → POST /api/realistic-skin/v1/queue
//   lens            → POST /api/kora/v1/queue          (model=kora_pro)
//   lensCinema      → POST /api/kora/v1/queue          (model=kora_pro_cinema)
//   lensReality     → POST /api/kora-reality/v1/queue
//   develop         → POST /api/detailed/v1/queue
//   sharpenPortrait → POST /api/upscaler/v1/queue
//   sharpen         → POST /api/image-upscaler/v1/queue
//
// Mocking:   globalThis.fetch is replaced per test; restored via afterEach.
// Inputs:    ENHANCOR_API_KEY env var is set to a stub value so getApiKey()
//            does not throw.
// Outputs:   No real HTTP calls; no side effects.
// Failure:   If the BASE_URL or path template in enhancor.ts changes,
//            update the expectedUrl assertions below accordingly.

import { test, expect, describe, afterEach, beforeAll } from "bun:test";
import {
  skin,
  lens,
  lensCinema,
  lensReality,
  develop,
  sharpenPortrait,
  sharpen,
} from "../../src/server/enhancor";

// ---------------------------------------------------------------------------
// Setup: provide a stub API key so getApiKey() in enhancor.ts does not throw.
// ---------------------------------------------------------------------------
beforeAll(() => {
  process.env.ENHANCOR_API_KEY = "test-key-smoke";
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Helper: build a fetch mock that returns { success: true, requestId } and
//         captures the URL + body that were passed to it.
// ---------------------------------------------------------------------------
type FetchCapture = {
  url: string;
  body: Record<string, unknown>;
};

function buildFetchMock(
  engine: string
): { mock: typeof fetch; captured: FetchCapture } {
  const captured: FetchCapture = { url: "", body: {} };

  const mock = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    captured.url = typeof input === "string" ? input : input.toString();
    captured.body = JSON.parse((init?.body as string) ?? "{}");

    return new Response(
      JSON.stringify({ success: true, requestId: `test-req-${engine}` }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }) as typeof fetch;

  return { mock, captured };
}

// ---------------------------------------------------------------------------
// Engine 1: skin (realistic-skin)
// ---------------------------------------------------------------------------
describe("smoke: skin", () => {
  test("hits /api/realistic-skin/v1/queue and returns requestId", async () => {
    const { mock, captured } = buildFetchMock("skin");
    globalThis.fetch = mock;

    const result = await skin({ img_url: "https://example.com/photo.jpg" });

    expect(result.requestId).toBe("test-req-skin");
    expect(captured.url).toBe(
      "https://apireq.enhancor.ai/api/realistic-skin/v1/queue"
    );
    expect(captured.body.img_url).toBe("https://example.com/photo.jpg");
  });
});

// ---------------------------------------------------------------------------
// Engine 2: lens (kora_pro)
// ---------------------------------------------------------------------------
describe("smoke: lens", () => {
  test("hits /api/kora/v1/queue with model=kora_pro and returns requestId", async () => {
    const { mock, captured } = buildFetchMock("lens");
    globalThis.fetch = mock;

    const result = await lens({ prompt: "cinematic portrait" });

    expect(result.requestId).toBe("test-req-lens");
    expect(captured.url).toBe("https://apireq.enhancor.ai/api/kora/v1/queue");
    expect(captured.body.model).toBe("kora_pro");
    expect(captured.body.prompt).toBe("cinematic portrait");
  });
});

// ---------------------------------------------------------------------------
// Engine 3: lensCinema (kora_pro_cinema)
// ---------------------------------------------------------------------------
describe("smoke: lensCinema", () => {
  test("hits /api/kora/v1/queue with model=kora_pro_cinema and returns requestId", async () => {
    const { mock, captured } = buildFetchMock("lensCinema");
    globalThis.fetch = mock;

    const result = await lensCinema({ prompt: "cinematic wide shot" });

    expect(result.requestId).toBe("test-req-lensCinema");
    expect(captured.url).toBe("https://apireq.enhancor.ai/api/kora/v1/queue");
    expect(captured.body.model).toBe("kora_pro_cinema");
    expect(captured.body.prompt).toBe("cinematic wide shot");
  });
});

// ---------------------------------------------------------------------------
// Engine 4: lensReality (kora-reality)
// ---------------------------------------------------------------------------
describe("smoke: lensReality", () => {
  test("hits /api/kora-reality/v1/queue and returns requestId", async () => {
    const { mock, captured } = buildFetchMock("lensReality");
    globalThis.fetch = mock;

    const result = await lensReality({ prompt: "hyperreal portrait" });

    expect(result.requestId).toBe("test-req-lensReality");
    expect(captured.url).toBe(
      "https://apireq.enhancor.ai/api/kora-reality/v1/queue"
    );
    expect(captured.body.prompt).toBe("hyperreal portrait");
  });
});

// ---------------------------------------------------------------------------
// Engine 5: develop (detailed)
// ---------------------------------------------------------------------------
describe("smoke: develop", () => {
  test("hits /api/detailed/v1/queue and returns requestId", async () => {
    const { mock, captured } = buildFetchMock("develop");
    globalThis.fetch = mock;

    const result = await develop({ img_url: "https://example.com/raw.jpg" });

    expect(result.requestId).toBe("test-req-develop");
    expect(captured.url).toBe(
      "https://apireq.enhancor.ai/api/detailed/v1/queue"
    );
    expect(captured.body.img_url).toBe("https://example.com/raw.jpg");
  });
});

// ---------------------------------------------------------------------------
// Engine 6: sharpenPortrait (upscaler)
// ---------------------------------------------------------------------------
describe("smoke: sharpenPortrait", () => {
  test("hits /api/upscaler/v1/queue and returns requestId", async () => {
    const { mock, captured } = buildFetchMock("sharpenPortrait");
    globalThis.fetch = mock;

    const result = await sharpenPortrait({
      img_url: "https://example.com/portrait.jpg",
      mode: "professional",
    });

    expect(result.requestId).toBe("test-req-sharpenPortrait");
    expect(captured.url).toBe(
      "https://apireq.enhancor.ai/api/upscaler/v1/queue"
    );
    expect(captured.body.img_url).toBe("https://example.com/portrait.jpg");
    expect(captured.body.mode).toBe("professional");
  });
});

// ---------------------------------------------------------------------------
// Engine 7: sharpen (image-upscaler)
// ---------------------------------------------------------------------------
describe("smoke: sharpen", () => {
  test("hits /api/image-upscaler/v1/queue and returns requestId", async () => {
    const { mock, captured } = buildFetchMock("sharpen");
    globalThis.fetch = mock;

    const result = await sharpen({ img_url: "https://example.com/image.jpg" });

    expect(result.requestId).toBe("test-req-sharpen");
    expect(captured.url).toBe(
      "https://apireq.enhancor.ai/api/image-upscaler/v1/queue"
    );
    expect(captured.body.img_url).toBe("https://example.com/image.jpg");
  });
});
