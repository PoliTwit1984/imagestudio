# Enhancor Engine Reference

Full reference for all 7 Enhancor engines wired into Darkroom.

**Canonical source:** <https://github.com/rohan-kulkarni-25/enhancor-api-docs>

---

## Overview

All Enhancor engines share a common async queue pattern:

1. **POST `/queue`** — submit a job, get back `{ success, requestId }`
2. **POST `/status`** — poll with `{ request_id }`, get back `{ requestId, status, cost, result? }`
3. **Webhook** — on completion, Enhancor POSTs to your `webhookUrl`

### Auth Header

```
x-api-key: <your_api_key>
```

All requests require `Content-Type: application/json`.

### Status Enum

| Value | Meaning |
|-------|---------|
| `PENDING` | Received, not yet queued |
| `IN_QUEUE` | Queued, waiting for a worker |
| `IN_PROGRESS` | Worker processing now |
| `COMPLETED` | Done — `result` URL present |
| `FAILED` | Processing error |

### Webhook Payload (all engines)

```json
{
  "request_id": "unique_request_id",
  "result": "https://cdn.enhancor.ai/processed-image.png",
  "status": "success"
}
```

### Queue Response (all engines)

```json
{ "success": true, "requestId": "unique_request_id" }
```

### Status Response (all engines)

```json
{
  "requestId": "unique_request_id",
  "status": "COMPLETED",
  "cost": 480,
  "result": "https://cdn.enhancor.ai/processed-image.png"
}
```

(`result` only present when `status === "COMPLETED"`)

---

## Engine Catalog

| House Name | Vendor Slug | Endpoint | Type |
|------------|-------------|----------|------|
| Skin Pro | `realistic-skin` | `/api/realistic-skin/v1/queue` | Skin enhancement (19 area locks, v1 + v3) |
| Lens Pro | `kora` (`model=kora_pro`) | `/api/kora/v1/queue` | txt2img + img2img |
| Lens Cinema | `kora` (`model=kora_pro_cinema`) | `/api/kora/v1/queue` | txt2img cinematic |
| Lens Reality | `kora-reality` | `/api/kora-reality/v1/queue` | txt2img realism (undocumented — wire conservatively) |
| Develop | `detailed` | `/api/detailed/v1/queue` | One-call upscale + enhance |
| Sharpen Portrait | `upscaler` | `/api/upscaler/v1/queue` | Portrait upscale (`mode: fast/professional`) |
| Sharpen | `image-upscaler` | `/api/image-upscaler/v1/queue` | General upscale |

Base URL for all engines: `https://apireq.enhancor.ai`

---

## 1. Skin Pro

**Vendor slug:** `realistic-skin`
**Endpoints:** `POST /api/realistic-skin/v1/queue` | `POST /api/realistic-skin/v1/status`

Advanced portrait enhancement with per-region area locks. Two model versions (v1/v3) with different parameter ranges.

### Parameters

#### Enhancement Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `img_url` | string | — | **Required.** URL of the source image |
| `webhookUrl` | string | — | **Required.** Webhook URL for result delivery |
| `model_version` | string | `"enhancorv1"` | Model version: `"enhancorv1"` or `"enhancorv3"` |
| `enhancementMode` | string | `"standard"` | Intensity: `"standard"` or `"heavy"` (v1 only) |
| `enhancementType` | string | `"face"` | Target: `"face"` or `"body"` |
| `skin_refinement_level` | number | `0` | Skin texture enhancement 0–100 |
| `skin_realism_Level` | number | `1.7` (v1) / `0.1` (v3) | Realism: 0–5 (v1) or 0–3 (v3) |
| `portrait_depth` | number | `0.2` | Depth 0.2–0.4 (v3 or v1 heavy mode only) |
| `output_resolution` | number | `2048` | Output resolution 1024–3072 (v3 only) |
| `mask_image_url` | string | `""` | Mask image URL (v3 only) |
| `mask_expand` | number | `15` | Mask expansion −20 to 20 (v3 only) |

#### Area Lock Parameters

Set to `true` to preserve that region unchanged during enhancement.

| Parameter | Default | Region |
|-----------|---------|--------|
| `background` | `false` | Background |
| `skin` | `false` | Skin surface |
| `nose` | `false` | Nose |
| `eye_g` | `false` | Eye area (general) |
| `r_eye` | `true` | Right eye |
| `l_eye` | `true` | Left eye |
| `r_brow` | `false` | Right eyebrow |
| `l_brow` | `false` | Left eyebrow |
| `r_ear` | `true` | Right ear |
| `l_ear` | `true` | Left ear |
| `mouth` | `true` | Mouth |
| `u_lip` | `true` | Upper lip |
| `l_lip` | `true` | Lower lip |
| `hair` | `false` | Hair |
| `hat` | `false` | Hat |
| `ear_r` | `false` | Earring |
| `neck_l` | `false` | Necklace |
| `neck` | `false` | Neck |
| `cloth` | `false` | Clothing |

### Notable Params

