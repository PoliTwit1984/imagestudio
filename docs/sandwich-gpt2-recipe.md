# Sandwich (P-Edit → GPT-2 → P-Edit) Recipe

A copy-pasteable recipe for the **Sandwich** edit engine inside Image Studio.
This is the flow you use when the source is too explicit for OpenAI
`gpt-image-2` (or fal.ai Nano Banana) to touch directly, but you still want
those engines' compositional reasoning (outfit swaps, hand fixes, structured
scene changes). Everything below is grounded in
`src/server/routes/safe-edit.ts` — no aspirational APIs.

## What "Sandwich" actually is

Three-pass pipeline that wraps a moderation-strict edit engine in two
NSFW-permissive P-Edit passes. Implementation: `handleSandwichEdit`
(`safe-edit.ts:1614`). Middle engine is selectable:

- `edit_engine: "gpt"` → `callGptImage2Edit` (`safe-edit.ts:2016`) hitting
  `https://api.openai.com/v1/images/edits` with model `gpt-image-2`.
- `edit_engine: "nano"` (default) → `callNanoBanana` (`safe-edit.ts:2066`)
  hitting `https://fal.run/fal-ai/nano-banana/edit` (Gemini 2.5 Flash Image).

Both bookend passes use `callPEdit` (`safe-edit.ts:2091`) — Replicate's
`prunaai/p-image-edit` with `disable_safety_checker: true`. Doesn't refuse
on the explicit source, doesn't refuse on the cover-up reversal.

## Endpoint

```text
POST /api/sandwich-edit
Authorization: <session cookie / dev token — see checkAuth>
Content-Type: application/json
```

Route registration: `safe-edit.ts:80`. Auth gate: `checkAuth(req)` on the
same line — same gate as every other `/api/*` editor route.

## Request shape

Derived from `handleSandwichEdit` (`safe-edit.ts:1619-1628`):

```json
{
  "image_url":       "https://.../source.png",
  "edit_prompt":     "change the t-shirt to a red leather jacket, keep face/jeans/setting unchanged",
  "edit_engine":     "gpt",
  "upscaler":        "none",
  "clothe_prompt":   "Add a simple plain black tank top and shorts to the subject. Keep everything else identical.",
  "unclothe_prompt": "Remove the tank top and shorts. Restore the subject's original nude appearance. Keep everything else identical."
}
```

Required: `image_url`, `edit_prompt` (else `400`). `edit_engine` defaults to
`"nano"`. `upscaler` is `"topaz"` | `"freepik"` | `"none"` (default
`"none"`). `clothe_prompt` / `unclothe_prompt` have sane defaults — only
override when the tank-top / shorts cover-up doesn't fit the source.

## The three internal calls

In order, from `safe-edit.ts:1630-1647`:

1. **Pass 1 — Clothe** (`safe-edit.ts:1631`). `callPEdit({ imageUrl, prompt: clothePrompt })`.
   Replicate `prunaai/p-image-edit`. Returns a Replicate-hosted URL of the
   source with a tank top + shorts painted on, identity preserved. This URL
   is the **input to Pass 2**, not stored back into Supabase yet.
2. **Pass 2 — Edit** (`safe-edit.ts:1635-1644`). Either
   `callGptImage2Edit({ imageUrl: clothedUrl, prompt: editPrompt, size: "2048x2048", quality: "high" })`
   or `callNanoBanana({ imageUrl: clothedUrl, prompt: editPrompt })`.
   gpt-image-2 sees a fully-SFW input (the clothed Pass-1 output), so the
   moderation layer doesn't trip. Returns either a base64 payload that's
   re-uploaded to Supabase via `uploadBase64ToSupabase`
   (`safe-edit.ts:2058`), or a fal.ai-hosted URL.
3. **Pass 3 — Unclothe** (`safe-edit.ts:1647`).
   `callPEdit({ imageUrl: editedUrl, prompt: unclothePrompt })`. Strips the
   tank top + shorts back off the Pass-2 output, restoring the original
   nude/explicit framing — but with the structural edit (red jacket, fixed
   hand, swapped backdrop) baked into the now-lower-half of the image and
   carrying through.

Optional Pass 4 is the upscaler (`safe-edit.ts:1649-1653`): Topaz Bloom
(`callTopaz`, `safe-edit.ts:2186`) or Freepik skin enhancer
(`callFreepikSkinEnhancer`, `safe-edit.ts:2222`).

## Where each pass's output goes

- Pass 1: Replicate CDN URL from `callPEdit`. Not persisted; returned as
  `clothed_url` for debugging.
- Pass 2: gpt-image-2 returns base64 → re-uploaded to Supabase via
  `uploadBase64ToSupabase` (`safe-edit.ts:2058`). Nano Banana returns a
  fal.ai-hosted URL directly. Surfaced as `edited_url`, fed into Pass 3.
