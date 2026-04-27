# Darkroom v1 Feature Audit

Code-grounded evaluation of three ambiguous Darkroom v1 surface features.

- **Audit commit:** `b4155c04af1dd15f8ac391b2d4c908bf4463a5ef`
- **Files inspected:** `src/server/routes/safe-edit.ts`, `public/index.html`, `PLAN.md`
- **Method:** read each handler + its caller + every helper it touches; no
  speculation. Cross-referenced against `PLAN.md` "Audit needed" list (lines
  329–332).
- **Recommendation tally:** 1 keep, 1 rename, 1 remove.

---

## 1. Auto-mask from Garment

### Where it lives

- **Server route:** `src/server/routes/safe-edit.ts:78-81` (POST
  `/api/auto-mask-garment`) → `handleAutoMaskGarment` at
  `src/server/routes/safe-edit.ts:1398`.
- **Helpers:** `classifyGarmentWithGrok`
  (`src/server/routes/safe-edit.ts:1450`), `detectGarmentRegionsWithGrok`
  (`src/server/routes/safe-edit.ts:1500`), `rasterizeRegionsToMask`
  (`src/server/routes/safe-edit.ts:1565`).
- **UI trigger:** `public/index.html:995` — button `#mask-automask-btn`
  labeled **"Auto-mask from Garment"** in the Painter modal, calls
  `runAutoMask()` defined at `public/index.html:2100`.

### What it claims to do

Header comment at `safe-edit.ts:1387-1396`:

> 1. Grok Vision classifies the garment (if URL given) → garment_type
> 2. Grok Vision finds the body region(s) on the source image that the garment
>    will cover, returns normalized bounding boxes.
> 3. Returns a soft white-on-black mask PNG (data URL) sized to the source.
>
> The painter modal pre-fills its foreground canvas with this mask so the user
> can refine before inpaint.

UI tooltip (`index.html:995`): "Grok Vision classifies the garment, then
auto-paints the body region where it would go. You can refine with brush/erase."

### What it actually does

Implementation matches the claim line-for-line:

1. POSTs garment URL to xAI `grok-4-1-fast-non-reasoning` with a tight
   system prompt that returns one lowercase word from a fixed allowlist
   (`bra | panty | bodysuit | teddy | lingerie_set | robe | dress | top |
   bottom | swimsuit | other`). Defaults to `lingerie_set` on failure
   (`safe-edit.ts:1450-1484`).
2. Loads source image with `sharp`, captures W/H.
3. Calls Grok Vision again with a hint string from `GARMENT_REGION_HINTS`
   (`safe-edit.ts:1486-1498`) instructing it to return normalized
   `{regions: [{label, box: {x,y,width,height}}]}` JSON. Strips fences,
   parses, clamps to 0–1.
4. Rasterizes boxes to a white-on-black PNG, pads 12%, blurs by
   `min(W,H)*0.012`, threshold 60 — soft-feathered oval-ish blobs, not hard
   rectangles (`safe-edit.ts:1565-1597`).
5. Returns base64 data URL + region metadata.

UI side, `runAutoMask()` (`index.html:2100-2130`) loads the data URL into the
Painter foreground canvas via `drawImage` so the user can refine with the
brush. Empty-region case toasts "No region detected" cleanly.

### Known issues

- No `TODO`/`FIXME`/`HACK` markers in or around the handler or caller.
- Error path is graceful: 400 on missing `image_url`, falls through to
  `lingerie_set` if classification fails, returns `{ok:false, error}` with a
  user-friendly "Paint manually" message if Grok finds zero regions.
- PLAN.md:330 explicitly lists this as an "Audit needed: does it land?
  compare side-by-side with Place Overlay" — i.e. the worry is **quality of
  the predicted region**, not whether the code path works. The plumbing is
  sound.
- Minor: relies on Grok returning valid JSON; if Grok wraps in fences, the
  cleaner strips them (`safe-edit.ts:1545`). If Grok hallucinates the schema,
  the filter at `:1550` drops malformed rows silently.
- Confirmed in PLAN.md:1305 as a working / shipped feature
  (`[x] Auto-mask from Garment`).

### Recommendation

**`keep`**

Working code, working name, working UI label. The doubt expressed in PLAN.md
is about output quality vs. Place Overlay, not pipeline correctness.

### Action item

Open task: spike a side-by-side comparison of "Auto-mask from Garment" vs
"Place Overlay" on the same source+garment pairs and decide if both
co-exist in v1 or if one wraps the other.

---

## 2. Surgical Edit

### Where it lives

- **Server route:** `src/server/routes/safe-edit.ts:58-61` (POST
  `/api/surgical-edit`) → `handleSurgicalEdit` at
  `src/server/routes/safe-edit.ts:2235`. Body type `SurgicalEditBody` at
  `src/server/routes/safe-edit.ts:1908`.
