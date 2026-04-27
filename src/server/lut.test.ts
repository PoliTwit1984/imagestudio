// Round-trip tests for the Hald-CLUT primitives.
//
// Goal: encode(cube) -> decode(png) must reproduce the cube within 1/255 + a
// small float-rounding epsilon. We test both the identity cube (R, G, B grow
// monotonically) and an inverted cube (1 - identity) to ensure we're not
// accidentally relying on monotonic data.

import { test, expect } from "bun:test";
import {
  encodeHaldClut,
  decodeHaldClut,
  SIZE,
  CUBE_LEN,
  CUBE_FLOATS,
} from "./lut";

const EPS = 1 / 255 + 1e-6;

function makeIdentityCube(): Float32Array {
  const cube = new Float32Array(CUBE_FLOATS);
  let i = 0;
  for (let b = 0; b < SIZE; b++) {
    for (let g = 0; g < SIZE; g++) {
      for (let r = 0; r < SIZE; r++) {
        cube[i++] = r / (SIZE - 1);
        cube[i++] = g / (SIZE - 1);
        cube[i++] = b / (SIZE - 1);
      }
    }
  }
  return cube;
}

function makeInvertedCube(): Float32Array {
  const id = makeIdentityCube();
  const out = new Float32Array(id.length);
  for (let i = 0; i < id.length; i++) out[i] = 1 - id[i];
  return out;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

test("round-trip identity cube within 1/255 epsilon", async () => {
  const cube = makeIdentityCube();
  expect(cube.length).toBe(CUBE_FLOATS);
  expect(CUBE_LEN).toBe(35937);

  const png = await encodeHaldClut(cube);
  expect(png.length).toBeGreaterThan(0);
  // PNG magic bytes
  expect(png[0]).toBe(0x89);
  expect(png[1]).toBe(0x50);
  expect(png[2]).toBe(0x4e);
  expect(png[3]).toBe(0x47);

  const decoded = await decodeHaldClut(png);
  expect(decoded.length).toBe(cube.length);
  expect(maxAbsDiff(cube, decoded)).toBeLessThanOrEqual(EPS);
});

test("round-trip inverted cube within 1/255 epsilon", async () => {
  const cube = makeInvertedCube();
  const png = await encodeHaldClut(cube);
  const decoded = await decodeHaldClut(png);
  expect(maxAbsDiff(cube, decoded)).toBeLessThanOrEqual(EPS);
});
