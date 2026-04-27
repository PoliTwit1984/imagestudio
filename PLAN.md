# Darkroom — Build & Polish Plan

> **Working name:** Darkroom (formerly Image Studio / Voyeur)
> **Tagline candidates:** *"Develop in the dark." · "What they wouldn't print." · "The room with the red light."*
> **Current state:** functional NSFW-permissive multi-engine image editor running locally at `:3030` and in production at `studio.myfavoritehuman.app`. Pre-rebrand.

---

## NORTH STAR

Darkroom isn't *"a multi-engine image editor."* It is **a platform for building, sharing, and running image-AI workflows in plain English** — with the editor as the surface and the chain builder as the engine.

ComfyUI got the graph metaphor right and the labels wrong. Their nodes are model names. Darkroom's nodes are **outcomes**: *Generate · Wear Garment · Skin Pass · Make Wider · Restore Face · Upscale · Crop for IG.* Drag, connect, run, save, share, sell.

Adobe Lightroom presets are one-shot adjustments. Darkroom Chains are multi-stage AI pipelines. Same drag-drop accessibility, twenty times the value per chain.

**Three product pillars (in priority order):**

1. **Chains** *(THE moat — Phase 11)* — visual drag-drop workflow builder where each node is an outcome, not a model. Users build, save, share, and sell chains. House-built starter library. Every shipped chain feeds back into routing recommendations.
2. **Routing intelligence** *(the brain that powers Chains — Phase 3)* — content-aware engine recommendations, failure-mode handling, closed-loop learning from every edit shipped. Used both inside chains (auto-pick next stage) and standalone for one-off edits.
3. **Catalog** *(the persistence layer that makes 1+2 possible — Phase 1)* — every image, chain run, preset application, refusal, success, and outcome persisted forever. Powers chain replay, chain analytics, and the data that makes routing smarter.

**Beneath all three:** house-named engines (Lens, Glance, Strip, Brush, Eye, Frame, Develop, Skin, Crisp, Reveal, Lock, Restore, Sharpen, Cutout, Watch). Vendors (Grok, Pruna, fal.ai, Topaz, Enhancor, OpenAI, Replicate, BFL) are invisible.

**The competitor's problem:**
- Cloning Darkroom's schema → 1 day
- Cloning Darkroom's engine integrations → 1 week
- Cloning Darkroom's UI → 1 month
- Cloning Darkroom's routing intelligence → many months and millions of edits
- Cloning the **chain library + community chains + creator economy on top** → impossible without running Darkroom. **That's the moat.**

---

## DESIGN PRINCIPLES (load-bearing — apply to every screen, every API, every payload)

1. **Only surface what the user actually controls.** If a parameter is set internally (strength, steps, guidance_scale, model version, vendor, mask format, prompt template, system prompt, seed when not exposed, fallback chain, retry logic, etc.), it does NOT appear in the UI. The user sees the *choice*, not the *implementation*.

   Examples of what stays hidden:
   - Vendor names ("Grok", "fal.ai", "Pruna", "OpenAI", "Topaz", "Enhancor", "Magnific", "Bria", "BiRefNet")
   - Underlying model identifiers (`grok-imagine-image-pro`, `gpt-image-2`, `fal-ai/flux-pro/v1/fill`, etc.)
   - Generation parameters (steps, guidance_scale, scheduler, seed, num_inference_steps)
   - Mask formats, blend modes, threshold values, dilation amounts
   - Preset prompts and prompt strength internals
   - The fact that a single user click triggers a multi-call pipeline server-side
   - Provider error bodies (errors get translated to Darkroom-voiced messages)
   - Internal state (cached values, retry counts, queue position, fallback engines)
   - LoRA URLs, model versions, version numbers (unless intentionally exposed for power users in a future Studio tier)

   Examples of what users DO see:
   - House-named operations (Lens, Brush, Skin, Develop, Reveal)
   - Quality/intensity choices that map to internal strength values (low / medium / high — not "0.28")
   - Outcome-oriented options (aspect ratio, "send to Telegram", "make NSFW")
   - Credit cost (in credits, not in $0.0X cost-to-us)
   - Result history with house-language labels ("Darkroom Skin v1 applied" — never "grok img2img with prompt X")

2. **House voice in every label.** No vendor names, no technical jargon, no version numbers. If a user can't say it casually to a friend ("I ran it through Glance and finished with Develop"), it's named wrong.

3. **One control per decision.** If the user faces two controls that map to the same underlying decision, kill one. (Example: BASIC/PRO toggle exists because we exposed the vendor's pricing tiers; that's an internal cost decision, not a user decision — kill the toggle.)

4. **Failed operations don't leak the stack.** If Lens refuses on content, the user sees "This edit was declined — try Strip or Glance." Not "Grok API 400: Generated image rejected by content moderation."

5. **API responses follow the same rules.** Network tab inspection should never reveal the underlying model. Endpoints return `model: "darkroom-skin-v1"`, not `model: "grok-imagine-image-pro"`. Result URLs are re-hosted on our Supabase, not the vendor's CDN.

6. **Settings page only exposes what the user can change.** Hidden prompts (Darkroom presets) never appear there. User-editable system prompts can. The line is: if surfacing it lets a user copy/clone the IP, hide it.

---

## PHASE 0 — REBRAND

- [ ] Rename project: `imagestudio` → `darkroom` (codebase, repo, deploy, domain)
- [ ] Domain: register `darkroom.studio` (primary) — fall back to `darkroom.app` or `getdarkroom.com`
- [ ] Logo + favicon (single-color amber on warm-black, restrained typography)
- [ ] Replace all user-facing "Image Studio" references with "Darkroom"
- [ ] Update tagline + manifesto copy
- [ ] Engine renames (vendor-neutral house names — see ENGINE NAMING)

---

## ENGINE NAMING (Darkroom voice)

| Vendor reality | House name | One-line role |
|---|---|---|
| Grok img2img | **Lens** | Face-locked re-imagining, scene mood swap |
| Nano Banana (Gemini 2.5 Flash Image) | **Glance** | Fast scene swap, semi-permissive |
| P-Edit (Pruna Flux Kontext) | **Strip** | No filter, multi-image, NSFW-permissive |
| Flux Fill Pro | **Brush** | Surgical mask edits, NSFW-permissive |
| GPT-Image-2 | **Eye** | Highest fidelity, refuses suggestive |
| Bria fibo-edit | **Frame** | Composition-preserving |
| BiRefNet | **Cutout** | Background removal |
| Topaz Bloom Realism | **Develop** | Face/general detail, finishing |
| Enhancor realistic-skin | **Skin** | Pore-level body realism |
| Enhancor Crisp | **Crisp** | Pure detail/edge sharpening |
| Magnific (Freepik) | **Reveal** | Creative detail injection (mainstream) |
| SUPIR (Replicate) *(new)* | **Reveal Open** | NSFW-permissive creative upscale, no filter |
| Real-ESRGAN (Replicate) *(new)* | **Sharpen** | Cheap fast upscale, no hallucination |
| CodeFormer (Replicate) *(new)* | **Restore** | Face-only restoration when face goes soft |
| Smart (auto) | **Watch** | Auto-pick |
| fal.ai face-swap | **Lock** (Standard) | Pixel-precise face graft |
| InsightFace via Replicate *(new)* | **Lock** (Sharp) | Higher-fidelity face swap on tough cases |
| Pruna p-flux (txt2img) | **Spark** *(?)* | Fast compressed Flux txt2img |
| Plain Flux Dev (no LoRA) | **Plain** *(?)* | Pure Flux txt2img |

**TBD:** Spark vs other names. Confirm "Reveal" lands. Plain may not need a special name.

---

## PHASE 1 — CATALOG (the moat)

### 1.1 Schema migration (Supabase)

- [ ] Create `assets` table (replaces `generations` as universe)
  - Columns: id, user_id, url, thumbnail_url, w, h, asset_type, source, prompt, **parent_id**, **edit_action**, **edit_params (jsonb)**, metadata (jsonb), starred, archived, tags, created_at
- [ ] Create `wardrobe` (saved garments, raw + cutout pair)
- [ ] Create `presets` (house presets w/ hidden prompt + user presets)
- [ ] Create `projects` + `project_assets` (albums)
- [ ] Backfill existing `generations` rows into `assets`
- [ ] Keep `generations` as a view for backward compat; drop later

### 1.2 Backend — write to new schema

- [ ] Update every save path (generate, edit, surgical, inpaint, wear, sandwich, face-swap, makeNsfw, darkroom-skin, topaz, enhancor, magnific, blend) to write `assets` rows with `parent_id` + `edit_action` + `edit_params`
- [ ] Frontend `pushVersion()` already tracks parent → wire it as `parent_id` on every edit save