- **`model_version`** — v3 unlocks `output_resolution`, `mask_image_url`, `mask_expand`, and `portrait_depth`; `enhancementMode: "heavy"` is v1-only
- **`skin_realism_Level`** — note the capital L in the key; range differs by model version
- 19 area lock booleans default to `true` for eyes, ears, mouth, and lips — loosen them intentionally

### Example curl

```bash
curl -X POST https://apireq.enhancor.ai/api/realistic-skin/v1/queue \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "img_url": "https://example.com/portrait.jpg",
    "webhookUrl": "https://your-app.com/webhooks/enhancor",
    "model_version": "enhancorv3",
    "enhancementType": "face",
    "skin_refinement_level": 50,
    "output_resolution": 2048
  }'
```

---

## 2. Lens Pro

**Vendor slug:** `kora` with `model: "kora_pro"`
**Endpoints:** `POST /api/kora/v1/queue` | `POST /api/kora/v1/status`

High-quality AI image generation from text prompts. Supports img2img via `img_url`. Shares the `/api/kora/v1` endpoint with Lens Cinema — distinguished by the `model` field.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `model` | string | Yes | — | Must be `"kora_pro"` |
| `prompt` | string | Yes | — | Text description of the image to generate |
| `webhookUrl` | string | Yes | — | Webhook URL for result delivery |
| `img_url` | string | No | `""` | Reference image URL for img2img mode |
| `generation_mode` | string | No | `"normal"` | Quality: `"normal"`, `"2k_pro"`, `"4k_ultra"` |
| `image_size` | string | No | `"portrait_3:4"` | Aspect ratio / dimensions (see Image Sizes below) |

#### Generation Modes

| Mode | Resolution | Use Case |
|------|-----------|----------|
| `normal` | Standard | Quick generation, prototyping |
| `2k_pro` | 2K | Professional work |
| `4k_ultra` | 4K | Maximum quality, print-ready |

#### Image Sizes

| Preset | Aspect Ratio |
|--------|-------------|
| `portrait_3:4` | 3:4 |
| `portrait_9:16` | 9:16 (mobile/stories) |
| `square` | 1:1 |
| `landscape_4:3` | 4:3 |
| `landscape_16:9` | 16:9 (widescreen) |
| `custom_WIDTH_HEIGHT` | e.g. `custom_2048_1536` |

### Notable Params

- **`img_url`** — presence activates img2img mode; omit for pure txt2img
- **`generation_mode: "4k_ultra"`** — use for final production output only; slower and more expensive

### Example curl

```bash
# txt2img
curl -X POST https://apireq.enhancor.ai/api/kora/v1/queue \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "model": "kora_pro",
    "prompt": "Cinematic portrait of a woman in golden hour light, photorealistic",
    "generation_mode": "2k_pro",
    "image_size": "portrait_3:4",
    "webhookUrl": "https://your-app.com/webhooks/enhancor"
  }'

# img2img
curl -X POST https://apireq.enhancor.ai/api/kora/v1/queue \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "model": "kora_pro",
    "prompt": "Transform into a watercolor painting style",
    "img_url": "https://example.com/source.jpg",
    "generation_mode": "2k_pro",
    "image_size": "custom_2048_1536",
    "webhookUrl": "https://your-app.com/webhooks/enhancor"
  }'
```

---

## 3. Lens Cinema

**Vendor slug:** `kora` with `model: "kora_pro_cinema"`
**Endpoints:** `POST /api/kora/v1/queue` | `POST /api/kora/v1/status`

Cinematic-style txt2img. Same endpoint and parameter shape as Lens Pro — only the `model` value differs. Optimized for dramatic, movie-like imagery.

### Parameters

