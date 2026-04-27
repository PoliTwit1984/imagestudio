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
// Also exported:
//   - cubeToText(cube, title?) -> .cube text body (Adobe / DaVinci Resolve
//     standard). Walks cells in the same R-fastest, G-mid, B-slowest order
//     used by encodeHaldClut, which matches the .cube spec.
//   - cubeToXmp(cube, title?) -> simplified XMP/RDF document carrying the
//     cube as a base64-encoded float blob under a custom darkroom: namespace.
//     NOTE: real Lightroom Profile LookTable encoding is proprietary and is
//     not yet reverse-engineered. Lightroom users should import the .cube
//     output via "Add Profile" instead — Lightroom imports .cube natively.
//     The .xmp output is provided for round-trip / future-work reasons.
//
// Side effects: none. All functions allocate fresh buffers and return them.
//
// Failure behavior: throws if the cube length is wrong on encode, or if the
// decoded PNG is not 512x512 RGB on decode. The text/xmp exporters do not
// validate cube length (they read whatever is provided); callers are expected
// to pass a CUBE_FLOATS-length array.

import { randomUUID } from "node:crypto";
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

/**
 * Export a 33x33x33 RGB cube as a .cube file body (Adobe / DaVinci Resolve
 * standard, ASCII).
 *
 * Format:
 *   TITLE "<title>"
 *   LUT_3D_SIZE 33
 *   DOMAIN_MIN 0.0 0.0 0.0
 *   DOMAIN_MAX 1.0 1.0 1.0
 *   <blank>
 *   r g b   <- 35937 lines, R changes fastest, then G, then B
 *
 * Walk order matches encodeHaldClut + the identity-cube generator in
 * lut.test.ts (b-outer / g-middle / r-inner) so the exported file represents
 * the same color mapping the rest of the system uses.
 *
 * @param cube  Float32Array of length CUBE_FLOATS in [0, 1].
 * @param title human-readable title (gets put in the TITLE header).
 * @returns     UTF-8 text body (no trailing newline beyond the last cell).
 */
export function cubeToText(cube: Float32Array, title: string = "Darkroom Custom"): string {
  const safeTitle = title.replace(/"/g, "'");
  const parts: string[] = [];
  parts.push(`TITLE "${safeTitle}"`);
  parts.push(`LUT_3D_SIZE ${SIZE}`);
  parts.push(`DOMAIN_MIN 0.0 0.0 0.0`);
  parts.push(`DOMAIN_MAX 1.0 1.0 1.0`);
  parts.push("");

  for (let i = 0; i < CUBE_LEN; i++) {
    const off = i * 3;
    const r = cube[off + 0];
    const g = cube[off + 1];
    const b = cube[off + 2];
    parts.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`);
  }
  return parts.join("\n") + "\n";
}

/**
 * Export a 33x33x33 RGB cube as a simplified XMP/RDF document.
 *
 * SIMPLIFIED. Lightroom Profile (.xmp) files use a proprietary encoded
 * LookTable inside the crs: namespace; reverse-engineering that format is a
 * future task. For v1 we ship a self-describing XMP that carries the raw cube
 * floats as a base64-encoded little-endian Float32 blob under a custom
 * darkroom: namespace, plus a crs:LookName for human readability. Real
 * Lightroom users should import the .cube file via "Add Profile" — Lightroom
 * imports .cube natively.
 *
 * @param cube  Float32Array of length CUBE_FLOATS in [0, 1].
 * @param title profile name, written into crs:LookName.
 * @returns     UTF-8 XMP/RDF document, ready to drop on disk as <name>.xmp.
 */
export function cubeToXmp(cube: Float32Array, title: string = "Darkroom Custom"): string {
  // Pack cube as little-endian Float32 -> base64.
  const buf = Buffer.alloc(cube.length * 4);
  for (let i = 0; i < cube.length; i++) {
    buf.writeFloatLE(cube[i], i * 4);
  }
  const b64 = buf.toString("base64");
  const uuid = randomUUID();
  const safeTitle = escapeXml(title);

  return `<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Darkroom 1.0">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:darkroom="https://darkroom.app/lut/1.0"
      crs:Version="15.0"
      crs:LookName="${safeTitle}"
      darkroom:LutSize="${SIZE}"
      darkroom:UUID="${uuid}"
      darkroom:Encoding="float32-le-base64">
      <darkroom:Cube>${b64}</darkroom:Cube>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