### 1.3 UI — catalog as first-class

- [ ] **History tab** rewrite: not a list, a graph (or at minimum a thread view per chain)
- [ ] **Edit history** drawer per asset — click any image in the result area, see full chain backward, click any node to load it
- [ ] **Star/archive** controls on every result
- [ ] **Tags** field on the result
- [ ] **Search** in History (by prompt, by date, by tag, by engine, by character)

### 1.4 Wardrobe (persistent garment library)

- [ ] Wardrobe tab in left sidebar
- [ ] Grid of saved garments (cutout thumbnails, click to expand, X to remove)
- [ ] Auto-save on Place Overlay or Wear via Brush use
- [ ] Drag from Wardrobe → drops onto canvas → triggers Place Overlay
- [ ] Garment metadata: name, tags, type (auto-classified via Lens vision), used_count
- [ ] Search/filter by garment type or tag

### 1.5 Replay edit chains (the killer feature, post-launch v1.1)

- [ ] Right-click any asset → **Copy edit chain**
- [ ] Right-click another asset → **Paste edit chain** → server replays the sequence
- [ ] Saved as a named chain → reusable "edit recipes" the user owns

---

## PHASE 2 — PRESETS

### 2.1 Preset system architecture

- [ ] `POST /api/preset/:name` — single endpoint for all house presets
- [ ] Server-side preset registry (file or DB row), each entry: name, prompt, engine, hidden params, intensity_map, exposed_params
- [ ] House presets: prompt is **hidden** (never echoed in API responses)
- [ ] User presets (later): prompt visible to that user only

### 2.2 Initial Darkroom preset library

- [x] Darkroom Skin v1 — pore/SSS/imperfections (Lens img2img, low strength) — **SHIPPED**
- [ ] Darkroom Glow — boudoir warmth, soft highlights, subtle bloom
- [ ] Darkroom Noir — black-and-white film noir
- [ ] Darkroom Polaroid — 70s instant-camera, light leaks, faded color
- [ ] Darkroom Velvet — saturated reds and purples
- [ ] Darkroom Dawn — cool blue hour, muted palette
- [ ] Darkroom Sunkissed — golden hour amber wash
- [ ] Darkroom Wet Look — water beads, glossy lips, damp hair
- [ ] Darkroom Lace — vintage halation, dreamlike softening
- [ ] Darkroom 35mm — film grain + contrast curves
- [ ] Darkroom Studio — clean editorial, hard key, magazine retouch

### 2.3 Preset UI

- [ ] Preset row/grid in result-actions area, replacing the current ad-hoc upscaler buttons
- [ ] Each preset card: name, color/icon, credit cost, intensity selector
- [ ] After application: edit-strength slider works as currently does
- [ ] User can build their own presets (later) from a chain or a one-shot prompt

---

## PHASE 3 — SMART ROUTING & PRE-FLIGHT ANALYSIS

> **Principle:** before the user spends credits, Darkroom tells them which engines will succeed and which will probably refuse. Saves credits, saves time, eliminates frustrating refusals, and makes the app feel like it knows what it's doing.

### 3.1 Content profile (per-image, one vision call)

When a new image becomes the active result (`currentUrl`), run it through a vision model **once** and cache the profile in the catalog row.

- [ ] `POST /api/analyze-image` — returns a content profile for the asset
- [ ] Backend uses Grok Vision (cheap, fast, permissive analyzer)
- [ ] Profile shape:
  ```jsonc
  {
    "nudity_level": "explicit" | "topless" | "lingerie" | "swimwear" | "suggestive" | "clothed",
    "face_visible": true,
    "scene_type": "boudoir" | "portrait" | "landscape" | "still-life" | "group" | "other",
    "subject_count": 1,
    "primary_subject": "woman" | "man" | "couple" | "object" | "scene",
    "explicit_acts": false,                  // sex acts, penetration, etc.
    "minor_concern": false,                  // hard refusal trigger if true
    "violence": false,
    "tags": ["bedroom", "natural-light", ...]
  }
  ```
- [ ] Cache profile on the asset row (`assets.metadata.content_profile`)
- [ ] Re-analyze only when image changes (i.e., never on UI re-render)

### 3.2 Engine compatibility map

A static lookup table mapping content profile → engine likelihood:

| Engine | explicit | topless | lingerie | suggestive | clothed |
|---|---|---|---|---|---|
| Lens (Grok Pro) | ⚠️ may refuse | ⚠️ | ✓ | ✓ | ✓ |
| Glance (Nano) | ⚠️ | ⚠️ | ✓ | ✓ | ✓ |
| Strip (P-Edit) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Brush (Flux Fill) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Eye (GPT-2) | ✗ | ✗ | ⚠️ | ⚠️ | ✓ |
| Frame (Bria) | ✗ | ✗ | ⚠️ | ✓ | ✓ |
| Develop (Topaz) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Skin (Enhancor) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Reveal (Magnific) | ⚠️ | ⚠️ | ✓ | ✓ | ✓ |
| Lock (face-swap) | ✓ | ✓ | ✓ | ✓ | ✓ |

**Hard refusals never shown:** if `minor_concern: true` or `violence: true`, the operation is blocked entirely (not just warned) — Darkroom doesn't pass that work through any engine.

### 3.3 UI surfaces

- [ ] **Engine cards** show a colored dot/badge based on compatibility
  - **Green dot** — "likely to succeed"
  - **Amber dot** — "may refuse" + a tiny inline reason on hover/click ("Eye refuses topless content")
  - **Greyed out / red** — "will refuse" (still clickable but a confirm dialog: "Eye will likely refuse this image. Proceed anyway and risk wasting credits?")
- [ ] **Live caption** under engine cards updates per image: "Lens, Glance, Brush, and Strip are likely to succeed on this image. Eye and Frame will probably refuse."
- [ ] **Smart suggestion**: highlight the *cheapest engine that will succeed* with a small "Recommended" tag (e.g., for clothed content, Eye is recommended because it's high-fidelity AND won't refuse; for lingerie, Lens is recommended because it's faster and won't refuse)
- [ ] **Refusal toast**: if an engine still refuses after pre-flight said "likely," update the profile and the compatibility map automatically (closed-loop learning)

### 3.4 Watch (smart auto)

- [ ] When user picks **Watch**, the router uses the content profile + the user's prompt intent to pick the engine, not a hardcoded fallback
- [ ] Intent classification (cheap Grok call): "scene swap" → Glance, "garment edit" → Brush + auto-mask, "skin pass" → Darkroom Skin, "color/mood change" → Lens, etc.
- [ ] Explicit reason shown in the result label: "Watch picked Glance because: image is suggestive + you asked for a scene swap"

### 3.5a Auto Face-Lock (drift detection + invisible repair)

> **The user shouldn't have to know about face drift.** Global-regen engines (Glance, Strip, P-Edit, Sandwich) re-render faces from their own priors. Darkroom detects this and silently corrects it.

- [ ] After every edit on a portrait/person image, compute face-embedding similarity between BEFORE and AFTER
  - **MVP:** Lens vision check — *"Is the woman in image 2 the same person as in image 1? Return JSON: {same, confidence}"* — ~$0.005, fast
  - **v2:** InsightFace embedding cosine similarity via Replicate — sub-cent, more reliable
- [ ] If similarity < threshold (drift detected):
  - Toast: *"Detected face drift — restoring identity"*
  - Auto-run **Lock face-swap** with the BEFORE image as face source
  - Replace `currentUrl` with the swapped result
  - The Edit Strength slider operates on (BEFORE → swapped-AFTER), not the drifted intermediate