- Pass 3: Replicate P-Edit URL. Becomes `image_url` if no upscaler runs.
- Final URL persisted via `deps.saveGeneration` with
  `engine: "sandwich-<edit_engine>[+upscaler]"` and prompt tag
  `[sandwich:gpt]` / `[sandwich:nano]` (`safe-edit.ts:1655-1661`).

## Response shape

```json
{
  "ok":          true,
  "image_url":   "https://<supabase>/.../sandwich-final.png",
  "clothed_url": "https://replicate.delivery/.../pass1.png",
  "edited_url":  "https://<supabase|fal>/.../pass2.png",
  "model":       "sandwich (pedit → gpt → pedit) + topaz"
}
```

## Concrete recipe — topless porch → red leather jacket

Source: topless porch image. Goal: subject in a red leather jacket.
`gpt-image-2` refuses directly on the bare-chest source.

```bash
curl -X POST https://<host>/api/sandwich-edit \
  -H "Content-Type: application/json" \
  -H "Cookie: <session>" \
  -d '{
    "image_url":   "https://.../porch-topless.png",
    "edit_prompt": "change the tank top to a red leather jacket with silver zipper, keep face/jeans/porch background unchanged",
    "edit_engine": "gpt",
    "upscaler":    "topaz"
  }'
```

- Pass 1 (P-Edit, default cover-up): plain black tank + shorts on same porch.
- Pass 2 (gpt-image-2, `2048x2048`, `quality: high`): tank → red leather
  jacket. gpt-image-2 reasons about drape, zipper, leather lighting. Input
  is SFW so moderation passes.
- Pass 3 (P-Edit, default reversal): tank + shorts removed; jacket stays.
  Result: topless porch image with red leather jacket open over chest,
  original face / jeans / porch intact.
- Pass 4 (Topaz Bloom Realism): upscale + skin pass.

If Pass 2 still refuses (cover-up reads as suggestive — low neckline, wet,
etc.), drop to `"edit_engine": "nano"`. Nano Banana has a softer moderation
layer for the middle pass.

## Failure modes

Errors `handleSandwichEdit` and its helpers surface:

- **Missing inputs.** `400 image_url required` / `400 edit_prompt required`
  (`safe-edit.ts:1627-1628`).
- **Pass 1 / Pass 3 — P-Edit fails.** `callPEdit` throws
  `P-Edit <status>: <body>` (`safe-edit.ts:2114-2117`) or
  `P-Edit failed: <reason>` (`safe-edit.ts:2120-2122`). Bubbles up as
  `500 { error }` from the route's `catch`.
- **Pass 2 — refusal / error.** `callGptImage2Edit` throws
  `gpt-image-2 <status>: <body>` (`safe-edit.ts:2046`); `callNanoBanana`
  throws `Nano Banana <status>: <body>` (`safe-edit.ts:2082-2083`).
  `handleSandwichEdit` does NOT auto-fallback (unlike `/api/smart-edit`'s
  classifier at `safe-edit.ts:1970-1974`) — it just throws. If Pass 2
  refuses on the *clothed* image, the cover-up wasn't conservative enough.
  Override `clothe_prompt` with longer sleeves / higher neckline.
- **No image returned.** `gpt-image-2 returned no image`
  (`safe-edit.ts:2056`) or `Nano Banana returned no image`
  (`safe-edit.ts:2087`).
- **Blank-output detection: NOT WIRED on Sandwich.** Inpaint
  (`safe-edit.ts:1794`) and Darkroom (`safe-edit.ts:974`) call
  `isImageBlankOrUniform` (`safe-edit.ts:1008`) to catch fal.ai's silent
  black-frame moderation. Sandwich does not — if Nano Banana silently
  moderates Pass 2 to a black frame, the unclothe pass runs on black and
  outputs near-uniform garbage. Treat any near-black `edited_url` as a
  moderation hit, not a bug.
- **Storage / save errors.** `deps.saveGeneration` is wrapped in
  `try/catch {}` (`safe-edit.ts:1655-1661`) — save failure doesn't fail
  the request, but the result won't appear in the gallery.

## When NOT to use Sandwich

- **Pure NSFW generation / transform.** Use `/api/make-nsfw`
  (`safe-edit.ts:2133`) — one P-Edit + upscaler, no three-pass overhead.
- **Mask-aware region edits.** Use `/api/inpaint` (`safe-edit.ts:1723`) or
  `/api/flux-edit` (`safe-edit.ts:163`). Flux Fill Pro is NSFW-permissive
  in one call.
- **Identity-locked NSFW restyle.** Use `/api/darkroom-skin`
  (`safe-edit.ts:1032`) — Grok PRO i2i.
- **Already SFW source.** Skip bookends. `/api/smart-edit`
  (`safe-edit.ts:1893`) hits gpt-image-2 directly with auto-fallback.

Sandwich is for the narrow case where (a) the source is too explicit for
gpt-image-2 / Nano Banana to accept, AND (b) you specifically need their
compositional reasoning over P-Edit's freer but less structurally precise
output. Otherwise use a simpler endpoint.