- **Helpers:** `detectAndBuildMask`
  (`src/server/routes/safe-edit.ts:2427`), `maskToGptInpaintFormat`
  (`src/server/routes/safe-edit.ts:2544`), `callGptImage2EditWithBuffers`,
  `invertMaskForFluxFill`, `callFluxFillPro`, `callTopaz`.
- **UI trigger:** `public/index.html:1087` — button `#surgical-edit-btn`
  labeled **"🎯 Surgical Edit (preserve subject)"**, calls `surgicalEdit()`
  defined at `public/index.html:3138`.

### What it claims to do

Header comment at `safe-edit.ts:2227-2233`:

> Joe's actual pipeline:
>   1. Detect NSFW regions (or use manual mask)
>   2. Composite white over those regions to sanitize the source
>   3. Send sanitized image + preserve-mask + edit prompt to gpt-image-2
>   4. Composite the ORIGINAL NSFW pixels back over the gpt-image-2 result
>   5. (Optional) Topaz upscale

UI tooltip (`index.html:1087`): "Auto-detect NSFW regions → mask them out →
gpt-image-2 edits everything else → composite original NSFW pixels back.
Surgical preservation. Falls back to Flux Fill Pro if gpt-image-2 refuses."

### What it actually does

Implementation matches the comment, end-to-end (`safe-edit.ts:2235-2421`):

- Step 1: fetch source bytes, capture W/H.
- Step 2: build preserve mask — either from `manual_mask_url` or from
  `detectAndBuildMask` which calls Grok Vision with an NSFW-region prompt
  (`safe-edit.ts:2427-2536`) and rasterizes white rectangles on a black
  canvas. Optional `feather` blur.
- Step 3: composite a pure-white RGBA overlay (mask as alpha) over the
  original to "sanitize" before sending to OpenAI.
- Step 4: convert preserve mask to gpt-image-2 inpaint format (transparent =
  editable).
- Step 5: try `callGptImage2EditWithBuffers`. On any throw, capture
  `gptError` and continue.
- Step 6: if gpt-image-2 returned nothing, upload sanitized image + inverted
  mask to Supabase and call `callFluxFillPro` instead.
- Step 7: composite ORIGINAL pixels back over the edit using the preserve
  mask as alpha — guarantees pixel identity in the masked region.
- Step 8: optional Topaz pass, save generation, return URL + stages.

### Known issues

- No `TODO`/`FIXME`/`HACK` in this section.
- **PLAN.md:331 calls this out explicitly:** *"Surgical Edit — broken in
  practice; replaced by Flux Fill auto-mask (rename or remove)."* Joe has
  already declared the practical experience here.
- Functional concerns visible in code:
  1. **Reliance on Grok Vision's NSFW classifier.** When `detectAndBuildMask`
     returns zero regions (`safe-edit.ts:2485-2492`), the preserve mask is
     all-black, which means **nothing is preserved** — gpt-image-2 will edit
     everything and the "surgical" promise collapses to a regular
     gpt-image-2 edit. No detection of this degenerate case.
  2. **gpt-image-2 will refuse anything visibly NSFW** even after the
     white-overlay sanitization, because the residual context (pose,
     framing) is enough for OpenAI's safety. The Flux Fill fallback then
     runs — but Flux Fill is doing inpainting on a **whited-out** image,
     which is a much harder task than direct inpaint and explains the
     "broken in practice" verdict.
  3. The "composite original pixels back" step (Step 7) is correct in theory
     but only meaningful if the mask actually corresponds to NSFW regions.
     With a noisy Grok classifier, the preserved region drifts.
- The header label `🎯 Surgical Edit (preserve subject)` survives in the UI
  even though the *Detail Brush* path (line 761) and the Painter
  Inpaint+Auto-mask path are now the actual surgical-region workflow.
- Cosmetic dirt: `PLAN.md:1276-1278` notes the `surgical-` filename prefix
  in `uploadBufferToStorage` is hardcoded for non-surgical callers — minor
  but indicates this code path was the original "surgical" namespace owner.

### Recommendation

**`remove`**

PLAN.md already says "broken in practice; replaced by Flux Fill auto-mask."
The white-overlay sanitization trick doesn't reliably get past gpt-image-2,
the Flux Fill fallback does worse work than running Flux Fill directly on
the unsanitized source through `/api/inpaint`, and the UI now has Detail
Brush + Painter (Brush + Auto-mask) covering the same use case more cleanly.

If "remove" is too aggressive: rename to `Sanitized GPT Edit (experimental)`,
hide behind a power-user flag, and stop advertising it as the headline edit
button.

### Action item

Open task: rip out the `🎯 Surgical Edit` button from `public/index.html`
and the `/api/surgical-edit` handler + helpers from `safe-edit.ts`; verify
nothing else imports `handleSurgicalEdit`, `detectAndBuildMask`,
`maskToGptInpaintFormat`, `callGptImage2EditWithBuffers`, or
`invertMaskForFluxFill` before deleting. Update PLAN.md:331 to mark done.

