# Image Studio — Web App Specification

## What It Is

A personal AI image generation, editing, and enhancement web application. Built for creating photorealistic thirst trap and lifestyle content for Instagram (@sashanoire.official) and personal use. Single-page app with a Bun backend, Supabase persistence, and multiple AI API integrations.

**Live:** https://studio.myfavoritehuman.app
**Local:** http://localhost:3000
**Auth:** Bearer token (`studio-2026`)

---

## Architecture

```
Browser (single HTML file)
    ↓ REST API (Bearer auth)
Bun Server (index.ts, ~1,800 lines)
    ↓
┌─────────────────────────────────────┐
│ Supabase (Postgres + Storage)       │
│  tables: characters, generations,   │
│  loras, studio_settings,            │
│  favorite_poses                     │
│  storage: image-studio bucket       │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ AI APIs                             │
│  xAI Grok   — img2img, chat, vision│
│  fal.ai     — Flux LoRA, face swap │
│  Topaz Labs — enhance, upscale     │
│  Freepik    — skin, stock search,  │
│               Kling video           │
│  ElevenLabs — TTS (Ivanna/Holly)   │
│  Replicate  — Fabric video         │
└─────────────────────────────────────┘
```

---

## Screens & Features

### 1. Authentication

Simple token entry screen. Token saved to `localStorage`. No user accounts — single-user personal tool.

- Text input (centered, dark)
- "Enter" button
- Persists across sessions

### 2. Generate Tab (Main)

The primary screen. Left-right layout on desktop, stacked on mobile.

#### Left Side — Result Area

- **Result image** — full-width display of the generated/edited image. Clicking opens lightbox (fullscreen overlay with close button)
- **Processing overlay** — purple-tinted overlay with status text during generation/editing
- **Version stack** — when editing, shows "Original → Edit 1 → Edit 2" as clickable thumbnails below the result. Allows undo by clicking any previous version
- **Pose comparison** — optional side-by-side view showing the pose reference next to the generated image (toggle button)

#### Right Side — Controls