- [ ] Skip drift check entirely for face-friendly engines: Develop, Skin, Crisp, Reveal, Sharpen, Cutout
- [ ] Run drift check by default on: Glance, Strip, P-Edit, Sandwich, Brush (when mask covers face)
- [ ] User toggle: **Auto Face-Lock** (on by default) — can be disabled per-edit when user genuinely wants a different face
- [ ] Failed auto-swaps show explicit toast + leave drifted image as-is (don't silently break things)

**Why this matters:** users don't think in terms of "global regen vs region-locked engines." They think *"I want this edit but with my person's face."* Auto Face-Lock is the implementation detail Darkroom hides so the user doesn't have to think about it.

### 3.5 Cost-saving safeguards

- [ ] **Free re-route on refusal**: if an engine refuses despite green-dot, automatically retry on the next-best engine — no double credit charge
- [ ] **Warn before expensive operations on flagged content**: if Reveal ($0.10) is selected on lingerie content, show "Reveal sometimes refuses lingerie. Skin ($0.05) may be a safer first pass."

### 3.6 Background re-analysis

- [ ] After every edit, re-analyze the new image (cheap, async) so compatibility stays accurate as the image changes
- [ ] Profile change history → catalog (a topless image edited to clothed — that transition is recorded)

---

## PHASE 4 — UI POLISH (THE REDESIGN)

### 3.1 Three-mode layout

- [ ] **Compose** tab (left sidebar) — generate from scratch
- [ ] **Develop** tab — edit existing image (Edit row, Paint Mask, all engines)
- [ ] **Print** tab — finishing (presets, upscalers, send to TG/Discord)
- [ ] **Wardrobe** tab — garment library
- [ ] **Library** tab — full catalog browser

### 3.2 Engine card strip (replaces dropdowns)

- [ ] Horizontal card strip for engine selection in Develop mode
- [ ] Each card: house name + 4-word descriptor + credit cost + selected highlight (amber glow)
- [ ] Live caption below cards: "Brush will inpaint the masked region using your prompt. NSFW-permissive. ~12s."

### 3.3 Mask painter — full-screen takeover

- [ ] Promote Paint Mask from modal → full-screen workspace
- [ ] Brush controls floating top-left
- [ ] Engine + prompt + garment refs floating bottom
- [ ] Single big amber Inpaint button bottom-right
- [ ] Esc to close

### 3.4 Edit Strength slider

- [ ] Already wired — keep prominent placement, signature feature
- [ ] Add "snap to 25/50/75" presets

### 3.5 Aesthetic

- [ ] Background: warm near-black (#0a0807)
- [ ] Primary accent: amber (#c9842b) — tungsten not yellow
- [ ] Secondary: oxblood (#7c1d1d) for destructive actions
- [ ] Text: warm cream (#e8dac8)
- [ ] Serif display font (Cardo / Crimson Pro) for headers, JetBrains Mono for technical
- [ ] Subtle film grain overlay on chrome
- [ ] No emoji icons in chrome (replace with unicode glyphs or actual SVG)

### 3.6 NO TOOLTIPS

- [ ] Replace all `title=""` tooltip copy with inline subtitles, captions, or contextual help bars
- [ ] First-time-use explainer cards (dismissible, never reappear) for major operations

---

## PHASE 5 — FEATURES TO REMOVE OR HIDE FOR V1

- [ ] **Compare Pose** — never used, takes UI space
- [ ] **Fabric Video** — separate product (Darkroom Video later)
- [ ] **Kling Video** — separate product
- [ ] **Pose Reference (separate flow)** — fold into Compose as optional input
- [ ] **Sandwich Edit** — coverage by P-Edit + Glance + Brush; remove unless we test and it adds value
- [ ] **Grok BASIC ($0.02 / `grok-imagine-image`)** — remove entirely. The "BASIC = no moderation" framing was wrong on the /edits endpoint; BASIC actually has *stricter* edit moderation than PRO and refuses constantly. Keep only `grok-imagine-image-pro` as **Lens**. Removes the BASIC/PRO model toggle pill from the UI; one fewer cognitive choice for the user. Cost: $0.07 for Lens always — fine, it's better quality and no refusals worth its weight.

**Audit needed:**
- [ ] **Auto-mask from Garment** — does it land? compare side-by-side with Place Overlay
- [ ] **Surgical Edit** — broken in practice; replaced by Flux Fill auto-mask (rename or remove)
- [ ] **Auto-describe** — useful as opt-in, kill from automatic critical paths (already done for Wear)

---

## PHASE 6 — ACCOUNTS, BILLING, CREDITS

### 5.1 Auth
- [ ] Supabase Auth (email magic link + Google OAuth)
- [ ] Per-user scoping on all tables (already in schema design)
- [ ] Anonymous trial: ~30 free credits before signup

### 5.2 Credits ledger
- [ ] `credits_ledger` table — every action debits, every top-up credits
- [ ] **1 credit = $0.01 cost-to-us** (round to clean unit)
- [ ] Each engine action has a published credit cost (visible in UI)
- [ ] Failed actions don't burn credits (build trust)
- [ ] Live balance badge top-right, pulses when low

### 5.3 Pricing tiers (proposed)
- [ ] **Starter** — 500 credits / $7.50 (~60 brush edits)
- [ ] **Pro** — 2,000 credits / $25 (~250 brush edits) + free auto-mask
- [ ] **Studio** — 10,000 credits / $99 (~1,250 brush edits) + LoRA training
- [ ] **Top-up anytime** — $5 = 350 credits

### 5.4 Stripe + adult payment fallback
- [ ] Stripe primary
- [ ] CCBill or Segpay as fallback for declined Stripe transactions
- [ ] Discount code system for AI Builders Club early access

---

## PHASE 7 — DEFAULTS & PROMPT ENGINEERING

### 6.1 Generation prompt cleanup

- [x] Strip auto-appended texture/REALISM_TAGS from generation — texture is now the post-processing chain's job — **DONE**
- [x] Add GPT-Image-2 as a generation engine — **DONE**
- [ ] Optionally re-introduce a **per-engine** Darkroom Default toggle (Lens/Glance/Brush get realism polish; Strip stays raw)

### 6.2 Edit prompt anchoring

- [ ] Standardize "image 1 / image 2" terminology across all multi-image flows (Wear via Strip, Brush + garment ref) — **DONE for Wear**
- [ ] For single-image edits, auto-prepend identity-anchor language conditionally per engine

---

## PHASE 8 — TESTS / QA PASS

### 7.1 Engine functional verification

- [ ] **Lens (Grok img2img)** — sanity test on Compose + Develop
- [ ] **Glance (Nano Banana)** — sanity test on edit
- [ ] **Strip (P-Edit)** — single-image edit + multi-image wear test
- [ ] **Brush (Flux Fill Pro)** — manual mask + auto-mask
- [ ] **Eye (GPT-Image-2)** — generate + edit (refuses NSFW expected)
- [ ] **Frame (Bria)** — edit
- [ ] **Cutout (BiRefNet)** — bg removal
- [ ] **Develop (Topaz)** — full result test on a noir maid
- [ ] **Skin (Enhancor)** — full result test
- [ ] **Crisp (Enhancor crisp)** — needs wiring + test
- [ ] **Reveal (Magnific)** — full result test
- [ ] **Lock (fal.ai face-swap)** — pixel-precise test
- [ ] **Glance face-swap** — semantic-aware test
- [ ] **Eye face-swap** — fidelity test, expect refusals

### 7.2 Pipeline tests

- [ ] Place Overlay + Bake → Brush flow
- [ ] Wardrobe → drag → Wear via Strip flow
- [ ] Edit Strength slider on every edit type
- [ ] Sandwich edit (only if we keep it)
- [ ] Resize 1200 before Lens edit
- [ ] Multi-angle garment ref → Strip + Brush

### 7.3 Catalog tests

- [ ] Edit chain provenance — verify every edit writes parent_id correctly
- [ ] History view — verify edit chains render
- [ ] Replay chain — verify exact reproduction

---

## PHASE 11 — CHAINS (Visual Workflow Builder)

> **The product north star.** Drag-drop chain builder where every node is an outcome (not a model). Build, save, share, sell.

### 11.1 Core builder UX

- [ ] Full-screen Chain workspace (separate mode in left sidebar)
- [ ] **Stage palette** (left sidebar): named stages grouped by category
  - **Source:** Generate · Upload · Pick from Catalog · Pick from Wardrobe
  - **Edit:** Lens edit · Glance edit · Strip edit · Brush + auto-mask · Brush + paint mask · Wear Garment · Sandwich Edit
  - **Preset passes:** Darkroom Skin · Darkroom Glow · Darkroom Noir · Darkroom Wet · etc.
  - **Composition:** Crop · Outpaint · Reframe to aspect · Multi-aspect export
  - **Finishing:** Develop · Sharpen · Reveal · Reveal Open · Skin · Crisp · Restore
  - **Identity:** Lock face · Glance face-swap · Eye face-swap
  - **Output:** Save to Catalog · Send to Telegram · Send to Discord · Save as Wardrobe · Star
- [ ] Drag stage from palette onto canvas
- [ ] Connect output of one stage to input of the next (arrow / pipe)
- [ ] Click a stage → side panel with its parameters (engine choice, intensity, prompt, etc.)
- [ ] Multi-input stages support N inputs (Wear Garment takes [person, garment])
- [ ] Branching: a stage can have multiple downstream paths (compose 4 outputs at different intensities)
- [ ] Conditional stages (later): "if Lens refuses → route to Strip"

### 11.2 Chain execution

- [ ] **Run** button at top of chain → executes all stages in order, image flows through
- [ ] Live progress: each stage highlights as it runs, shows the partial output thumbnail
- [ ] **Estimated cost** at top: total credits across all stages, calculated before run
- [ ] **Estimated time** at top: sum of typical stage durations
- [ ] Failed stages can be skipped or retried; chain partial-results saved to catalog
- [ ] **Dry run mode**: preview the chain on a sample image without spending credits

### 11.3 Save / share / sell

- [ ] **Save chain** with name, description, cover image (auto-screenshot of best output)
- [ ] **Tags** for discoverability ("boudoir", "wedding", "product photography", "noir")
- [ ] **Share publicly** → chain gets a public URL, others can run it on their images
- [ ] **Visibility levels:** private / unlisted / public / for-sale
- [ ] **Run-as-template:** drop your image, run someone else's chain (always shows author credit)
- [ ] **Marketplace** *(later phase)*: sell your chain for X credits per run, revenue split with author

### 11.4 House chain starter library

Ship Darkroom with 15-20 expert-built chains:

- **Boudoir → Editorial** (porch-girl-style chain: Generate → Glance → Lock → Brush → Skin → Develop)
- **Headshot → LinkedIn**
- **Selfie → Editorial Portrait**
- **Outfit Flat-Lay → On-Model**
- **Bedroom → Hotel Suite**
- **Day → Golden Hour** (lighting transform)
- **Day → Noir**
- **Realistic → Polaroid 70s**
- **Single shot → IG Story + Reel + Feed** (multi-aspect output)
- **Nude → Tasteful Lingerie** (auto wardrobe + Brush)
- **Casual → Glam**
- **Indoor → Outdoor** (background swap)
- **Single subject → Couple shot** (outpaint + composite)

Each is a polished, named chain users can run with one click on their images.

### 11.5 Chain analytics feedback loop

- [ ] Every chain run records: stages used, success/refusal at each stage, user kept/deleted final output, intensity values, credit cost
- [ ] This data feeds **Smart Routing** (Phase 3): "users who ran Boudoir → Editorial 1,000 times: 87% kept the result when intensity was Medium, 41% kept it at High → recommend Medium by default"
- [ ] Power users see their chain success metrics; can A/B test variants

### 11.6 Build path

- [ ] **v1** (post-Phase 1 catalog + Phase 3 Smart Routing): linear chain builder, no branching, ship 5 starter chains
- [ ] **v1.5**: branching, conditional stages (route on refusal, route on content profile)
- [ ] **v2**: shareable URLs, run-as-template
- [ ] **v2.5**: marketplace, sell-your-chain economy
- [ ] **v3**: chain-of-chains (chains that call other chains)

---

## PHASE 12 — OUTFIT GENERATOR (Wardrobe Forge)

> When the garment you want doesn't exist in your wardrobe, **generate it from a description**, drop it into the wardrobe, and feed it into Wear Garment / Brush / Chains. Lens generates clean catalog-style garment images on demand.

### 12.1 Why this matters

The Wear Garment + Brush flows depend on having a garment reference image. If the user's idea is "thin damp cropped cotton tank top with no sleeves," they shouldn't have to find an Amazon photo that matches. **Lens (Grok) produces clean catalog-style garment shots from text alone, with no filter and full creative control.** Generated garments populate the wardrobe permanently.

### 12.2 Outfit generator UX

- [ ] **"Generate Garment"** button in the Wardrobe tab + inside the Paint Mask + Wear Garment flows
- [ ] Modal: prompt input + style preset (catalog white-bg / lifestyle / boudoir-isolated)
- [ ] Auto-prepend: house garment-prompt template that produces clean isolated images suitable for use as refs
  - Example template: *"A studio product photograph of [user prompt]. White seamless background. Centered. Even lighting. No model, no human body, no mannequin. Photorealistic, high detail, fabric texture visible. 1024x1024."*
- [ ] User clicks Generate → Lens creates the garment image
- [ ] Auto-runs **Cutout** (BiRefNet) on the result → transparent PNG
- [ ] Stores **both** the raw white-bg version and the cutout in the Wardrobe (raw used for Strip/Brush, cutout used for overlay)
- [ ] Auto-classifies garment_type via vision (so Smart Routing knows what body region it covers)

### 12.3 Multi-angle generation (the killer feature)

- [ ] **"Generate front + back + side"** option — Lens generates the same garment from three angles in one click
- [ ] Each angle stored as a Wardrobe entry, all three linked as the same garment with multi-angle metadata
- [ ] Wear Garment automatically uses all three angles (multi-image conditioning) when running Strip
- [ ] Flux Fill auto-collages the three angles for Redux conditioning

### 12.4 Garment chain integration

- [ ] **"Generate Garment"** is a stage in the chain builder
- [ ] Chain example: *Generate base photo → Generate Garment ("black thigh-high stockings with lace top") → Wear Garment → Darkroom Skin → Develop*
- [ ] Chains can include multiple Generate Garment stages (top + bottom + accessories)

### 12.5 Garment style presets

- [ ] Quick-start prompts as buttons:
  - "Lingerie set" / "Cocktail dress" / "Streetwear outfit" / "Workout gear" / "Beachwear" / "Office attire" / "Evening gown"
- [ ] Each fills a starter prompt the user can edit
- [ ] Backed by hidden Lens prompt templates tuned per category

### 12.6 Generation cost & flow

- [ ] **Cost:** 4 credits per garment generation (Lens basic-equivalent at quality settings)
- [ ] **Multi-angle (3 views):** 12 credits
- [ ] **Failed generations** (Lens returns weird artifacts, mannequin appears, etc.) → free retry up to 3x

### 12.7 Why Lens specifically (not GPT-2 or Flux)

- Lens: permissive, fast, accepts NSFW garment descriptions ("crotchless panties," "see-through bra"), no refusal on intimate apparel
- GPT-2: refuses lingerie generations frequently
- Flux: works but less consistent for catalog-isolated style

The user picks the outfit; Darkroom picks the engine. Vendor invisible.

---

## PHASE 13 — COMMUNITY (Sharing, Discovery, Auto-Tagging)

> **Darkroom is community-driven.** Users share outfits, poses, chains, presets, and finished images. Everything is auto-tagged via vision so discovery scales without human curation. Network effects compound: the more users ship, the better the library, the more valuable the platform.

### 13.1 Shareables (the four primitives)

| Type | What | Where it lives | Who consumes it |
|---|---|---|---|
| **Outfit** | Generated or uploaded garment ref(s), single or multi-angle | Wardrobe Forge / Wardrobe tab | Anyone running Wear Garment, Brush, Chains |
| **Pose** | A reference image used as pose anchor | Pose Library tab | Anyone running Compose with a pose ref |
| **Chain** | Multi-stage workflow recipe | Chain Library tab | Anyone running Chains |
| **Preset** | Single-stage user-built preset (custom prompt + engine + intensity) | Preset Library tab | Anyone running edits |

Shared assets get a creator credit, run-count, star count, and tags.

### 13.2 Auto-tagging (no manual curation)

When any user uploads, generates, or shares an asset, Darkroom auto-tags it via vision:

- [ ] **For outfits/garments:** Lens vision returns: `garment_type` (bra, panty, dress, etc.), `colors[]`, `materials[]` (lace, cotton, leather, mesh), `style[]` (boudoir, streetwear, formal, athletic), `coverage_level` (full / partial / minimal), `occasion[]` (wedding, evening, casual, club)
- [ ] **For poses:** vision returns: `pose_type` (standing, lying, sitting, kneeling), `body_orientation` (front, back, side, three-quarter), `mood[]` (sultry, candid, action, contemplative), `framing` (full-body, three-quarter, headshot, tight)
- [ ] **For chains:** auto-extracted from stages used + sample output: `outcome_type` (boudoir, headshot, scene-swap, upscale-finish), `nsfw_level`, `complexity` (1-stage / 3-stage / 5+stage), `cost_tier` (cheap / standard / premium)
- [ ] **For finished images** (gallery posts): same content profile from Phase 3.1, plus aesthetic tags (mood, color palette, lighting style)

**No user has to type tags manually.** Auto-tagging runs on every share. Users can edit/override but rarely need to.

### 13.3 Browse & search UI

- [ ] **Library tabs** in left sidebar: Wardrobe / Poses / Chains / Presets / Gallery — each shows community + your own
- [ ] **Filters per tab:** combobox of auto-tags + free-text search ("black lace lingerie", "lying down sultry pose", "boudoir-to-editorial chain")
- [ ] **Sort:** Most popular / Newest / Most starred / Trending (last 7 days)
- [ ] **Result cards** show: thumbnail, title, creator, run-count, star count, credit cost (for chains/garments)
- [ ] One-click **"Use this"** → drops asset into the active workspace

### 13.4 Trust & moderation

- [ ] All shared assets pass content profile screening (Phase 3.1)
- [ ] Hard refusals (minor concern, violence) → never enters public library, account flagged
- [ ] User-level NSFW preference toggle: hide explicit content from your library browsing if you want
- [ ] Report button on every shared asset; reports queue for review
- [ ] **Verified creator** badge for users with high-engagement chains (think: blue checkmark for chain authors)

### 13.5 Creator economy

- [ ] **Free shares** by default — sharing a chain/outfit costs nothing, earns reputation/run-count
- [ ] **Tip jar** on creator profiles — community sends credits to creators they like
- [ ] **For-sale chains** *(Phase 11.5 marketplace)* — creators set a per-run credit price, Darkroom takes 20%, creator keeps 80%
- [ ] **Bounty board** — users post "I want a chain that does X" with a credit reward; first creator to ship a working chain claims the bounty
- [ ] **Featured creators** — Darkroom curates a weekly featured creator on the home tab; massive distribution boost

### 13.6 Discoverability features

- [ ] **"More like this"** on every shared asset (Lens vision similarity match)
- [ ] **"Used together"** — users who used Outfit X often paired it with Pose Y (collaborative filtering on tag co-occurrence)
- [ ] **"Make this yours"** — fork any shared chain, edit your version, save
- [ ] **Trending tags** on the home tab updates daily
- [ ] **Activity feed** for users you follow

### 13.7 Network effects (why this compounds)

- Every chain ran → routing data improves
- Every garment shared → wardrobe library deepens
- Every pose shared → compose-time options multiply
- Every preset shared → editing surface expands
- Every starred output → trending signal sharpens
- Every featured creator → user acquisition channel
- **The longer Darkroom runs, the more valuable membership becomes.** Cloning the editor in a month doesn't matter when the library lives here.

### 13.8 Privacy controls

- [ ] **Default visibility = private.** Users opt-in to share, never auto-share
- [ ] **Anonymous sharing** option — share without a creator credit (but loses reputation/economy benefits)
- [ ] **Image-stripping for shared chains** — when sharing a chain, only the *workflow* is shared, not the test images you ran it on (those stay private to the user)
- [ ] **Consent affordances** — can't share an outfit/pose generated FROM a recognizable real person without an explicit confirmation step (defends against creep cases at the platform level)

---

## PHASE 14 — MOBILE (The Feed That Sells the Editor)

> **Two surfaces, one platform.** The desktop editor is for creators; the mobile feed is for everyone. Mobile is the conversion engine — passive consumption that ladders into paid creation.

### 14.1 The product

A vertically-scrolling, infinite, Instagram-style feed of community Darkroom output. Boudoir, editorial, glamour, lingerie, fantasy — whatever the community ships. NSFW-permissive (because that's the differentiation; SFW image apps are a saturated commodity).

- [ ] Vertical scroll, single image per screen, snap-to-image
- [ ] Tap to zoom; long-press to expand into "Make one like this" sheet
- [ ] Double-tap to star (saves to favorites + boosts the chain's trending score)
- [ ] Swipe left → next image; swipe right → creator profile; swipe up → comments / "made with" details

### 14.2 The conversion ladder

This is the entire commercial logic:

1. **Free, anonymous browse** — anyone can scroll the feed without an account
2. **Account gate at engagement** — to follow, star, comment, or save → free signup with email
3. **"Make one like this"** on any post → opens the **mobile-simplified editor** with the exact chain that produced the image, pre-loaded
4. **First chain run** → user uploads a source image → runs the chain → gets their own version → free trial credits eat the cost
5. **Free credits exhaust** → paywall → Stripe / adult-rail
6. **First post-back** to the feed → user is now a creator → social loop starts compounding

### 14.3 Mobile-simplified editor

The mobile editor is NOT the desktop chain builder. It's intentionally limited:

- [ ] **Run-a-chain** mode: pick a community chain → upload source → tap Run → see result → save/share
- [ ] **Quick presets**: tap-and-go preset buttons (Darkroom Skin, Glow, Noir, etc.) — no chain building on mobile
- [ ] **Crop/aspect** support for IG/Story export
- [ ] **Send to** integration: save to camera roll, send to Telegram, send to Discord
- [ ] **No** chain builder, no engine selection, no parameter tweaking — that's desktop territory

The principle: **mobile is for running chains, desktop is for building them.**

### 14.4 Distribution constraint (App Store hostile)

NSFW-permissive content is hard-banned from Apple App Store and Google Play Store. **Tumblr cautionary tale.** Therefore:

- [ ] **v1 is a PWA** (Progressive Web App) — installable to home screen via Safari/Chrome, works exactly like a native app, no app store gating, no NSFW review process
- [ ] **PWA install flow**: prominent "Add to Home Screen" prompt for mobile web visitors
- [ ] **Native-feel UX**: hide browser chrome, use native gestures (swipe, pinch, long-press), full-bleed layouts, dark theme, font scaling
- [ ] **v2** *(later, optional)*: TestFlight beta on iOS for Pro-tier users only — sidesteps App Store entirely
- [ ] **v3** *(speculative)*: an "SFW Darkroom" version for App Store as a marketing/discovery channel that funnels to the real product on the web (deceptive but Tumblr did it for a decade)

**Do not waste time fighting Apple's review board.** PWA-first, always.

### 14.5 Engagement features

- [ ] **Algorithmic feed** with creator follow + tag-based recommendations (auto-tag system from Phase 13.2 powers this)
- [ ] **Notifications** (push via PWA): new post from followed creator, your image got starred, your chain got 10+ runs, tip received
- [ ] **Creator profiles** with run-count, follower count, top chains, tip jar
- [ ] **Stories** — 24-hour ephemeral posts (later phase)
- [ ] **Comments + reactions** on posts — light moderation, no troll boards
- [ ] **Direct messages** — between followed creators only, image-share enabled (later)

### 14.6 Discovery loops

- [ ] **For You** feed — algorithmic, learns from your stars/follows/tap-throughs
- [ ] **Following** feed — chronological from people you follow
- [ ] **Trending** tab — most-starred chains/images of the day/week
- [ ] **Tags** browsing — drill into "boudoir" / "noir" / "lingerie" / "outdoor"
- [ ] **Search** — by tag, creator name, or chain name
- [ ] **Featured chains** banner at top — Darkroom-curated daily highlights

### 14.7 Creator monetization on mobile

- [ ] **Tip via credits** — buy credits in-app, send to creators
- [ ] **Subscribe to creator** (later) — pay X credits/month for early-access posts, exclusive chains
- [ ] **Buy chains** — paid chains show price; tap to purchase, run on your image, revenue split with creator
- [ ] **OnlyFans-style "premium content"** option for creators who want to gate explicit posts behind a per-creator subscription (later phase, requires legal/compliance review)

### 14.8 Retention mechanics

- [ ] **Daily login bonus** — small free credit drip for opening the app every day
- [ ] **Streak counters** — "7-day streak: free chain run on us"
- [ ] **Push notifications** at peak engagement times (evenings, weekends — when horny-dude attention is highest)
- [ ] **"Your image is trending"** alerts — massive dopamine hit, drives back-engagement

### 14.9 Strategic positioning

The mobile feed is **the marketing engine** — it acquires users at zero CAC because the content itself is the ad. Every post on the public feed is a free demonstration of what Darkroom can do. Creators get distribution; viewers get conversion-friendly entry; Darkroom gets the network effect.

**The market positioning:**

- *Pinterest* — beautiful, curated, organized, but not adult-friendly
- *Instagram* — algorithmic, but kills NSFW-adjacent posts, no creator economy on top of an editor
- *OnlyFans* — subscription model, adult-friendly, but no AI tooling, no community remix loop
- *Civitai* — has the gallery, has the models, but ugly, technical, ML-bro audience
- **Darkroom** — the gallery + the editor + the chains + the creator economy + the actual taste, packaged for an audience that wants to make/consume tasteful adult content without ML-research overhead

### 14.10 Build path

- [ ] **v1 web responsive** (Phase 4 redesign): mobile breakpoints on the desktop site, basic feed view, no native-feel polish
- [ ] **v1.5 PWA** (post-launch): full PWA with home-screen install, native gestures, push notifications
- [ ] **v2 mobile-first dedicated routes**: `/feed`, `/post/:id`, `/creator/:slug` — designed for mobile from the ground up
- [ ] **v2.5 algorithmic feed** with For You / Following / Trending tabs
- [ ] **v3 monetization layer** — tip jar, paid chains, creator subscriptions
- [ ] **v3.5 native iOS via TestFlight** — Pro-tier-only, sideload bypass App Store

---

## PHASE 9 — CROP, REFRAME & OUTPAINT

> **Principle:** crop is a core editing operation, not a checkbox feature. Lightroom-quality interaction, AI-assisted suggestions, outpainting for canvas-extension, fully integrated with catalog (crop becomes a node in the edit chain).

### 9.1 Crop primitives (the basics, done right)

- [ ] Full-screen crop workspace (like the mask painter — focused, no chrome)
- [ ] Free-form crop with 8 handles (4 corners + 4 edge midpoints)
- [ ] Drag the box itself to reposition
- [ ] Visible **rule-of-thirds grid** overlay during drag (toggle off)
- [ ] Live dimensions shown: "1024 × 1536 → 768 × 1152" + aspect ratio
- [ ] Hold Shift to constrain to current aspect ratio
- [ ] Hold Alt to crop from center
- [ ] Reset / restore-original / cancel buttons
- [ ] Esc closes; Enter applies

### 9.2 Aspect ratio presets

- [ ] Quick row of preset buttons: **Free** · **1:1** · **4:5 (IG Feed)** · **9:16 (Story)** · **3:4 (Portrait)** · **16:9 (X / Hero)** · **2:3 (Print)**
- [ ] Click → snaps the crop box to that aspect ratio
- [ ] Per-platform "Save crop as preset" — user can save their own (e.g., "My OnlyFans cover" at 1.91:1)

### 9.3 Smart subject-aware cropping (AI-assisted)

- [ ] **Auto-crop to subject** — Lens vision finds the primary subject + face, returns the smartest framing for the chosen aspect ratio (rule of thirds, head room, breathing space)
- [ ] **Smart re-crop**: given an existing crop and a new aspect ratio, intelligently re-frame instead of just letterboxing — preserve the subject, lose the dead space
- [ ] **Multi-platform export**: one click → generates 1:1 + 4:5 + 9:16 + 16:9 versions, each with subject-aware framing. Whole row of thumbnails appears below the result.

### 9.4 Outpaint (canvas extension via Brush)

- [ ] **Extend the canvas** — drag a crop edge OUTSIDE the original image
- [ ] The new outside region gets filled by Flux Fill Pro (Brush) using the surrounding image + a prompt
- [ ] Common use cases:
  - Convert 4:5 portrait → 16:9 hero by extending left/right
  - Convert close-up → wider context shot
  - Add headroom or floor for a different platform
- [ ] Default outpaint prompt is auto-generated from the existing image content (Lens vision), user can override
- [ ] Outpaint preserves the original pixels exactly — only fills the extension regions
- [ ] Cost shown clearly: "Extending right edge: 8 credits"

### 9.5 Catalog integration

- [ ] Crop is an `edit_action: "crop"` with `edit_params: { x, y, w, h, aspect, source: "manual" | "smart" | "preset:9:16" }`
- [ ] Outpaint is `edit_action: "outpaint"` with `edit_params: { extended_edges: ["right", "top"], prompt }`
- [ ] Original (un-cropped) image stays as parent — non-destructive
- [ ] User can "uncrop" (load parent) anytime
- [ ] Edit chain replay handles crop/outpaint correctly when applied to a different image

### 9.6 Smart cropping for the Send pipeline

- [ ] When user clicks "Send to Telegram" or "Send to Discord," check the current image aspect
- [ ] If the aspect doesn't match the channel's preferred (e.g., Discord prefers 16:9 for embeds), prompt: "Auto-crop to 16:9 for Discord? You can preview first."
- [ ] If user says yes, run smart re-crop, show preview, send. Original stays in catalog.

### 9.7 What the crop tool is NOT

- Not a Photoshop-style transform (rotate, skew, perspective). Those are separate operations if we ever ship them.
- Not a layer system. Single-image only.
- Not bulk crop (yet). One image at a time. Bulk operations land in Phase 1 (catalog) when we have project/album-level batch ops.

---

## PHASE 15 — ASYNC JOB SYSTEM (Background Processing)

> **Foundational.** Every long-running operation becomes a backgrounded job. The UI never blocks. Users start an edit and immediately do something else — paint another mask, queue a chain, browse Library, edit a different image. Results land in Library and ping the user when done.

### 15.1 The behavior change

**Before:** click Edit → UI shows "Editing..." spinner for 30s → result lands → can do next thing
**After:** click Edit → job goes to queue → UI returns immediately → user starts the next edit → first edit lands in Library + shows a toast "Edit complete · click to view"

### 15.2 Schema additions

- [ ] `jobs` table:
  ```sql
  create table jobs (
    id uuid primary key default gen_random_uuid(),
    user_id uuid,
    job_type text,                  -- 'generate' | 'edit' | 'wear-garment' | 'topaz' | 'chain' | etc.
    input_params jsonb,             -- whatever the action needs
    status text default 'queued',   -- 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
    parent_asset_id uuid,           -- the source image
    result_asset_id uuid,           -- populated when done
    error_message text,
    progress_pct int default 0,     -- 0-100, optional
    estimated_duration_ms int,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz default now()
  );
  create index jobs_user_status on jobs(user_id, status, created_at desc);
  ```

### 15.3 Decision rules: async vs sync

- [ ] **Always async (>5s expected duration):** Generate, all edits, Wear Garment, Inpaint, Sandwich, Topaz, Magnific, Enhancor, Crisp, Restore, SUPIR, Reveal Open, Sharpen-on-large-images, Chains (always), Outpaint
- [ ] **Sync (sub-3s):** Cutout (BiRefNet), Resize, Strength bake, Auto-mask, Crop apply (just metadata, no model call), Face-drift check (when used as a guard)
- [ ] **Borderline (default async, user can opt sync):** Face Swap, Brush + small mask
- [ ] User toggle: **"Wait for result"** vs **"Queue and continue"** — default is queue

### 15.4 UI surfaces

- [ ] **Active Jobs badge** (bottom-right floating pill): "3 running" — click to expand panel
- [ ] **Job panel** lists all jobs with status, source thumbnail, estimated time remaining, cancel button
- [ ] **Toast** when each job completes: thumbnail + "Edit complete · click to view" → loads result into the canvas
- [ ] **Failed job toast**: includes error message + "Retry" button + "Open Library" link
- [ ] **History tab** filters: All / Done / Failed / Cancelled
- [ ] **Library** auto-receives every completed job's output asset
- [ ] **Don't lose work**: closing the browser tab keeps jobs running server-side; reopening shows pending/completed state

### 15.5 Backend mechanics

- [ ] **v1 (simplest):** Bun server kicks off the operation as a background promise (`Promise.allSettled` style), updates the `jobs` row when done. No external worker needed at low scale.
- [ ] **v1.5:** Add cancellation — abortable fetch wrappers per job
- [ ] **v2:** Move to a real worker (Bun process or Supabase Edge Function) when concurrent jobs > N
- [ ] **v2.5:** Job-level rate limiting (Replicate has burst limits; Topaz queues quickly)
- [ ] **v3:** Pre-emptive job warming — when user starts typing a chain, pre-allocate slots so first stage runs sub-second on Run

### 15.6 Frontend update strategy

- [ ] **Polling (v1):** every 2s while any jobs are in-flight, GET `/api/jobs?status=running` — simple, resilient
- [ ] **SSE (v2):** Server-Sent Events stream from `/api/jobs/stream` — instant updates without polling overhead
- [ ] **WebSockets (v3):** if we ever add multi-user collab/sharing real-time

### 15.7 Notifications

- [ ] **In-app toasts** — always
- [ ] **Browser notifications** (PWA) — optional, user grants permission once, fires when tab is backgrounded
- [ ] **Push notifications** (mobile, Phase 14) — for long jobs / chains while user is away from the app
- [ ] **Email / Telegram digest** (later) — "Your overnight chain run finished — 47 images"

### 15.8 The unlock for chains

- [ ] **Without async:** chains can only be 2-3 stages because users won't stare at a spinner for 5+ minutes
- [ ] **With async:** chains can be 10+ stages running in the background while the user does literally anything else
- [ ] **Multi-image chain runs:** apply a chain to 50 images at once → all queued, results land in Library overnight
- [ ] **Ladders directly into mobile feed:** queue 5 chain runs from the iPhone, close the app, come back to 5 finished images

### 15.9 Build order

This is foundational for **Chains (Phase 11)**, **Mobile (Phase 14)**, and bulk operations. Should land **before** Chain v1 ships — otherwise chains feel broken. Logical dependency order:

1. Catalog (Phase 1) — `assets` table + edit chain provenance
2. **Async Jobs (Phase 15)** — `jobs` table + background execution ← THIS PHASE
3. Smart Routing (Phase 3) — recommendations, drift detection
4. Chains (Phase 11) — uses jobs as the execution layer
5. Mobile (Phase 14) — browses Library populated by async jobs

---

## PHASE 16 — DETAIL BRUSHES (Two-Track System: Assets + Prompts)

> **Two complementary tracks for surgical detail work:**
>
> - **Track A — Asset Overlays:** curated, hand-tuned transparent-PNG assets (nipples, freckles, beauty marks, tan lines, etc.) that users drag onto the image. **Deterministic, fast, $0 per use after creation.**
> - **Track B — Prompt Brushes:** AI-generated regional edits via Brush (Flux Fill Pro) using hidden prompts. **Context-aware, regenerates the region.**
>
> Each track does what the other can't. Together they cover everything.

### 16.0 Track A — Asset Overlays (the smarter half)

**Concept:** Darkroom maintains a curated library of transparent-PNG assets — proprietary IP we create, retouch, and version. User picks from a thumbnail grid, drags onto the image, positions/scales/rotates, server color-matches the asset to the underlying skin tone via Lens vision, applies via overlay blend.

**Why this beats pure prompt brushes for many use cases:**
- ✅ **Deterministic** — same asset always looks the same. No AI variance, no "Brush refused" surprise.
- ✅ **Free per use** — no model call. Just compositing + a tiny color-match step.
- ✅ **Higher quality possible** — we curate, retouch, perfect. Quality is fixed at creation, not at user generation.
- ✅ **Variety locked in** — pick "Nipple Variant 3 of 8" instead of regenerating until you get lucky.
- ✅ **Sub-second turnaround** — pure compositing, no model queue.
- ✅ **Predictable cost** — credit cost is fixed, no model API surprises.

**The asset creation pipeline (Darkroom-owned):**

1. Internal team (or just us, early on) generates candidates via Brush/Lens with explicit prompts
2. Curate the best — retouch in Photoshop or via Develop/Skin to perfection
3. Cut to transparent PNG via Cutout (BiRefNet) or hand-mask
4. Tag with metadata: `category`, `variation_id`, `recommended_skin_tone_range`, `recommended_lighting`, `nsfw_level`, `placement_hint`
5. Upload to a `details_assets` table in Supabase (Joe-owned, served via Darkroom CDN)

**The user flow:**

1. Open **Detail Library** panel
2. Browse: Anatomy → Nipples → Hard → grid of 8 variants with thumbnails
3. Click variant → asset appears as draggable overlay (uses the existing garment-overlay system we already built — drag/resize/rotate handles)
4. Position over the target region
5. Click **Apply** → server reads underlying skin tone via Lens vision, color-matches the asset, composites with multiply/overlay blend
6. Result lands as new asset in catalog with `edit_action: "detail_overlay"` + `edit_params: { asset_id, position, scale, rotation }`

**Smart skin-tone matching:**

- Lens vision samples skin pixels under the placement region
- Server color-shifts the asset's hue/saturation/lightness to match
- Edge feather (~3px) for natural blend
- Optional sub-surface scattering simulation for nipples (slight pink halo)

**Catalog of assets to create (target v1 library):**

- **Nipples**: 8 hard variants (small/medium/large × pink/brown/dark areola) + 6 piercings (barbells, rings, horseshoes in gold/silver/black)
- **Freckles**: 12 cluster patterns (light dusting / heavy / nose-only / cheek-only / shoulder / chest / arm)
- **Beauty marks**: 8 individual moles (small/medium × placement variants)
- **Tan lines**: 6 patterns (bikini / one-piece / shoulder strap / hip bone / thigh)
- **Stretch marks**: 8 subtle patterns (hip / belly / breast / thigh)
- **Goosebumps**: 4 textures (light / medium / dense / chest-only)
- **Body hair**: 6 light vellus patterns (forearm / lower back / belly trail / thigh / underarm-shadow / pubic shadow)
- **Sweat sheen**: 4 patterns (forehead / chest / lower back / inner thigh)
- **Lip gloss / wet lips**: 5 highlight variants
- **Eye catchlight**: 6 sparkle variants (single / dual / heart-shape / starburst)
- **Lace texture overlays**: 8 lace patterns (Chantilly / floral / geometric) for fabric pop
- **Pasties / nip covers**: 6 styles (star / heart / flower / round / striped) — NSFW reduction asset, useful for going-public edits

**Total: ~80-100 starter assets.** Library grows over time. Each asset is curated, hand-tuned, and locked.

### 16.1 Track B — Prompt Brushes (when assets aren't enough)

[Original concept from the prior plan: hidden prompt + tap-to-place mask + Brush call.]

**Where Track B beats Track A:**
- ✅ **Context integration** — "Wet Shirt Cling" needs to follow the actual fabric drape on the user's specific image. Asset overlays can't bend.
- ✅ **Body-shape adaptive** — "Inner Thigh Shadow" depends on the subject's pose. Generated, not pasted.
- ✅ **One-of-a-kind effects** — "Damp Hair Tendrils" follows the user's hair direction. Each render is unique.
- ✅ **Removal operations** — "Remove Bra Strap" is purely an inpainting job, no asset to overlay.

**Track B brush categories** (now narrower since Track A handles most anatomy):

- **Fabric**: Wet Shirt Cling, Sheer Transparency Boost, Fabric Drape, Mesh See-Through, Damp Cotton Wrinkle
- **Body shape**: Inner Thigh Shadow, Cleavage Shadow, Hip Bone Definition (depends on pose)
- **Hair (dynamic)**: Damp Hair Tendrils, Wet Hair Cling, Single Strand Across Face
- **Mood / Expression**: Parted Lips, Bite Lip, Sultry Gaze, Knowing Half-Smile
- **Atmospheric**: Skin Glow, Subtle Blush
- **Removal** (inpaint-only): Remove Nip Cover, Remove Bra Strap, Remove Underwear Line, Remove Watermark, Remove Tattoo

### 16.2 Routing: which track for which job

When the user types into the Detail Library search bar, results show across both tracks with badges:

- **🎨 Asset** — instant, deterministic, $0
- **✨ Brush** — ~10s, AI-generated, ~4 credits

For overlapping concepts (e.g., "Hard Nipples" exists as both an asset variant set AND a prompt brush), Track A is the **default** (free, fast, predictable), Track B is the **fallback** ("if none of the asset variants match what I want, generate one").

### 16.1 Concept

A Detail Brush is a **bundle of three things**:

1. **Hidden prompt** — explicit anatomical language sent to Brush (Flux Fill Pro). Never shown to user, never logged in plain text in the response.
2. **Mask hint** — either a fixed shape (small oval, dotted region) or a "tap N points" gesture the user performs to place it on the image.
3. **Tuned parameters** — strength, dilation, blend mode, redux ref (optional).

User taps the brush → places points if needed → backend builds the mask → runs Brush → result lands. Sub-15-second turnaround for a single detail.

### 16.2 Starter library (bundled with Darkroom v1)

**Anatomy**
- Hard Nipples — Subtle
- Hard Nipples — Visible
- Hard Nipples — Pierced (with optional jewelry style: barbell / ring / horseshoe)
- Nipple Pokes (Under Fabric)
- Areola — Pinker
- Areola — Larger
- Tan Lines (Hip Bone)
- Tan Lines (Shoulders)
- Tan Lines (Bikini Line)
- Inner Thigh Shadow
- Subtle Stretch Marks (very natural)
- Belly Button Detail
- Hip Bone Definition
- Collarbone Pop
- Cleavage Shadow

**Fabric Detail**
- Wet Shirt Cling
- Sheer Fabric — Transparency Boost
- Lace Pattern Pop (preserves position, sharpens detail)
- Fabric Drape (gravity-true folds)
- Mesh See-Through
- Damp Cotton Wrinkle

**Lighting Accents**
- Cheekbone Highlight
- Lip Gloss Shine
- Eye Catchlight (single point, sparkle)
- Skin Glow (warm honey)
- Subtle Blush
- Sweat Sheen (forehead / chest)

**Hair**
- Flyaway Strands
- Damp Hair Tendrils
- Wet Hair Cling (against neck/shoulder)
- Single Strand Across Face

**Mood / Expression**
- Parted Lips (slight)
- Bite Lip (light)
- Sultry Gaze (eye narrowing)
- Knowing Half-Smile

**Imperfections / Realism**
- Single Beauty Mark (placeable)
- Freckle Cluster (placeable)
- Faint Scar (placeable, healed-look)
- Goosebumps (cold/aroused)
- Light Vellus Hair (forearm / lower back)

**Removal Brushes** (single-click cleanup)
- Remove Nip Cover (pasties / star stickers)
- Remove Bra Strap
- Remove Underwear Line
- Remove Watermark
- Remove Tattoo (placeable)

### 16.3 UX flow

- [ ] **Detail Brush panel** opens in the result-actions row or via a dedicated tab
- [ ] **Categorized grid** (Anatomy / Fabric / Lighting / Hair / Mood / Imperfections / Removal) with thumbnail icons + names
- [ ] **Search bar** at the top — type "nipple" → filtered list
- [ ] **Click a brush** → either:
  - **Auto-place mode**: brush has a default mask shape (e.g., "Cleavage Shadow" auto-detects the cleavage region via Lens vision) → click Apply
  - **Tap-to-place mode**: brush prompts "Tap N points on the image where you want this" → user taps → mask is computed (e.g., 2 taps for nipples → two small circles)
  - **Drag-to-place mode**: brush prompts "Drag to define the region" → user drags a small box (e.g., for "Tan Line" → drag along the hip)
- [ ] **Default strength** chosen per brush (subtle ones at 0.4, bold ones at 0.7)
- [ ] **Preview before apply** (optional toggle): low-res quick render of the change, user confirms before spending full credits

### 16.4 House voice / naming principles

- [ ] Names are **descriptive, not euphemistic** ("Hard Nipples" not "N1", not "Body Detail v3")
- [ ] Categories are **clean and discoverable** ("Anatomy" not "Adult Features")
- [ ] **No crass humor in labels** — the product takes the user's intent seriously
- [ ] Confirmable previews for all brushes — never silently apply something users didn't see coming

### 16.5 Pricing and credit cost

- [ ] **Single-click brushes** = 4 credits (single Brush call, small region)
- [ ] **Multi-tap brushes** (e.g., 3 freckles, 2 nipples) = 4 credits regardless of tap count (one render)
- [ ] **Auto-detected region brushes** (e.g., Cleavage Shadow, runs Lens to find region) = 6 credits (extra Lens call)
- [ ] **Removal brushes** = 4 credits

Bundle deal: **"All Detail Brushes" pack** for unlimited use at $5/mo on top of any tier — converts price-sensitive heavy users to predictable LTV.

### 16.6 User-created assets + brushes (community-driven library)

> **The library is community-built.** Darkroom seeds the v1 starter set; users grow it from there into thousands of curated assets and brushes.

**Track A — User-created Asset Overlays:**

- [ ] **"Submit an asset"** flow in the Detail Library:
  1. User takes any image they own (or generates one via Brush/Lens with their own prompt)
  2. Cuts to transparent PNG via Darkroom's Cutout
  3. Names it, picks category, adds tags
  4. Optionally specifies recommended skin-tone range, recommended lighting, NSFW level
  5. Submits → enters review queue (auto-tag via Lens vision + content profile screening from Phase 3.1)
  6. Approved → joins the public library with creator credit
- [ ] **Personal asset library** — users keep their own private assets that never go public
- [ ] **One-click promote-to-public** for assets the user wants to share
- [ ] **Asset usage tracking**: every time someone uses your asset, you get credit (reputation, tip jar, marketplace revenue)

**Track B — User-created Prompt Brushes:**

- [ ] User builds a prompt brush: hidden prompt + intensity + mask gesture (tap / drag / auto-region)
- [ ] Saves to personal library; can share publicly
- [ ] Same review/auto-tag/screening as assets

**Quality controls (community library doesn't become a dumping ground):**

- [ ] **Vision-based content profile screening** (Phase 3.1) auto-rejects: minor concern, non-consensual imagery, real-person likeness without consent, violence
- [ ] **Auto-tag verification**: Lens vision tags must align with user-claimed category (an "asset tagged Freckles" that vision sees as a face → flagged)
- [ ] **Star/report system**: low-rated assets fall out of default search; reported assets queue for review
- [ ] **Verified creator badge** for assets that hit quality thresholds (run-count + star ratio)
- [ ] **Featured weekly**: Darkroom curates a weekly featured asset/brush — massive discovery boost

**Marketplace (Phase 16.7):**

- [ ] **Free assets** by default (most of the library)
- [ ] **Paid assets/brushes** — creator sets price in credits per use, Darkroom takes 20%, creator keeps 80%
- [ ] **Asset packs** — bundle 10 related assets ("Boudoir Anatomy Pack", "Editorial Skin Pack") at a discount
- [ ] **Subscription support** — creators can offer a monthly subscription for unlimited use of their assets
- [ ] **Bounty board**: users post "I want an asset that does X" with a credit reward; first creator to ship a working version claims the bounty

**The compounding effect:**

- Darkroom v1 ships with ~80 curated assets + ~30 prompt brushes
- Year 1 community contributions: thousands of assets across niches we never anticipated (cosplay, fantasy, fetish, retro looks, art styles)
- Year 2: the library IS the moat. Users stay because their saved-asset collection lives here. Creators stay because their revenue stream lives here. Competitors clone the editor → no library → no users.

**Network effects on top of network effects:** users find new assets through use, creators get distribution, Darkroom takes the spread, the library compounds.

### 16.7 Why this is a moat

Photoshop has spot-correction. Lightroom has masks. Procreate has brushes. None of them have **AI-powered region-prompt brushes targeted at the body** — because no corporate-safe product can ship "Hard Nipples" as a button. **Darkroom can.** Every detail brush is one moat-deepening feature competitors can't legally clone.

The library compounds: as users build and share custom brushes (Phase 16.5), the catalog of detail brushes becomes thousands deep — and the auto-tagging (Phase 13.2) makes them all discoverable.

### 16.8 Build path

- [ ] **v1**: ship 15 starter brushes (the most common 5 from each category) with the existing Brush + auto-mask infrastructure
- [ ] **v1.5**: full library of 50+ starter brushes
- [ ] **v2**: tap-to-place mask gestures (better UX for placement-driven brushes like Beauty Mark)
- [ ] **v2.5**: Lens-vision auto-region brushes (e.g., "Cleavage Shadow" auto-locates the region)
- [ ] **v3**: custom user brushes + sharing/marketplace

---

## OPEN QUESTIONS

- [ ] Final brand name confirmation (Darkroom locked? rebrand starting when?)
- [ ] Domain availability check + purchase
- [ ] Stripe vs CCBill order of operations (which to set up first?)
- [ ] AI Builders Club early-access integration — how does this product hook into the community?
- [ ] Public benchmark: do we want a "Darkroom uses these engines, here's a comparison gallery" landing page?
- [ ] LoRA training — will we offer custom-character training as a Studio-tier feature?
- [ ] Mobile / responsive — is v1 desktop-only, or do we ship mobile in scope?
- [ ] **Marketing launch:** AI Builders Club, then X/Reddit/Hacker News? What's the demo image?

---

## SHIPPED (recent)

- [x] Multi-angle garment refs (P-Edit `images[]` + Flux Fill collage)
- [x] Garment overlay (drag/resize/rotate/bake-to-mask)
- [x] Auto-bg-strip (BiRefNet, transparent PNG)
- [x] Raw vs cutout URL tracking (so P-Edit gets pre-strip image)
- [x] Edit Strength slider (post-edit blend back to original at any %)
- [x] Resize endpoint (1200px long edge for faster Grok edits)
- [x] Auto-mask from Garment (Lens vision finds the body region)
- [x] Auto-mask from prompt (Lens vision in `/api/flux-edit`)
- [x] Sandwich edit endpoint (clothe → safe-edit → unclothe)
- [x] Disable auth toggle for local dev
- [x] Garment auto-process on paste/Enter (no Upload-button workaround)
- [x] Face-swap engine selector (Lock / Glance / Eye)
- [x] Darkroom Skin v1 (hidden prompt, house signature)
- [x] Generation prompt cleanup (REALISM_TAGS removed)
- [x] GPT-Image-2 added as generation engine

---

## NOTES

- Keep architecture: `index.ts` + `src/server/routes/*.ts` + `public/index.html`. Don't introduce SPA framework.
- Ship daily. v1 is "the editor I use myself" before anything else.
- The benchmark (lunaos-ops 68% on LongMemEval) is the credential; Darkroom is the product. Don't conflate them in marketing.
- Adult-payment-rail integration is what unblocks revenue at scale; plan it now.