---

## 3. Auto-describe (Garment)

### Where it lives

- **Server route:** `src/server/routes/safe-edit.ts:88-91` (POST
  `/api/describe-garment`) → `handleDescribeGarment` at
  `src/server/routes/safe-edit.ts:1277`.
- **UI trigger:** `public/index.html:975` — button `#mask-describe-btn`
  labeled **"Auto-describe"** in the Painter modal, calls
  `autoDescribeGarment()` at `public/index.html:2972`. Also auto-fires from
  `runInpaint()` (`index.html:2996-3006`) when the user has a garment ref but
  no prompt.

### What it claims to do

UI tooltip (`index.html:975`): "Grok Vision writes a one-line prompt from the
garment image. Auto-runs on Inpaint if prompt is empty."

System prompt to Grok (`safe-edit.ts:1295`): "You write short, vivid prompts
for an AI inpainting model. The prompt will be paired with a garment
reference image (Redux conditioning). Output ONE sentence describing the
garment AS IF the woman in the source image is wearing it. Include color,
fabric, cut, and key detail. End with: 'photorealistic skin texture, soft
natural lighting'. No quotes, no preamble, no markdown."

### What it actually does

Implementation (`safe-edit.ts:1277-1318`):

1. Validates `garment_url` (400 on missing).
2. POSTs to xAI `grok-4-1-fast-non-reasoning` with the system prompt above
   plus the garment image as `image_url` content.
3. Strips wrapping quotes, errors on empty response, returns
   `{ok:true, prompt: <description>}`.

UI: `autoDescribeGarment` (`index.html:2972-2994`) sets the result into
`#mask-prompt`, returns the string so callers can chain. `runInpaint` calls
it when no prompt is typed but a garment ref exists; the result feeds into
the Flux Fill Pro inpaint call.

### Known issues

- No `TODO`/`FIXME`/`HACK` near the handler.
- PLAN.md:332 says: *"Auto-describe — useful as opt-in, kill from automatic
  critical paths (already done for Wear)."* — i.e. the **handler is fine**,
  but the **auto-fire-when-prompt-empty behavior** in `runInpaint`
  (`index.html:3001-3005`) is the part Joe wants gone from critical paths.
  Calling it as an explicit user action via the Auto-describe button is
  considered useful.
- The description it produces is paired with Flux Fill Pro Redux
  conditioning, which is the documented use case, so the system prompt is
  contextually correct.
- Failure mode: Grok occasionally wraps in quotes (handled,
  `safe-edit.ts:1312`), or returns markdown despite the no-markdown
  instruction (not handled — would be passed through verbatim).
- Naming nit: the route is `/api/describe-garment` (singular intent), the UI
  button is "Auto-describe", and the function is `autoDescribeGarment`.
  Consistent enough but the UI label loses the "garment" qualifier — fine
  inside the Painter modal where context is clear, ambiguous if reused
  elsewhere.

### Recommendation

**`rename`**

The feature works; the issue is **labeling and where it auto-fires**:

1. UI button label is fine **inside the Painter modal** but should not
   appear elsewhere without "from Garment Ref" qualifier.
2. Internal function `autoDescribeGarment` is good; keep.
3. Server route name `/api/describe-garment` is good; keep.
4. **The real change:** stop auto-calling it from `runInpaint` (PLAN.md:332
   directive). Make Auto-describe a strictly opt-in user action — like
   `runAutoMask`. Same code path, change the call site behavior.

If a literal "rename" is needed for the doc requirement: rename the UI label
from **"Auto-describe"** to **"Auto-describe Garment"** to make the scope
explicit (the button sits next to a garment-ref input, but the label drift
into other places risks confusion).

### Action item

Open task: (a) remove the auto-fire from `runInpaint` at
`public/index.html:3001-3005` so the user must press Auto-describe
explicitly, and (b) rename the UI button text from "Auto-describe" to
"Auto-describe Garment" at `public/index.html:975`. No server changes.

---

## Summary table

| Feature                 | Status                          | Recommendation | Why                                                                                                  |
| ----------------------- | ------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| Auto-mask from Garment  | works, plumbing sound           | `keep`         | Two Grok calls + sharp rasterize; output goes to Painter canvas; PLAN already lists as shipped       |
| Surgical Edit           | broken in practice (Joe's note) | `remove`       | White-overlay sanitization rarely passes gpt-image-2; Flux Fill fallback inferior to direct inpaint  |
| Auto-describe (Garment) | works as feature, misuse path   | `rename`       | Handler is fine; kill the auto-fire from `runInpaint`, label as "Auto-describe Garment" for clarity  |

## Cross-references

- PLAN.md:329–332 — "Audit needed" list confirming all three features
  flagged exactly here.
- PLAN.md:1276–1278 — `surgical-` filename prefix cosmetic dirt to clean up
  alongside surgical removal.
- PLAN.md:1305 — Auto-mask listed as shipped/`[x]`.
