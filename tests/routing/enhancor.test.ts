// =============================================================================
// tests/routing/enhancor.test.ts
//
// Tests for pickEngine() and retryWithFallback() in src/server/routing.ts.
//
// Covers intent → engine mappings and fallback engine resolution.
// No live API calls — retryWithFallback's PostgREST log is fire-and-forget
// and the test verifies only the return value (fallback engine string).
// =============================================================================

import { test, expect, beforeAll } from "bun:test";
import { pickEngine, retryWithFallback } from "../../src/server/routing";

// Disable PostgREST calls in tests — no Supabase project in CI.
beforeAll(() => {
  delete process.env.SUPABASE_URL;
});

// ---------------------------------------------------------------------------
// pickEngine — intent → engine mapping
// ---------------------------------------------------------------------------

test("pickEngine — 'skin realism' maps to skin-pro", () => {
  const engine = pickEngine("skin realism");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("skin-pro");
});

test("pickEngine — 'make this skin look real' maps to skin-pro", () => {
  const engine = pickEngine("make this skin look real");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("skin-pro");
});

test("pickEngine — 'portrait' keyword maps to skin-pro", () => {
  const engine = pickEngine("portrait enhancement");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("skin-pro");
});

test("pickEngine — 'movie look' maps to lens-cinema", () => {
  const engine = pickEngine("movie look");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("lens-cinema");
});

test("pickEngine — 'cinematic' maps to lens-cinema", () => {
  const engine = pickEngine("cinematic");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("lens-cinema");
});

test("pickEngine — 'dramatic' maps to lens-cinema", () => {
  const engine = pickEngine("dramatic lighting");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("lens-cinema");
});

test("pickEngine — 'generate' (no modifier) maps to lens-pro", () => {
  const engine = pickEngine("generate");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("lens-pro");
});

test("pickEngine — 'realistic' maps to lens-reality", () => {
  const engine = pickEngine("realistic");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("lens-reality");
});

test("pickEngine — 'photorealism' maps to lens-reality", () => {
  const engine = pickEngine("photorealism rendering");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("lens-reality");
});

test("pickEngine — 'upscale' + portrait inputShape maps to sharpen-portrait", () => {
  const engine = pickEngine("upscale this image", "portrait");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("sharpen-portrait");
});

test("pickEngine — 'upscale' (general, no portrait) maps to sharpen", () => {
  const engine = pickEngine("upscale the photo");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("sharpen");
});

test("pickEngine — 'finish' maps to develop", () => {
  const engine = pickEngine("finish this");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("develop");
});

test("pickEngine — 'make it pop' maps to develop", () => {
  const engine = pickEngine("make it pop");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("develop");
});

test("pickEngine — 'cinematic finish' maps to develop (finish wins over cinematic)", () => {
  const engine = pickEngine("cinematic finish");
  expect(engine).not.toBeNull();
  expect(engine!.id).toBe("develop");
});

test("pickEngine — unrecognised intent returns null", () => {
  const engine = pickEngine("something completely unrelated");
  expect(engine).toBeNull();
});

test("pickEngine — empty string returns null", () => {
  const engine = pickEngine("");
  expect(engine).toBeNull();
});

// ---------------------------------------------------------------------------
// retryWithFallback — fallback engine resolution
// ---------------------------------------------------------------------------

test("retryWithFallback — skin-pro fails → topaz_skin", async () => {
  const fallback = await retryWithFallback("skin-pro", "portrait realism");
  expect(fallback).toBe("topaz_skin");
});

test("retryWithFallback — lens-pro fails → grok_image", async () => {
  const fallback = await retryWithFallback("lens-pro", "generate a scene");
  expect(fallback).toBe("grok_image");
});

test("retryWithFallback — lens-cinema fails → grok_image", async () => {
  const fallback = await retryWithFallback("lens-cinema", "cinematic shot");
  expect(fallback).toBe("grok_image");
});

test("retryWithFallback — lens-reality fails → grok_image", async () => {
  const fallback = await retryWithFallback("lens-reality", "photorealism");
  expect(fallback).toBe("grok_image");
});

test("retryWithFallback — develop fails → topaz_upscale", async () => {
  const fallback = await retryWithFallback("develop", "finish this");
  expect(fallback).toBe("topaz_upscale");
});

test("retryWithFallback — sharpen-portrait fails → topaz_upscale", async () => {
  const fallback = await retryWithFallback("sharpen-portrait", "upscale portrait", "portrait");
  expect(fallback).toBe("topaz_upscale");
});

test("retryWithFallback — sharpen fails → topaz_upscale", async () => {
  const fallback = await retryWithFallback("sharpen", "upscale image");
  expect(fallback).toBe("topaz_upscale");
});

test("retryWithFallback — unknown engine returns null", async () => {
  const fallback = await retryWithFallback("nonexistent-engine", "some intent");
  expect(fallback).toBeNull();
});
