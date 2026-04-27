// Hald-CLUT format primitives for Darkroom.
//
// Encodes a 33x33x33 RGB cube (Float32 in [0,1]) as a 512x512 8-bit PNG and
// decodes it back. Layout is sequential row-major: cube cell index i in
// [0, 35937) writes to pixel (i % 512, i / 512). Cells are walked in B-outer,
// G-middle, R-inner order to match the standard Hald-CLUT convention.
//
// Inputs:
//   - encodeHaldClut(cube): cube length must be 33*33*33*3 = 107811 floats
//     in [0, 1].
//   - decodeHaldClut(png): 512x512 PNG buffer (any color space sharp can
//     normalize to RGB).
//
// Outputs:
//   - encode -> Buffer (512x512 RGB PNG, 8-bit).
//   - decode -> Float32Array of length 107811 with values in [0, 1].
//
// Side effects: none. Both functions allocate fresh buffers and return them.
//
// Failure behavior: throws if the cube length is wrong on encode, or if the
// decoded PNG is not 512x512 RGB on decode.

import sharp from "sharp";

export const SIZE = 33;
export const CUBE_LEN = SIZE * SIZE * SIZE; // 35937 cells
export const CUBE_FLOATS = CUBE_LEN * 3; // 107811 RGB values
export const PNG_DIM = 512;
export const PNG_PIXELS = PNG_DIM * PNG_DIM; // 262144

/**
 * Encode a 33x33x33 RGB cube as a 512x512 PNG (Hald-CLUT layout).
 *
 * @param cube Float32Array of length 107811 (35937 cells * 3 channels) with
 *             values in [0, 1]. Cells are expected in B-outer/G-middle/R-inner
 *             order (matches the identity-cube generator in lut.test.ts).
 * @returns PNG buffer, 512x512 RGB, 8-bit.
 */
export async function encodeHaldClut(cube: Float32Array): Promise<Buffer> {
  if (cube.length !== CUBE_FLOATS) {
    throw new Error(
      `encodeHaldClut: expected cube length ${CUBE_FLOATS}, got ${cube.length}`,
    );
  }

  const raw = Buffer.alloc(PNG_PIXELS * 3); // zero-filled tail beyond cell 35937

  for (let i = 0; i < CUBE_LEN; i++) {
    const r = cube[i * 3 + 0];
    const g = cube[i * 3 + 1];
    const b = cube[i * 3 + 2];
    const off = i * 3;
    raw[off + 0] = quantize(r);
    raw[off + 1] = quantize(g);
    raw[off + 2] = quantize(b);
  }

  return await sharp(raw, {
    raw: { width: PNG_DIM, height: PNG_DIM, channels: 3 },
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

/**
 * Decode a 512x512 Hald-CLUT PNG back into a 33x33x33 RGB cube.
 *
 * @param png PNG buffer produced by encodeHaldClut (or any 512x512 RGB image
 *            whose first 35937 pixels carry the cube payload).
 * @returns Float32Array of length 107811 with values in [0, 1].
 */
export async function decodeHaldClut(png: Buffer): Promise<Float32Array> {
  const img = sharp(png).removeAlpha().toColorspace("srgb");
  const { data, info } = await img
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== PNG_DIM || info.height !== PNG_DIM) {
    throw new Error(
      `decodeHaldClut: expected ${PNG_DIM}x${PNG_DIM} PNG, got ${info.width}x${info.height}`,
    );
  }
  if (info.channels !== 3) {
    throw new Error(
      `decodeHaldClut: expected 3 channels, got ${info.channels}`,
    );
  }

  const cube = new Float32Array(CUBE_FLOATS);
  for (let i = 0; i < CUBE_LEN; i++) {
    const off = i * 3;
    cube[off + 0] = data[off + 0] / 255;
    cube[off + 1] = data[off + 1] / 255;
    cube[off + 2] = data[off + 2] / 255;
  }
  return cube;
}

function quantize(v: number): number {
  // Clamp to [0, 1] then round-half-up to nearest 1/255 step.
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  return Math.round(v * 255);
}