Identical to Lens Pro. See [Lens Pro parameters](#2-lens-pro). Set `model` to `"kora_pro_cinema"`.

### Notable Params

- **`model: "kora_pro_cinema"`** — the only distinction from Lens Pro; produces heavier contrast, cinematic color grading
- **`image_size: "landscape_16:9"`** — natural pairing for cinematic output

### Example curl

```bash
curl -X POST https://apireq.enhancor.ai/api/kora/v1/queue \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "model": "kora_pro_cinema",
    "prompt": "Epic sci-fi cityscape with neon lights and flying vehicles, anamorphic lens flare",
    "generation_mode": "4k_ultra",
    "image_size": "landscape_16:9",
    "webhookUrl": "https://your-app.com/webhooks/enhancor"
  }'
```

---

## 4. Lens Reality

**Vendor slug:** `kora-reality`
**Endpoints:** `POST /api/kora-reality/v1/queue` | `POST /api/kora-reality/v1/status`

> **Note:** This endpoint is undocumented upstream. Wire conservatively — use only the common base parameters confirmed across all engines. Do not assume Kora Pro's optional params (`generation_mode`, `image_size`, `img_url`) are supported until verified.

Realism-focused txt2img generation. Separate endpoint from Kora; treat as a distinct engine.

### Parameters (conservative surface)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Text description of the image to generate |
| `webhookUrl` | string | Yes | Webhook URL for result delivery |

Additional params (e.g. `generation_mode`, `image_size`, `img_url`) may work — verify against live API before relying on them.

### Notable Params

- Undocumented endpoint — no official param spec available; infer shape from common Kora pattern
- If Kora-style params are accepted, `generation_mode` and `image_size` are the most likely candidates

### Example curl

```bash
curl -X POST https://apireq.enhancor.ai/api/kora-reality/v1/queue \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "prompt": "Photorealistic portrait of a woman outdoors, natural light, Sony A7 85mm",
    "webhookUrl": "https://your-app.com/webhooks/enhancor"
  }'
```

---

## 5. Develop

**Vendor slug:** `detailed`
**Endpoints:** `POST /api/detailed/v1/queue` | `POST /api/detailed/v1/status`

One-call upscale + enhance pipeline. Combines resolution increase with detail enhancement in a single request — no chaining required. Best for professional photography and commercial work.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `img_url` | string | Yes | URL of the image to process |
| `webhookUrl` | string | Yes | Webhook URL for result delivery |

No additional tuning parameters — the engine runs a fixed optimized pipeline.

### Notable Params

- No mode or quality knobs; the engine applies its best-effort combined pipeline automatically
- Single call replaces a generate → upscale → enhance chain
- Higher quality output than Sharpen alone at the cost of slower processing

### Example curl

```bash
curl -X POST https://apireq.enhancor.ai/api/detailed/v1/queue \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "img_url": "https://example.com/professional-photo.jpg",
    "webhookUrl": "https://your-app.com/webhooks/enhancor"
  }'
```

---

## 6. Sharpen Portrait

**Vendor slug:** `upscaler`
**Endpoints:** `POST /api/upscaler/v1/queue` | `POST /api/upscaler/v1/status`

Portrait-specific upscaler optimized for facial features and skin texture. Two modes trade speed against quality.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `img_url` | string | Yes | URL of the portrait image to upscale |
| `webhookUrl` | string | Yes | Webhook URL for result delivery |
| `mode` | string | Yes | Processing mode: `"fast"` or `"professional"` |

#### Mode Details

| Mode | Speed | Quality | Use Case |
|------|-------|---------|----------|
| `fast` | Quick | Good | Previews, batch processing |
| `professional` | Slower | High | Final output, headshots, portfolio |

### Notable Params

- **`mode`** is required — no default; the call will fail without it
- Use `"fast"` for iteration, `"professional"` for delivery
- Portrait-specific: facial feature sharpening + skin detail preservation; not intended for non-portrait images

### Example curl

```bash
# Fast mode
curl -X POST https://apireq.enhancor.ai/api/upscaler/v1/queue \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "img_url": "https://example.com/portrait.jpg",
    "webhookUrl": "https://your-app.com/webhooks/enhancor",
    "mode": "fast"
  }'

# Professional mode
curl -X POST https://apireq.enhancor.ai/api/upscaler/v1/queue \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "img_url": "https://example.com/portrait.jpg",
    "webhookUrl": "https://your-app.com/webhooks/enhancor",
    "mode": "professional"
  }'
```

---

## 7. Sharpen

**Vendor slug:** `image-upscaler`
**Endpoints:** `POST /api/image-upscaler/v1/queue` | `POST /api/image-upscaler/v1/status`

General-purpose upscaler for any image type. No portrait-specific tuning — appropriate for landscapes, products, architecture, and any non-portrait content.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `img_url` | string | Yes | URL of the image to upscale |
| `webhookUrl` | string | Yes | Webhook URL for result delivery |

No mode or quality params — automatic quality optimization.

### Notable Params

- No `mode` param (unlike Sharpen Portrait) — one pipeline for all input types
- Use Sharpen Portrait instead when the subject is a face/portrait; this engine is not tuned for facial features

### Example curl

```bash
curl -X POST https://apireq.enhancor.ai/api/image-upscaler/v1/queue \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "img_url": "https://example.com/landscape.jpg",
    "webhookUrl": "https://your-app.com/webhooks/enhancor"
  }'
```

---

## Status Polling Pattern

All engines share the same status endpoint shape:

```bash
curl -X POST https://apireq.enhancor.ai/api/<vendor-slug>/v1/status \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{ "request_id": "your_request_id" }'
```

Poll until `status` is `COMPLETED` or `FAILED`. Recommended interval: 2–5 seconds. Prefer webhooks over polling in production.

---

## Engine Comparison

| House Name | Best For | Has Prompt | Mode Param | Notable |
|------------|----------|------------|------------|---------|
| Skin Pro | Portrait skin enhancement | No | No | 19 area locks, v1/v3 models |
| Lens Pro | General generation + img2img | Yes | `generation_mode` | img2img via `img_url` |
| Lens Cinema | Cinematic/dramatic imagery | Yes | `generation_mode` | Same endpoint as Lens Pro |
| Lens Reality | Photorealistic generation | Yes | Unknown | Undocumented — wire conservatively |
| Develop | Professional upscale + enhance | No | No | Single-call combined pipeline |
| Sharpen Portrait | Portrait upscale | No | `mode` (required) | fast/professional modes |
| Sharpen | General upscale | No | No | All image types, no portrait tuning |