**Character Selector:**
- Horizontal scrolling row of character cards
- Each card: circular ref image thumbnail (64px), name, description preview
- Active character has purple (#c850c0) border
- Per-character actions: Edit (name, description, ref image, LoRA settings), Delete
- "+" card to add new character (uploads ref image to Supabase storage)
- Characters stored in Supabase `characters` table with fields: name, display_name, description, ref_image_url, lora_url, lora_trigger, lora_scale

**Prompt Input:**
- Multiline textarea
- "AI Enhance" button — sends prompt to Grok 4.20 reasoning model, rewrites for photorealism, replaces textarea content
- "Clear" button

**Prompt Builder (collapsible):**
10 categories of clickable chips that append to the prompt:

| Category | Examples |
|---|---|
| Scene | lying in bed, kitchen doorway, couch, doorframe, mirror, balcony, shower, stairs, car, hotel room, rooftop |
| Clothing | black silk slip, white robe, black lace lingerie, oversized tee, towel, panties + tank, leather jacket, bodysuit, bedsheets |
| Lighting | warm lamplight, golden hour, morning window, overcast, candlelight, neon glow, harsh midday, blinds light, fluorescent, bedside lamp |
| Camera | iPhone 14 Pro, Pixel 7, disposable film, DSLR shallow DOF, webcam, Ring doorbell, vintage Polaroid |
| Skin | natural skin texture with visible pores, slight tan lines, freckles on shoulders, visible veins on hands, uneven skin tone |
| Environment | messy unmade bed, clothes on floor, half-empty wine glass, charging cable, Target throw blanket, Post-it notes on mirror, scuffed hardwood |
| Mood | needy eye contact, looking away distracted, caught off guard, just woke up, post-workout glow, tipsy at 2am |
| Film Grade | Kodak Portra 400, Fuji Pro 400H, CineStill 800T, Ilford HP5 B&W, Polaroid 600, Instagram Lark |
| Imperfections | slight motion blur, lens flare from window, dust on lens, red-eye from flash, slightly out of focus background |
| Composition | looking directly at camera, shot from slightly above, reflection in mirror, over-the-shoulder, extreme close-up face, full body standing |

**Engine Selector:**
- Segmented control: Grok / fal.ai
- Grok: uses xAI img2img (`/v1/images/edits`) with character ref image
- fal.ai: uses Flux LoRA (`fal-ai/flux-lora`) with character LoRA weights

**LoRA Settings (shown when fal.ai selected):**
- Scale slider (0.1–1.5, default character's lora_scale)
- Steps slider (1–50, default 28)
- Guidance slider (1–20, default 7.5)

**Generate Button:**
- Full-width purple gradient button
- Shows engine name ("Generate with Grok" / "Generate with fal.ai")

#### Action Buttons (below result image)

Appear after an image is generated. Each triggers a different pipeline:

| Button | Color | Action |
|---|---|---|
| Edit | white | Opens edit panel — text input for edit instruction. Edit sent to Grok img2img or Bria FIBO |
| AI Enhance | white | Grok vision analyzes the current image, returns clickable edit suggestions as chips |
| Skin | amber | Freepik skin enhancer (faithful mode, grain 0). One-tap enhance |
| Magnific | amber | Freepik Magnific creative upscaler — Grok auto-generates an editable prompt, then upscales |
| Topaz | cyan | Opens Topaz settings panel (model picker + per-model sliders) |
| Face Swap | purple | Opens face swap panel — pick a character face to swap onto current image |
| Fabric Video | red | Opens Fabric panel — type text or upload audio → talking head video |
| Kling Video | pink | Opens Kling panel — prompt + duration (5s/10s) + aspect ratio + model (Pro/Std) |
| Telegram | blue | One-tap send to Joe's Telegram private group |
| Discord | indigo | One-tap send to Discord channel |
| Compare Pose | cyan | Toggle side-by-side pose reference comparison |
| Copy URL | white | Copy image URL to clipboard |
| Download | white | Download image to device |

#### Edit Panel

Appears inline when Edit button is clicked:
- Text input for edit instruction
- Engine selector: Grok / Bria FIBO / P-Edit
- "Apply Edit" button
- Cancel button

#### Topaz Settings Panel

Dropdown model picker + dynamic sliders per model:

| Model | Available Sliders |
|---|---|
| Bloom Realism | Creativity, Texture, Sharpness |
| Bloom Precision | Creativity, Texture |
| High Fidelity | (none — pure upscale, zero changes) |
| Face Recovery | Face Recovery Intensity |
| Natural Enhance | Creativity |

"Enhance" button submits to `/api/topaz` with selected model + slider values.

#### Face Swap Panel

- Grid of character face thumbnails (from Supabase characters)
- Click a face → sends current image + face ref to fal.ai face-swap
- Result replaces current image, original pushed to version stack

#### Fabric Video Panel

Two options:
1. **Type text** → "Generate Voice" button → ElevenLabs TTS (Holly voice) → audio URL auto-fills
2. **Upload audio** (file picker or paste URL)

Resolution picker: 720p / 1080p
"Generate Video" button → VEED Fabric → video plays inline

#### Kling Video Panel

- Prompt textarea (motion description)
- Duration: 5 seconds / 10 seconds dropdown
- Aspect ratio: 9:16 / 16:9 / 1:1
- Model: Kling Pro / Kling Standard
- "Generate Video" button → polls until complete → video plays inline

#### Magnific Panel

- Grok auto-generates an upscale prompt based on the current image
- Editable textarea showing the generated prompt
- "Upscale" button → Freepik Magnific creative upscaler

### 3. History Tab

- Grid of all past generations from Supabase `generations` table
- Each cell: thumbnail image, character name, timestamp
- Click → loads image into result area with all action buttons available
- Paginated (newest first)
- Lightbox on click (fullscreen overlay)

### 4. Settings Tab

Editable system prompts stored in Supabase `studio_settings` table:

| Key | Purpose |
|---|---|
| `chat_system` | Grok creative director chat personality |
| `enhance_system` | AI Enhance — prompt rewriter for generation |
| `enhance_edit_system` | AI Enhance — prompt rewriter for edits |
| `vision_system` | Grok Vision — image analysis + edit suggestions |
| `realism_directive` | Realism rules appended to all prompts |

Each prompt: label, description, editable textarea, "Save" button.
"Reload All" button refreshes from Supabase.

---

## API Endpoints (Backend)

### Generation
| Method | Path | Description |
|---|---|---|
| POST | `/api/generate` | Generate image (Grok img2img or fal.ai Flux LoRA) |
| POST | `/api/edit` | Edit existing image (Grok / Bria / P-Edit) |
| POST | `/api/enhance` | AI rewrite prompt for photorealism |
| POST | `/api/chat` | Grok creative director conversation |
| POST | `/api/analyze` | Grok vision — analyze image, return JSON edit suggestions |

### Enhancement
| Method | Path | Description |
|---|---|---|
| POST | `/api/topaz` | Topaz Labs enhance (5 models, per-model settings) |
| POST | `/api/upscale` | Freepik skin enhancer (faithful, grain 0) |
| POST | `/api/magnific-prompt` | Auto-generate Magnific upscale prompt via Grok |
| POST | `/api/face-swap` | fal.ai face swap (no content filter) |

### Video
| Method | Path | Description |
|---|---|---|
| POST | `/api/fabric` | VEED Fabric talking head (image + audio → video) |
| POST | `/api/kling` | Kling Pro/Std video (image → motion video, 5s/10s) |
| POST | `/api/tts` | ElevenLabs text-to-speech (Holly voice) |

### Pose Reference
| Method | Path | Description |
|---|---|---|
| GET | `/api/pose-search?q=` | Freepik stock photo search |
| POST | `/api/analyze-pose` | Grok vision analyzes a pose image |
| POST | `/api/pose-generate` | Generate from a pose reference |

### Data
| Method | Path | Description |
|---|---|---|
| GET | `/api/characters` | List all characters |
| POST | `/api/characters/upload-ref` | Upload new character ref image |
| POST | `/api/characters/update` | Update character settings |
| POST | `/api/characters/delete` | Delete a character |
| GET | `/api/generations?limit=N` | Generation history |
| GET | `/api/loras` | List registered LoRAs |
| GET | `/api/favorites` | Saved pose references |
| POST | `/api/favorites` | Save a pose to favorites |
| DELETE | `/api/favorites` | Remove a saved pose |

### Settings
| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Get all system prompts |
| POST | `/api/settings` | Save a system prompt |
| POST | `/api/settings/reload` | Reload from Supabase |

### Distribution
| Method | Path | Description |
|---|---|---|
| POST | `/api/send/telegram` | Send image to Telegram |
| POST | `/api/send/discord` | Send image to Discord |

### System
| Method | Path | Description |
|---|---|---|
| GET | `/health` | Server health check |
| GET | `/api/lunaos-status` | LunaOS system status (for dashboard) |

---

## Database Schema (Supabase)

### characters
```sql
id UUID PRIMARY KEY
name TEXT UNIQUE          -- internal key (e.g. "luna", "holly")
display_name TEXT         -- UI display name
description TEXT          -- short description
ref_image_path TEXT       -- storage path for ref image
ref_image_url TEXT        -- public URL
prompt_prefix TEXT        -- prepended to all prompts for this character
prompt_suffix TEXT        -- appended
lora_url TEXT             -- fal.ai LoRA weights URL
lora_trigger TEXT         -- trigger word (e.g. "LUNAV2", "HOLLYV1")
lora_scale FLOAT          -- default LoRA scale
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

### generations
```sql
id UUID PRIMARY KEY
character_name TEXT
prompt TEXT
engine TEXT               -- "grok" or "fal"
image_url TEXT
settings JSONB            -- LoRA scale, steps, guidance, etc.
sent_telegram BOOLEAN
sent_discord BOOLEAN
created_at TIMESTAMPTZ
```

### studio_settings
```sql
key TEXT PRIMARY KEY       -- "chat_system", "enhance_system", etc.
value TEXT                 -- the prompt text
description TEXT           -- UI label
updated_at TIMESTAMPTZ
```

### favorite_poses
```sql
id UUID PRIMARY KEY
image_url TEXT
thumbnail_url TEXT
title TEXT
source TEXT               -- "freepik", "pinterest", etc.
created_at TIMESTAMPTZ
```

### loras
```sql
id UUID PRIMARY KEY
name TEXT
trigger_word TEXT
url TEXT                  -- weights URL
scale FLOAT
created_at TIMESTAMPTZ
```

---

## Design Language

- **Background:** #0a0a0a
- **Surface:** #151515 with #222 borders
- **Accent:** #c850c0 (character active), purple gradient on generate button
- **Text:** #e0e0e0 primary, #888 secondary, #555 tertiary, #444 muted
- **Action buttons:** outlined with colored border matching function (amber=enhance, cyan=topaz, purple=face swap, red=video, blue=telegram)
- **Chips:** #222 background, #888 text, purple border on hover
- **Fonts:** System stack (-apple-system, BlinkMacSystemFont, Segoe UI)
- **Border radius:** 12px cards, 8px buttons, 6px inputs
- **Layout:** Two-column on desktop (result left, controls right), single column on mobile (<900px)
- **Tooltips:** On hover for all action buttons — explain what each does

---

## Current Tech Stack

- **Frontend:** Single HTML file (2,760 lines) — HTML + CSS + vanilla JS. No framework.
- **Backend:** Bun (TypeScript), single index.ts (~1,800 lines)
- **Database:** Supabase (Postgres + Storage)
- **Deployment:** Railway (auto from `railway up`)
- **Domain:** studio.myfavoritehuman.app (Hostinger DNS → Railway CNAME)
- **Auth:** Bearer token in localStorage, checked on every API call

---

## Characters (Current)

| Name | Display | LoRA | Trigger |
|---|---|---|---|
| luna | Luna | LUNAV2 | LUNAV2 |
| holly | Holly | HOLLYV1 | HOLLYV1 |
| holly2-10 | Sasha2-10 | none (Grok ref only) | — |
| hollyfirst | SashaFirst | none | — |

---

## Golden Pipeline (Preferred Workflow)

The optimal image generation workflow discovered through testing:

1. **Generate** — fal.ai Flux LoRA (scale 0.825, steps 17, guidance 4, safety off)
2. **Face Swap** (if needed) — fal.ai face-swap, no content filter
3. **Topaz Bloom Realism** — adds realistic skin texture, pores, fine detail
4. **Freepik Skin Faithful** — final natural skin finish (grain 0)

Output: Instagram-ready photorealistic image indistinguishable from real photography.

**Anti-patterns (deprecated):**
- FLUX Pro Ultra — baked-in NSFW filter returns black images
- fofr/face-swap (Replicate) — content filter blocks sexual content
- Magnific/Clarity Upscaler — hallucinates facial features
- High creativity on any upscaler — destroys face consistency

---

## Rules

- **Never smiling** in any generated image. Serious, sultry, intense, lips parted. No teeth.
- **Luna's hair:** Purplish pink (dark roots → magenta-violet) in ALL Luna prompts
- **Sasha/Holly:** Brunette, dark. Uses HOLLYV1 LoRA.
- **No makeup** on Luna unless specifically asked
- **Freepik CDN:** Use `img.freepik.com`, not `img.b2bpic.net` (403s)
- **fal.ai:** Use sync `fal.run` endpoint, not `queue.fal.run` (405s)
