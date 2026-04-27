# Brush + Auto-Mask Recipe

A copy-pasteable recipe for the "Flux Fill (auto-mask)" engine inside Image
Studio. This is the flow you use when you have a porch photo and you want to
swap the top onto a silk crop tank from a reference URL while leaving the
face, jeans, and background alone. Everything below is grounded in
`src/server/routes/safe-edit.ts` — no aspirational APIs.

## What "Brush" actually is

"Brush" is the UI label for **Flux Fill Pro inpainting**, hosted on fal.ai at
`https://fal.run/fal-ai/flux-pro/v1/fill`. It is a mask-aware, NSFW-permissive
inpaint engine: you hand it a source image, a black/white mask (white = edit,
black = preserve), a text prompt, and optionally a Redux-style image
conditioning reference. Implementation lives in `callFluxFillPro` at
`src/server/routes/safe-edit.ts:2676`.

Two ways to drive it:

1. **Detail Brush picker** in the UI (`public/index.html:761`) — pre-tuned
   prompts and brush sizes, surgical region edits.
2. **Direct call to `POST /api/flux-edit`** (`src/server/routes/safe-edit.ts:144`)
   — the integration path documented here.

## What "auto-mask" means

Manual brush painting is one option. Auto-mask is the other: you let
**Grok Vision** look at the source, classify the garment from a reference
image, and return bounding boxes for the body region the garment will cover.
Those boxes get rasterized into a soft-edged white-on-black PNG mask.

Two endpoints expose this:

- `POST /api/auto-mask-garment` (`src/server/routes/safe-edit.ts:78,1398`) —
  classifier-driven. Give it the source + garment ref, get a mask back.
- `POST /api/flux-edit` — does the auto-mask step internally if you don't
  pass a `mask_b64`. Grok Vision is asked directly: "find the region the
  prompt is targeting" via `detectEditRegionsFromPrompt`
  (`src/server/routes/safe-edit.ts:253`).

For the porch / silk-crop-tank case, `POST /api/flux-edit` is the simpler
path — one call, mask happens server-side.

## The single-call recipe

```bash
curl -X POST "$BASE_URL/api/flux-edit" \
  -H "Authorization: Bearer $IMAGESTUDIO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "<source-image-url>",
    "prompt": "porch background, woman in jeans, replace top with silk crop tank from reference, keep face unchanged, photorealistic",
    "garment_urls": ["<silk-crop-tank-reference-url>"]
  }'
```

What the server does (`handleFluxEdit`, `src/server/routes/safe-edit.ts:156`):

1. Downloads `image_url`, reads dimensions via sharp.
2. No `mask_b64` provided → calls `detectEditRegionsFromPrompt` to ask Grok
   Vision where in the image to edit. Returns one or more bounding boxes.
3. `rasterizeRegionsToMask` converts boxes to a white-on-black PNG, padded
   12% per side and blurred for soft edges
   (`src/server/routes/safe-edit.ts:1565`).
4. Uploads the mask to Supabase storage so fal.ai can fetch it via URL.
5. With one `garment_urls` entry, that URL is passed straight through as
   `image_prompt`. With multiple, they are collaged into a single image first.
6. Calls `callFluxFillPro` with `image_url`, `mask_url`, `prompt`,
   `image_prompt`, `image_prompt_strength: 0.6`, `num_inference_steps: 50`,
   `guidance_scale: 20`.
7. Runs `isImageBlankOrUniform` on the result — if fal.ai's silent content
   filter returned a black placeholder, the call returns 422 instead of a
   bad URL.
8. Uploads the final PNG and returns `{ ok, url, mask_url, mask_source, model }`.

## Two-step variant (manual mask review)

If you want to inspect the auto-mask before paying for the inpaint, split it:

```bash
# Step 1: get a mask
curl -X POST "$BASE_URL/api/auto-mask-garment" \
  -H "Authorization: Bearer $IMAGESTUDIO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "<source-image-url>",
    "garment_url": "<silk-crop-tank-reference-url>"
  }'
# → { ok, garment_type, regions, mask_b64, width, height }

# Step 2: pass the inspected mask back to the edit endpoint
curl -X POST "$BASE_URL/api/flux-edit" \
  -H "Authorization: Bearer $IMAGESTUDIO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "<source-image-url>",
    "prompt": "porch background, woman in jeans, replace top with silk crop tank from reference, keep face unchanged, photorealistic",
    "garment_urls": ["<silk-crop-tank-reference-url>"],
    "mask_b64": "<base64-png-from-step-1-without-the-data-url-prefix>"
  }'
```

The `mask_b64` field strips a `data:image/...;base64,` prefix automatically
(`src/server/routes/safe-edit.ts:167`), so you can pass either form.

## What success looks like

- Face, hair, jeans, hands, and porch setting unchanged from the source.
- The torso region is replaced with a silk crop tank that visibly resembles
  the reference (cut, color, fabric sheen) — `image_prompt` provides the
  Redux-style visual conditioning at strength 0.6.
- `mask_source` in the response equals `grok:1 region` (or similar). If it
  reads `manual`, you sent your own mask.

## Failure modes and gotchas

- **`image_prompt` URL must be publicly fetchable.** fal.ai pulls the URL
  itself; pre-signed S3 URLs work, behind-auth links do not.
- **Grok can fail to locate the region.** If
  `detectEditRegionsFromPrompt` returns zero regions, `/api/flux-edit`
  responds with `{ ok: false, error: "Grok Vision couldn't locate ..." }`.
  Fall back to the Detail Brush UI or pass a `mask_b64` manually.
- **Blank-result detection.** fal.ai's content moderation sometimes returns
  a uniform black PNG instead of erroring. `isImageBlankOrUniform`
  (`src/server/routes/safe-edit.ts:1001`) samples a 64x64 thumbnail and
  flags <0.5% pixel variance. When triggered, the endpoint returns 422 with
  a hint to try a more permissive engine.
- **`guidance_scale` is hardcoded to 20** in `callFluxFillPro`
  (`src/server/routes/safe-edit.ts:2690`). That is the upper end of useful
  guidance for Flux Fill Pro; do not raise it without changing the source.
- **`num_inference_steps` is 50.** Same place. Lower steps = faster but
  noisier seams along the mask edge.
- **Mask polarity:** white = edit, black = preserve. Faces, hands, jeans,
  background must be black in the mask. The auto-mask flow is asked
  explicitly to exclude face/neck/hands/feet/background
  (`src/server/routes/safe-edit.ts:1531`), but verify with the two-step
  variant when the source has tricky framing.
- **Multiple garment refs collage automatically.** Pass two or more URLs in
  `garment_urls` and the server collages them into a single image before
  setting `image_prompt` (`src/server/routes/safe-edit.ts:211`). Useful for
  combining a top reference with a fabric-detail close-up.
- **Auth.** Every route in `handleSafeEditRoutes` runs `checkAuth(req)` and
  returns 401 without a valid bearer token
  (`src/server/routes/safe-edit.ts:38`).
