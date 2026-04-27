import { checkAuth } from "../auth";
import { env } from "../config";
import type { RouteDeps } from "./types";

// =============================================================================
// Smart Edit pipeline
//
// Use case: edit an image (change background, lighting, outfit color, etc.)
// while preserving sensitive regions (boudoir / NSFW / faces). Two endpoints:
//
//   POST /api/detect-nsfw   { image_url } → { mask_url, regions[] }
//                           Replicate-backed NSFW detection. Returns a binary
//                           mask (white = NSFW region) and the bounding boxes.
//
//   POST /api/smart-edit    { image_url, prompt, mask_url?, prefer_model? }
//                           Tries gpt-image-2 (April 2026 release) first.
//                           Falls back to Grok img2img on content refusal.
//                           Mask defines regions to PROTECT — i.e., the model
//                           is told to edit OUTSIDE the mask.
//
// gpt-image-2 reference: released April 21 2026, supports image+mask via the
// /v1/images/edits endpoint. White regions of the input mask = edit allowed.
// To protect a region, invert your protect-mask before sending.
// =============================================================================

const GPT_IMAGE_MODEL = "gpt-image-2";
const GPT_QUALITY = "high";
const GPT_SIZE = "2048x2048";

const NSFW_DETECTOR_MODEL = "aaronaftab/mirage";

type NsfwRegion = {
  label: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
};

export async function handleSafeEditRoutes(
  req: Request,
  url: URL,
  deps: Pick<RouteDeps, "saveGeneration" | "getCharacter">
): Promise<Response | null> {
  if (url.pathname === "/api/detect-nsfw" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleDetectNsfw(req);
  }

  if (url.pathname === "/api/smart-edit" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleSmartEdit(req, deps);
  }

  if (url.pathname === "/api/make-nsfw" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleMakeNsfw(req, deps);
  }

  if (url.pathname === "/api/surgical-edit" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleSurgicalEdit(req, deps);
  }

  if (url.pathname === "/api/inpaint" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleInpaint(req, deps);
  }

  if (url.pathname === "/api/resize" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleResize(req);
  }

  if (url.pathname === "/api/sandwich-edit" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleSandwichEdit(req, deps);
  }

  if (url.pathname === "/api/auto-mask-garment" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleAutoMaskGarment(req);
  }

  if (url.pathname === "/api/remove-bg" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleRemoveBg(req);
  }

  if (url.pathname === "/api/describe-garment" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleDescribeGarment(req);
  }

  if (url.pathname === "/api/wear-garment" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleWearGarment(req, deps);
  }

  if (url.pathname === "/api/describe-wear-prompt" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleDescribeWearPrompt(req);
  }

  if (url.pathname === "/api/blend" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleBlend(req);
  }

  if (url.pathname === "/api/darkroom-skin" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleDarkroomSkin(req, deps);
  }

  if (url.pathname === "/api/detail-brush" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleDetailBrush(req, deps);
  }

  if (url.pathname === "/api/stamp-asset" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleStampAsset(req, deps);
  }

  if (url.pathname === "/api/optimize-pedit-prompt" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleOptimizePEditPrompt(req);
  }

  if (url.pathname === "/api/detail-brushes" && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    // Public-facing catalog: only id, name, category, description, brush_size_px,
    // strength_label. Hidden prompts and underlying engine stay server-side.
    return Response.json({
      brushes: Object.entries(DETAIL_BRUSH_REGISTRY).map(([id, b]) => ({
        id,
        name: b.name,
        category: b.category,
        description: b.description,
        brush_size_px: b.brushSizePx,
        intensity_label: b.intensityLabel,
      })),
    });
  }

  if (url.pathname === "/api/flux-edit" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleFluxEdit(req, deps);
  }

  return null;
}

// /api/flux-edit — auto-mask + Flux Fill Pro in one call.
// Body: { image_url, prompt, garment_urls?, mask_b64? }
//   - mask_b64: optional manual mask (skip auto-detect)
//   - garment_urls: optional Redux refs (auto-collaged if >1)
async function handleFluxEdit(
  req: Request,
  deps: Pick<RouteDeps, "saveGeneration">
): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    const prompt = String(body.prompt || "");
    const garmentUrls: string[] = Array.isArray(body.garment_urls)
      ? body.garment_urls.filter(Boolean).map(String)
      : [];
    const manualMaskB64 = body.mask_b64 ? String(body.mask_b64).replace(/^data:image\/\w+;base64,/, "") : "";

    if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });
    if (!prompt) return Response.json({ error: "prompt required" }, { status: 400 });

    const sharp = (await import("sharp")).default;
    const { uploadToStorage, buildUploadPath } = await import("../supabase");

    // Source dims
    const dl = await fetch(imageUrl);
    if (!dl.ok) return Response.json({ error: `fetch source ${dl.status}` }, { status: 400 });
    const sourceBuf = Buffer.from(await dl.arrayBuffer());
    const meta = await sharp(sourceBuf).metadata();
    const W = meta.width || 1024;
    const H = meta.height || 1024;

    // Build mask: use manual if supplied, otherwise have Grok Vision find the
    // region the prompt is targeting.
    let maskBuf: Buffer;
    let maskSource = "";
    if (manualMaskB64) {
      const rawMask = Buffer.from(manualMaskB64, "base64");
      // Normalize alpha → white-on-black PNG
      const alpha = await sharp(rawMask).ensureAlpha().extractChannel(3).threshold(10).png().toBuffer();
      const bg = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
      maskBuf = await sharp(bg).composite([{ input: alpha, blend: "screen" }]).png().toBuffer();
      maskSource = "manual";
    } else {
      const regions = await detectEditRegionsFromPrompt(imageUrl, prompt);
      if (regions.length === 0) {
        return Response.json({
          ok: false,
          error: `Grok Vision couldn't locate "${prompt.slice(0, 60)}" in the image. Use Paint Mask for manual control.`,
        });
      }
      maskBuf = await rasterizeRegionsToMask(regions, W, H, 0.12);
      maskSource = `grok:${regions.length} region${regions.length === 1 ? "" : "s"}`;
    }

    const maskUrl = await uploadBufferToStorage(maskBuf, "image/png", buildUploadPath, uploadToStorage, "flux-edit-mask");

    // Optional Redux ref (collage if multiple)
    let imagePromptUrl: string | undefined;
    if (garmentUrls.length === 1) imagePromptUrl = garmentUrls[0];
    else if (garmentUrls.length > 1) imagePromptUrl = await collageImagesToSingle(garmentUrls, uploadToStorage, buildUploadPath);

    const editedBuf = await callFluxFillPro({
      imageUrl,
      maskUrl,
      prompt,
      imagePromptUrl,
    });
    const resultUrl = await uploadBufferToStorage(editedBuf, "image/png", buildUploadPath, uploadToStorage, "flux-edit");

    try {
      await deps.saveGeneration({
        prompt: `[flux-edit] ${prompt}`,
        image_url: resultUrl,
        engine: "flux-fill-pro-direct",
      } as any);
    } catch {}

    return Response.json({
      ok: true,
      url: resultUrl,
      mask_url: maskUrl,
      mask_source: maskSource,
      model: "flux-fill-pro (auto-masked)",
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// Use Grok Vision to find the bounding box(es) for whatever the user wants to edit.
async function detectEditRegionsFromPrompt(
  imageUrl: string,
  editPrompt: string,
): Promise<Array<{ box: { x: number; y: number; width: number; height: number }; label: string }>> {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("XAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-4-1-fast-non-reasoning",
      messages: [
        {
          role: "system",
          content: "You analyze images and return ONLY JSON. No prose, no markdown.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `The user wants to make this edit: "${editPrompt}".

Identify the region(s) in the image that need to be repainted to apply this edit. For "change the comforter" mask the comforter. For "remove the lamp" mask the lamp. For "wearing a black bra" mask the bust area.

Return ONLY JSON:
{"regions": [{"label": "<region>", "box": {"x": <0-1>, "y": <0-1>, "width": <0-1>, "height": <0-1>}}]}

Be generous — pad boxes ~10% on each side. Coordinates are 0-1 normalized. If you can't find the target, return: {"regions": []}`,
            },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0,
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const content = String(data.choices?.[0]?.message?.content || "{}").trim();
  const cleaned = content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    const regions: any[] = Array.isArray(parsed.regions) ? parsed.regions : [];
    return regions
      .filter((r) => r?.box && typeof r.box.x === "number")
      .map((r) => ({
        label: String(r.label || "edit-region"),
        box: {
          x: clamp01(r.box.x),
          y: clamp01(r.box.y),
          width: clamp01(r.box.width),
          height: clamp01(r.box.height),
        },
      }));
  } catch {
    return [];
  }
}

// =============================================================================
// Darkroom Skin — proprietary house-signature skin pass.
// The prompt below is the IP. It never leaves this file: not echoed to API
// responses, not surfaced in Settings, not logged. Frontend only sends
// image_url + optional intensity.
// =============================================================================

// =============================================================================
// Detail Brush registry — hidden prompts for surgical NSFW-permissive region
// edits. Catalog is exposed via /api/detail-brushes (id + name + category +
// description only); the prompts themselves never leave this file.
// =============================================================================

type DetailBrush = {
  name: string;
  category: "Anatomy" | "Fabric" | "Lighting" | "Hair" | "Mood" | "Removal";
  description: string;
  prompt: string;          // hidden — never sent to client
  brushSizePx: number;     // suggested brush size in source-image space
  intensity: "low" | "medium" | "high";
  intensityLabel: string;
  dilatePct?: number;      // mask edge dilation, default 1.5%
};

const DETAIL_BRUSH_REGISTRY: Record<string, DetailBrush> = {
  // ============ ANATOMY ============
  "hard-nipples-subtle": {
    name: "Hard Nipples — Subtle",
    category: "Anatomy",
    description: "Soft erect nipples through fabric or on bare skin. Natural, photoreal.",
    prompt: "Erect nipples with natural areolae in this region. Pink-to-light-brown tone matching the skin's natural undertones. Subtle highlight from the existing lighting direction. Photorealistic skin texture with fine pore detail. If the region is covered by thin fabric, the nipple shape protrudes through the cotton creating a soft outline. Match the surrounding skin tone, freckle pattern, and lighting.",
    brushSizePx: 30,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.012,
  },
  "hard-nipples-visible": {
    name: "Hard Nipples — Visible",
    category: "Anatomy",
    description: "Pronounced erect nipples, fully visible through fabric or bare. Bolder.",
    prompt: "Strongly erect nipples with prominent areolae in this region. Pink-to-medium-brown tone. Defined shape with clear definition between nipple peak and areola base. Subtle highlight from existing lighting. Photorealistic skin texture. If the region is fabric, the nipples protrude clearly through the material creating a defined outline. Match surrounding skin tone, freckle pattern, and lighting direction.",
    brushSizePx: 32,
    intensity: "high",
    intensityLabel: "Bold",
    dilatePct: 0.015,
  },
  "nipple-pokes-fabric": {
    name: "Nipple Pokes (Under Fabric)",
    category: "Anatomy",
    description: "Visible nipple shape pushing through thin fabric. Cold-or-aroused look.",
    prompt: "Erect nipples pushing visibly through the thin fabric in this region, creating two soft circular protrusions in the cloth. The fabric stretches and tents over the nipple peak. Subtle shadow under each protrusion. Photorealistic fabric drape, matching the existing fabric's color, weave, and lighting. No skin shown — the nipple shape is read through the fabric only.",
    brushSizePx: 30,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.012,
  },
  "areola-pinker": {
    name: "Areola — Pinker Tone",
    category: "Anatomy",
    description: "Shifts areola color toward natural rose-pink. Subtle.",
    prompt: "Natural rose-pink areola in this region, with soft skin texture and fine pores. Match surrounding skin tone for seamless blend. Photorealistic, no plastic finish.",
    brushSizePx: 35,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.012,
  },
  "tan-lines-bikini": {
    name: "Tan Lines (Bikini)",
    category: "Anatomy",
    description: "Subtle bikini-line tan demarcation. Adds realism + sun-kissed vibe.",
    prompt: "A natural bikini tan line in this region — a soft transition from lightly tanned skin to slightly paler skin marking where a swimsuit covered the body. Gentle, realistic gradient, not a hard edge. Match the surrounding skin's color temperature and lighting.",
    brushSizePx: 12,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.02,
  },
  "tan-lines-shoulders": {
    name: "Tan Lines (Shoulders)",
    category: "Anatomy",
    description: "Shoulder-strap tan demarcation. Faint sun lines from a tank top or strap.",
    prompt: "Subtle shoulder-strap tan lines in this region — a faint paler band where a thin strap blocked sun. Soft gradient transition, photoreal, integrated with the surrounding skin tone and freckles.",
    brushSizePx: 10,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.02,
  },
  "tan-lines-hip": {
    name: "Tan Lines (Hip Bone)",
    category: "Anatomy",
    description: "Hip-bone tan line where low-rise bottoms ride. Sexy detail.",
    prompt: "A subtle tan line crossing this region, marking where low-rise bottoms covered the hip. Soft gradient from lightly sun-kissed skin to paler unexposed skin. Photoreal, natural lighting integration.",
    brushSizePx: 12,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.02,
  },
  "belly-button": {
    name: "Belly Button Detail",
    category: "Anatomy",
    description: "Adds or refines a natural belly button shadow + dimple.",
    prompt: "A natural innie belly button in this region, with soft shadow inside the dimple, fine skin folds, and matching skin tone. Photorealistic, integrated with the surrounding stomach skin texture and lighting.",
    brushSizePx: 25,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.012,
  },
  "collarbone-pop": {
    name: "Collarbone Pop",
    category: "Anatomy",
    description: "Defines collarbone shadow for that sculpted look.",
    prompt: "Defined collarbone in this region — a subtle horizontal shadow under the bone with a soft highlight on top of the bone catching the existing lighting. Photoreal anatomy, not exaggerated. Match surrounding skin tone and freckles.",
    brushSizePx: 60,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.012,
  },
  "cleavage-shadow": {
    name: "Cleavage Shadow",
    category: "Anatomy",
    description: "Soft shadow between the breasts. Adds dimension to flat-lit shots.",
    prompt: "Soft natural shadow between the breasts in this region, adding subtle dimension and depth. Smooth gradient, not a hard line. Photoreal, matching the existing lighting direction and skin tone.",
    brushSizePx: 40,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.02,
  },
  "cameltoe-subtle": {
    name: "Cameltoe — Subtle",
    category: "Anatomy",
    description: "Soft fabric definition along the labial cleft through tight bottoms. Natural.",
    prompt: "Subtle natural cameltoe definition in this region — the thin fabric of bottoms (panties, leggings, bikini, jeans, or whatever the existing garment is) follows the soft contour of the labial cleft, creating a gentle vertical fold or shadow line down the center, integrated with the existing fabric weave, drape, and lighting. Photoreal, anatomically natural, not exaggerated. Match the surrounding fabric color, texture, and lighting direction. Match the surrounding skin tone where any skin is visible.",
    brushSizePx: 30,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.012,
  },
  "cameltoe-pronounced": {
    name: "Cameltoe — Pronounced",
    category: "Anatomy",
    description: "More defined cameltoe through tight fabric. Bolder.",
    prompt: "Pronounced natural cameltoe definition in this region — the thin fabric of bottoms is pulled tight and follows the labial contour clearly, creating a defined vertical fold with subtle shadow on either side of the central cleft. Photoreal, anatomically realistic, integrated with the existing fabric weave and the lighting. Match the surrounding fabric color, drape, and lighting.",
    brushSizePx: 30,
    intensity: "high",
    intensityLabel: "Bold",
    dilatePct: 0.015,
  },

  // ============ FABRIC ============
  "wet-shirt-cling": {
    name: "Wet Shirt Cling",
    category: "Fabric",
    description: "Damp fabric clinging to skin, slight transparency, wet sheen.",
    prompt: "The fabric in this region is now wet — clinging to the body underneath, slightly translucent so the soft outline of the skin shows through, with subtle wet sheen highlights. Photoreal damp cotton texture, water following gravity, fabric color slightly darkened where wet. Integrated with the existing lighting and the surrounding dry fabric.",
    brushSizePx: 80,
    intensity: "high",
    intensityLabel: "Bold",
    dilatePct: 0.015,
  },
  "sheer-transparency": {
    name: "Sheer Transparency Boost",
    category: "Fabric",
    description: "Increases fabric transparency. See-through effect on thin material.",
    prompt: "The fabric in this region is now noticeably sheer, with the soft outline of the skin and body underneath visible through the material. Subtle, photoreal — not fully transparent, just see-through enough to suggest. Match the existing fabric's pattern, drape, and the lighting direction.",
    brushSizePx: 70,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.012,
  },
  "damp-cotton-wrinkle": {
    name: "Damp Cotton Wrinkle",
    category: "Fabric",
    description: "Natural damp-fabric wrinkles + slight cling. Less intense than wet-cling.",
    prompt: "The cotton fabric in this region shows natural damp-from-sweat-or-water wrinkles, slight cling to the body underneath, faint darkening where damp. Photoreal cotton drape and fold pattern. Match the surrounding fabric and lighting.",
    brushSizePx: 60,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.012,
  },

  // ============ LIGHTING ============
  "lip-gloss-shine": {
    name: "Lip Gloss Shine",
    category: "Lighting",
    description: "Wet/glossy highlight on lips. Glossy lip look.",
    prompt: "A glossy wet sheen on the lips in this region — soft highlight catching the existing lighting, suggesting clear lip gloss or recent wetness. Photoreal, lips natural color preserved underneath the gloss highlight. Subtle, not over-glossy.",
    brushSizePx: 25,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.01,
  },
  "eye-catchlight": {
    name: "Eye Catchlight",
    category: "Lighting",
    description: "A small reflective sparkle in the eye. Brings the gaze to life.",
    prompt: "A small, natural-looking catchlight reflection in the eye in this region — a single tiny bright pinpoint suggesting a window or light source. Photoreal eye anatomy, integrated with the existing iris color and surrounding skin.",
    brushSizePx: 8,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.005,
  },
  "skin-glow": {
    name: "Skin Glow (Honey)",
    category: "Lighting",
    description: "Warm honey-toned glow on skin. Golden hour finish.",
    prompt: "A warm honey-toned glow on the skin in this region, with soft golden-hour light catching the high points and subtle subsurface scattering in the shadows. Photoreal skin texture with visible pores preserved underneath the glow. Match the existing lighting direction.",
    brushSizePx: 100,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.025,
  },
  "subtle-blush": {
    name: "Subtle Blush",
    category: "Lighting",
    description: "Natural pink flush on cheeks. Warm, alive look.",
    prompt: "A natural pink blush on the skin in this region, soft and diffused, suggesting warmth or slight arousal. Photoreal, not makeup-applied, integrated with the existing skin tone and freckles.",
    brushSizePx: 50,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.02,
  },

  // ============ HAIR ============
  "flyaway-strands": {
    name: "Flyaway Strands",
    category: "Hair",
    description: "Wispy stray hairs adding natural realism. Counters AI-perfect hair.",
    prompt: "A few thin wispy flyaway hair strands in this region, photoreal individual fine hairs, matching the surrounding hair color and direction, lit by the existing lighting. Subtle, natural — like real hair behaves.",
    brushSizePx: 8,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.005,
  },
  "damp-hair-tendrils": {
    name: "Damp Hair Tendrils",
    category: "Hair",
    description: "Wet hair clumped into tendrils against skin. Post-shower / sweat look.",
    prompt: "Damp hair tendrils in this region — a few clumped strands of slightly wet hair, sticking together with subtle wet sheen, draping naturally against the skin or shoulder. Photoreal wet hair texture, matching the surrounding hair color and length.",
    brushSizePx: 14,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.01,
  },

  // ============ MOOD ============
  "parted-lips": {
    name: "Parted Lips",
    category: "Mood",
    description: "Slight gap between the lips, suggesting breath or anticipation.",
    prompt: "Lips slightly parted in this region, with a small natural gap between the upper and lower lip showing a hint of teeth or just darkness, photoreal lip shape preserved, gentle natural color. Same lighting as the rest of the face.",
    brushSizePx: 35,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.01,
  },
  "bite-lip": {
    name: "Bite Lip",
    category: "Mood",
    description: "Subtle teeth-grazing-lip expression. Suggestive without overdoing it.",
    prompt: "A subtle lip-bite expression in this region — the lower lip pulled slightly under the upper teeth with a gentle bite, indented and slightly paler where the teeth press. Photoreal, natural, not exaggerated. Match the existing lip color and lighting.",
    brushSizePx: 35,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.01,
  },
  "knowing-half-smile": {
    name: "Knowing Half-Smile",
    category: "Mood",
    description: "One corner of the mouth turned up — that 'I know what you're thinking' look.",
    prompt: "A subtle knowing half-smile in this region — one corner of the mouth turned up slightly, the other neutral, eyes warm. Photoreal expression, natural lip shape, not exaggerated. Match the surrounding face and lighting.",
    brushSizePx: 50,
    intensity: "medium",
    intensityLabel: "Medium",
    dilatePct: 0.012,
  },

  // ============ IMPERFECTIONS ============
  "single-beauty-mark": {
    name: "Single Beauty Mark",
    category: "Anatomy",
    description: "A small natural mole or beauty mark. Adds realism + character.",
    prompt: "A single natural beauty mark in this region — a small round mole, dark brown, slightly raised, photoreal skin texture around it. Looks like a real mole, not a dot of paint.",
    brushSizePx: 6,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.005,
  },
  "freckle-cluster": {
    name: "Freckle Cluster",
    category: "Anatomy",
    description: "Natural-looking freckle scatter. Adds skin texture realism.",
    prompt: "A natural freckle cluster in this region — small, irregularly-spaced light brown dots scattered across the skin, varying slightly in size and color. Photoreal skin with the freckles integrated naturally, matching the surrounding skin tone.",
    brushSizePx: 30,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.012,
  },
  "single-faint-scar": {
    name: "Faint Scar",
    category: "Anatomy",
    description: "A subtle healed scar line. Adds personality.",
    prompt: "A faint healed scar in this region — a thin slightly paler line, well-healed, integrated with the surrounding skin. Photoreal, natural, not fresh.",
    brushSizePx: 6,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.005,
  },
  "goosebumps": {
    name: "Goosebumps",
    category: "Anatomy",
    description: "Skin bumps suggesting cold or arousal. Subtle texture detail.",
    prompt: "Subtle goosebumps on the skin in this region — fine raised bumps creating a textured surface, with the existing fine vellus hairs slightly more visible standing on end. Photoreal skin micro-texture, matching the surrounding skin tone and lighting.",
    brushSizePx: 60,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.015,
  },
  "light-vellus-hair": {
    name: "Light Vellus Hair",
    category: "Anatomy",
    description: "Fine peach-fuzz body hair catching the light. Anti-airbrushed realism.",
    prompt: "Fine light vellus hair (peach-fuzz) on the skin in this region, individual very fine hairs catching the existing lighting, photoreal skin texture preserved underneath. Subtle, not coarse hair — just the natural fuzz that real skin has.",
    brushSizePx: 80,
    intensity: "low",
    intensityLabel: "Subtle",
    dilatePct: 0.018,
  },

  // ============ REMOVAL ============
  "remove-nip-cover": {
    name: "Remove Nip Cover",
    category: "Removal",
    description: "Removes pasties, star stickers, or nipple covers — restores bare skin.",
    prompt: "Remove the pasty, star sticker, or nipple cover in this region. Replace with natural bare skin showing the actual nipple and areola underneath, photoreal anatomy matching the surrounding chest skin tone, freckle pattern, and lighting.",
    brushSizePx: 35,
    intensity: "high",
    intensityLabel: "Full",
    dilatePct: 0.015,
  },
  "remove-bra-strap": {
    name: "Remove Bra Strap",
    category: "Removal",
    description: "Cleans bra strap from shoulder/back. Bare-shoulder finish.",
    prompt: "Remove the bra strap or shoulder strap visible in this region. Replace with natural bare skin matching the surrounding shoulder/back tone, freckles, and existing lighting. Photoreal, seamless.",
    brushSizePx: 25,
    intensity: "high",
    intensityLabel: "Full",
    dilatePct: 0.015,
  },
  "remove-underwear-line": {
    name: "Remove Underwear Line",
    category: "Removal",
    description: "Smooths visible panty line through clothing.",
    prompt: "Remove the visible underwear line or panty edge through clothing in this region. Replace with smooth fabric drape matching the surrounding clothing color, weave, and lighting.",
    brushSizePx: 50,
    intensity: "high",
    intensityLabel: "Full",
    dilatePct: 0.015,
  },
  "remove-watermark": {
    name: "Remove Watermark",
    category: "Removal",
    description: "Strips visible logos, watermarks, or stamps.",
    prompt: "Remove the watermark, logo, or text in this region. Replace with the natural background or skin/fabric that should be there, matching the surrounding texture, color, and lighting. Photoreal, seamless.",
    brushSizePx: 40,
    intensity: "high",
    intensityLabel: "Full",
    dilatePct: 0.015,
  },
};

const DARKROOM_SKIN_PROMPT_V1 = [
  "Enhance skin texture only.",
  "Add fine pore detail across the face, neck, chest, arms, and legs — visible but not overdone.",
  "Subtle micro-shine on the bridge of the nose, forehead, and shoulders.",
  "Faint peach-fuzz on the cheeks and upper lip.",
  "Soft redness at the cheekbones, knees, elbows, and the pads of the fingers.",
  "Light vellus body hair on the forearms catching the light.",
  "Subsurface scattering in soft skin areas — under the eyes, the inner forearm, the underside of the breasts, the inner thighs.",
  "Tiny natural imperfections: a freckle here, a faint scar there, slightly dry texture where lips meet skin, a hint of broken capillary at the inner corner of an eye.",
  "No airbrushing. No plastic. No glow.",
  "Skin should look like a high-end Kodak Portra portrait, not a beauty filter.",
  "Preserve identical face geometry, identical pose, identical clothing, identical background, identical lighting, identical color grade.",
  "Only the skin changes.",
].join(" ");

// =============================================================================
// P-Edit Prompt Optimizer
// Takes a user's raw P-Edit prompt and rewrites it to follow Pruna's
// documented prompt formula: ACTION_VERB + TARGET + PRESERVATION CLAUSE.
// Uses the prompting guide as system prompt; calls Grok (cheap, fast).
// =============================================================================

const PEDIT_GUIDE_SYSTEM = `You are a prompt optimizer for prunaai/p-image-edit (also called "P-Edit"), a sub-1-second image editing model on Replicate. Your job is to take a user's raw prompt and rewrite it to follow Pruna's documented best practices so P-Edit produces the best possible result.

# Pruna's documented prompt formula
ACTION_VERB + TARGET + PRESERVATION_CLAUSE

# The four trained verbs (use these explicitly)
- add
- remove
- modify
- transform

# Single-line template
{ACTION_VERB} {TARGET, with concrete attributes} {WHERE / spatial relation},
matching {style/lighting/perspective/material} of the original,
while keeping {explicit list of things that must not change} unchanged.

# Hard rules
1. Start with one of the four trained verbs (add / remove / modify / transform).
2. Include a "while keeping ... unchanged" clause at the end. This is the workhorse — without it the model "improves" things you didn't want touched.
3. Be specific about color, material, texture — not just object names.
4. Reference spatial relationships ("on the left", "behind the second figure").
5. Match style/lighting/perspective explicitly when adding new elements.
6. For multi-image input: refer to images as "image 1" and "image 2" exactly. Image 1 is the canvas; image 2+ are references.
7. For person edits, include "while keeping their facial features and identity" to preserve identity.
8. For object swaps, use a two-clause structure: "Replace X with Y in the same position, matching the original's lighting, perspective, and scale, while keeping the rest unchanged."
9. Use quotation marks around any literal text that should appear in the image.
10. NO vague verbs ("make it better", "fix this"). NO pronouns without referents ("change it to red").

# Pattern library

## Pattern: Add an object
Add {object, with attributes} {spatial location}, matching the {lighting | perspective | style | material} of the scene, while keeping all other elements unchanged.

## Pattern: Remove an object
Remove the {object} {spatial location}, preserving the {background texture | wall pattern | floor | scenery} where it used to be, while keeping the rest of the image unchanged.

## Pattern: Swap objects
Replace the {old object} with {new object, with attributes} in the same position, matching the original's lighting, perspective, and scale, while keeping the rest of the image unchanged.

## Pattern: Add a person
Add a {age + gender + build + clothing + posture} person {spatial relation to existing subjects}, matching the lighting, color grade, and depth-of-field of the scene, while keeping the existing subjects, background, and composition unchanged.

## Pattern: Remove a person
Remove the {description of person — "person in the red jacket on the left"} from the image, reconstructing the {background — "brick wall and sidewalk"} behind them naturally, while keeping all other subjects, the lighting, and the composition unchanged.

## Pattern: Person attribute change (single image)
Change the person's {hairstyle | outfit | expression} from {current state} to {desired state}, while keeping their facial features, body pose, position in frame, and the surrounding environment identical.

## Pattern: Person identity replace (two images)
Replace the person currently in image 1 with the person from image 2, keeping their facial features and identity from image 2, adopting the pose, body orientation, lighting, and outfit from image 1, matching the color grade and depth-of-field of image 1.

# Common failure modes to avoid
- Added object floats / wrong scale → add "in the same position as X, at a similar scale to Y"
- Removed object leaves a smudge → add "reconstructing the {wall / floor / sky} behind it naturally"
- Style of new element clashes → add "matching the {illustration style / photographic look / color palette} of the original"
- Identity drift after person edit → reframe as "modify" and explicitly preserve "facial features"

# CRITICAL — DO NOT INVENT MISSING DETAILS
If the user's prompt is missing required information (color, material, size, spatial relationship, preservation list, garment style, etc.), DO NOT invent it. Instead, insert an angle-bracket placeholder of the form <description of what's needed here> in the optimized prompt. The user will fill it in.

Examples of correct placeholder usage:
- User: "remove the chair" → Optimized: "Remove the chair <describe which chair: position, color, type>, reconstructing the <floor/wall/background behind it> naturally, while keeping all other elements unchanged."
- User: "add a hat" → Optimized: "Add a <hat type, color, material, e.g., 'wide-brim straw sun hat'> to the woman's head, matching the <lighting/color grade/perspective> of the scene, while keeping her facial features, body pose, position in frame, and the entire background unchanged."
- User: "change her dress to red" → Optimized: "Modify the woman's dress: change the color from <current dress color, e.g., 'blue cotton'> to red <specify shade and fabric, e.g., 'crimson satin'>, while keeping her facial features, body pose, position in frame, and the entire background unchanged."

You may include the small things you can reasonably infer (e.g., "the woman" if there's clearly a woman, "while keeping ... unchanged" preservation clauses based on subject type). But do NOT invent specifics like colors, brand names, materials, or spatial positions that the user didn't supply.

# Your output
Return ONLY a JSON object with this exact shape:
{
  "optimized_prompt": "<the rewritten prompt, ready to send to P-Edit, with <angle-bracket placeholders> for missing user-supplied details>",
  "verb": "add" | "remove" | "modify" | "transform",
  "changes": ["<short bullet describing each major change you made>", ...],
  "missing": ["<the angle-bracket text from each placeholder you inserted, in order>", ...],
  "warnings": ["<any concerns about the original prompt that you couldn't fix>", ...]
}

No prose, no markdown fences, just the JSON object.`;

async function handleOptimizePEditPrompt(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const rawPrompt = String(body.prompt || "").trim();
    const numImages = Number(body.num_images || 1);
    if (!rawPrompt) return Response.json({ error: "prompt required" }, { status: 400 });

    const userMessage = `User's raw prompt: "${rawPrompt}"
Number of input images for P-Edit: ${numImages}
${numImages > 1 ? "Multi-image — use 'image 1' / 'image 2' anchoring." : "Single image — use single-image patterns."}

Rewrite to optimal P-Edit form. Return JSON only.`;

    const grokRes = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("XAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-4-1-fast-non-reasoning",
        messages: [
          { role: "system", content: PEDIT_GUIDE_SYSTEM },
          { role: "user", content: userMessage },
        ],
        temperature: 0.2,
      }),
    });

    if (!grokRes.ok) {
      throw new Error(`Optimizer ${grokRes.status}: ${(await grokRes.text()).slice(0, 200)}`);
    }
    const data = await grokRes.json();
    const content = String(data.choices?.[0]?.message?.content || "{}").trim();
    const cleaned = content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Fallback: if the model didn't return JSON, treat the response as the optimized prompt
      parsed = { optimized_prompt: cleaned, verb: "modify", changes: ["raw response, JSON parse failed"], warnings: [] };
    }

    return Response.json({
      ok: true,
      optimized_prompt: String(parsed.optimized_prompt || rawPrompt),
      verb: parsed.verb || null,
      changes: Array.isArray(parsed.changes) ? parsed.changes : [],
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// /api/stamp-asset — composite a transparent-PNG asset onto the source image
// at given pixel position/size with selectable blend mode. No AI call.
// Body: { image_url, asset_url, x, y, w, h, rotation_rad?, blend? }
//   x,y,w,h are in source-image pixel space.
//   blend: "over" | "overlay" | "multiply" | "soft-light" | "hard-light" | "screen"
async function handleStampAsset(
  req: Request,
  deps: Pick<RouteDeps, "saveGeneration">
): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    const assetUrl = String(body.asset_url || "");
    const x = Math.round(Number(body.x || 0));
    const y = Math.round(Number(body.y || 0));
    const w = Math.max(1, Math.round(Number(body.w || 100)));
    const h = Math.max(1, Math.round(Number(body.h || 100)));
    const rot = Number(body.rotation_rad || 0);
    const blend = String(body.blend || "over") as any;

    if (!imageUrl || !assetUrl) {
      return Response.json({ error: "image_url and asset_url required" }, { status: 400 });
    }

    const sharp = (await import("sharp")).default;
    const { uploadToStorage, buildUploadPath } = await import("../supabase");

    const [baseDl, assetDl] = await Promise.all([fetch(imageUrl), fetch(assetUrl)]);
    if (!baseDl.ok) return Response.json({ error: `base fetch ${baseDl.status}` }, { status: 400 });
    if (!assetDl.ok) return Response.json({ error: `asset fetch ${assetDl.status}` }, { status: 400 });
    const baseBuf = Buffer.from(await baseDl.arrayBuffer());
    const assetBuf = Buffer.from(await assetDl.arrayBuffer());

    // Resize asset to target size (and rotate if needed)
    let prepared = sharp(assetBuf).resize(w, h, { fit: "fill" });
    if (Math.abs(rot) > 0.001) {
      prepared = prepared.rotate(rot * (180 / Math.PI), { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    }
    const preparedBuf = await prepared.png().toBuffer();
    const preparedMeta = await sharp(preparedBuf).metadata();

    // Compute top-left from center
    const left = Math.round(x - (preparedMeta.width || w) / 2);
    const top = Math.round(y - (preparedMeta.height || h) / 2);

    const outBuf = await sharp(baseBuf)
      .composite([{ input: preparedBuf, left, top, blend }])
      .png()
      .toBuffer();

    const url = await uploadBufferToStorage(outBuf, "image/png", buildUploadPath, uploadToStorage, "darkroom-stamp");

    try {
      await deps.saveGeneration({
        prompt: `[stamp:${blend}]`,
        image_url: url,
        engine: "darkroom-stamp",
      } as any);
    } catch {}

    return Response.json({ ok: true, url, blend });
  } catch (err: any) {
    return Response.json({ error: "Stamp failed: " + err.message }, { status: 500 });
  }
}

async function handleDetailBrush(
  req: Request,
  deps: Pick<RouteDeps, "saveGeneration">
): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    const maskB64Raw = String(body.mask_b64 || "");
    const brushId = String(body.brush_id || "");

    if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });
    if (!maskB64Raw) return Response.json({ error: "mask_b64 required" }, { status: 400 });
    if (!brushId) return Response.json({ error: "brush_id required" }, { status: 400 });

    const brush = DETAIL_BRUSH_REGISTRY[brushId];
    if (!brush) return Response.json({ error: "unknown brush" }, { status: 400 });

    const maskB64 = maskB64Raw.replace(/^data:image\/\w+;base64,/, "");

    const sharp = (await import("sharp")).default;
    const { uploadToStorage, buildUploadPath } = await import("../supabase");

    const maskBuf = Buffer.from(maskB64, "base64");
    const maskMeta = await sharp(maskBuf).metadata();
    const W = maskMeta.width || 1024;
    const H = maskMeta.height || 1024;

    // Browser canvas alpha → binary mask, dilated per brush settings.
    const alpha = await sharp(maskBuf)
      .ensureAlpha()
      .extractChannel(3)
      .threshold(10)
      .png()
      .toBuffer();

    const dilatePx = Math.max(2, Math.round(Math.min(W, H) * (brush.dilatePct ?? 0.015)));
    const blackBg = await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const maskBufFinal = await sharp(blackBg)
      .composite([{ input: alpha, blend: "screen" }])
      .blur(dilatePx)
      .threshold(80)
      .png()
      .toBuffer();

    const maskUrl = await uploadBufferToStorage(maskBufFinal, "image/png", buildUploadPath, uploadToStorage, "darkroom-detail-brush-mask");

    const editedBuf = await callFluxFillPro({
      imageUrl,
      maskUrl,
      prompt: brush.prompt,
    });

    // Detect blank/uniform-color results — fal.ai's content moderation
    // silently returns a black placeholder instead of an error. Catch it.
    const isBlank = await isImageBlankOrUniform(editedBuf);
    if (isBlank) {
      return Response.json({
        ok: false,
        error: "Detail brush blocked by content filter on this image. Try a softer brush, or use Strip via the Edit dropdown for explicit content.",
        brush_id: brushId,
      }, { status: 422 });
    }

    const resultUrl = await uploadBufferToStorage(editedBuf, "image/png", buildUploadPath, uploadToStorage, "darkroom-detail-brush");

    try {
      await deps.saveGeneration({
        prompt: `[detail-brush:${brushId}]`,
        image_url: resultUrl,
        engine: `darkroom-detail-brush`,
      } as any);
    } catch {}

    return Response.json({
      ok: true,
      url: resultUrl,
      brush_id: brushId,
      brush_name: brush.name,
      model: "darkroom-detail-brush",
    });
  } catch (err: any) {
    return Response.json({ error: "Detail brush failed" }, { status: 500 });
  }
}

// Detect images that are mostly a single color (Flux Fill's content-mod
// placeholder is uniform black). If <0.5% of pixels deviate from the dominant
// color, treat as blank.
async function isImageBlankOrUniform(buf: Buffer): Promise<boolean> {
  try {
    const sharp = (await import("sharp")).default;
    const { data, info } = await sharp(buf)
      .resize(64, 64, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    let varied = 0;
    const total = info.width * info.height;
    // Sample first pixel as the "expected" color
    const r0 = data[0], g0 = data[1], b0 = data[2];
    for (let i = 0; i < data.length; i += channels) {
      const dr = Math.abs(data[i] - r0);
      const dg = Math.abs(data[i + 1] - g0);
      const db = Math.abs(data[i + 2] - b0);
      if (dr + dg + db > 30) varied++;
    }
    return varied / total < 0.005; // <0.5% varies = uniform
  } catch {
    return false;
  }
}

async function handleDarkroomSkin(
  req: Request,
  deps: Pick<RouteDeps, "saveGeneration">
): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    const intensity = String(body.intensity || "medium") as "low" | "medium" | "high";
    if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });

    // Intensity is the only knob users get. Internal mapping is hidden.
    // (We don't expose strength values that would let users reverse-engineer
    // the underlying engine.)
    const strengthByIntensity = { low: 0.20, medium: 0.28, high: 0.38 };
    const _strength = strengthByIntensity[intensity];

    // Use PRO tier — looser edit moderation, better identity preservation.
    // (BASIC has stricter edit moderation per our Grok prompting research.)
    const grokRes = await fetch("https://api.x.ai/v1/images/edits", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("XAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-imagine-image-pro",
        prompt: DARKROOM_SKIN_PROMPT_V1,
        image: { url: imageUrl, type: "image_url" },
        n: 1,
      }),
    });

    if (!grokRes.ok) {
      // Log the actual upstream error server-side for debugging.
      const upstreamBody = await grokRes.text();
      console.error(`[darkroom-skin] upstream ${grokRes.status}:`, upstreamBody.slice(0, 500));

      // Classify and return a vendor-neutral, helpful user-facing message.
      const status = grokRes.status;
      let userMsg: string;
      if (status === 400 || status === 422) {
        // Likely content moderation refusal
        if (upstreamBody.toLowerCase().includes("moderation") || upstreamBody.toLowerCase().includes("content")) {
          userMsg = "Darkroom Skin declined this image (content filter). Try Skin (Enhancor) instead — it's permissive and pore-aware.";
        } else {
          userMsg = "Darkroom Skin couldn't process this image. Try a different source or Skin (Enhancor) for body skin.";
        }
      } else if (status === 401 || status === 403) {
        userMsg = "Darkroom Skin authentication issue. Try again in a moment.";
      } else if (status === 429) {
        userMsg = "Darkroom Skin rate limited. Wait a few seconds and try again.";
      } else if (status >= 500) {
        userMsg = "Darkroom Skin service temporarily unavailable. Try again or use Skin (Enhancor).";
      } else {
        userMsg = `Darkroom Skin failed (status ${status}). Try Skin (Enhancor) for skin pores.`;
      }

      return Response.json({ error: userMsg, upstream_status: status }, { status: 502 });
    }
    const data = await grokRes.json();
    const upstreamUrl = data.data?.[0]?.url;
    if (!upstreamUrl) return Response.json({ error: "Darkroom Skin produced no image" }, { status: 502 });

    // Re-host via our Supabase so the URL doesn't leak the provider domain.
    const dl = await fetch(upstreamUrl);
    if (!dl.ok) return Response.json({ error: "Darkroom Skin re-host failed" }, { status: 502 });
    const buf = Buffer.from(await dl.arrayBuffer());
    const { uploadToStorage, buildUploadPath } = await import("../supabase");
    const finalUrl = await uploadBufferToStorage(buf, "image/png", buildUploadPath, uploadToStorage, "darkroom-skin");

    try {
      await deps.saveGeneration({
        prompt: `[darkroom-skin]`,
        image_url: finalUrl,
        engine: "darkroom-skin-v1",
      } as any);
    } catch {}

    return Response.json({
      ok: true,
      url: finalUrl,
      model: "darkroom-skin-v1",
      intensity,
    });
  } catch (err: any) {
    return Response.json({ error: "Darkroom Skin pass failed" }, { status: 500 });
  }
}

// /api/blend — server-side blend of two images at given alpha.
// Body: { base_url, top_url, alpha }  (alpha 0..1, where 1 = full top, 0 = full base)
async function handleBlend(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const baseUrl = String(body.base_url || "");
    const topUrl = String(body.top_url || "");
    const alpha = Math.max(0, Math.min(1, Number(body.alpha)));
    if (!baseUrl || !topUrl) return Response.json({ error: "base_url and top_url required" }, { status: 400 });

    const sharp = (await import("sharp")).default;
    const { uploadToStorage, buildUploadPath } = await import("../supabase");

    const [baseDl, topDl] = await Promise.all([fetch(baseUrl), fetch(topUrl)]);
    if (!baseDl.ok) return Response.json({ error: `base fetch ${baseDl.status}` }, { status: 400 });
    if (!topDl.ok) return Response.json({ error: `top fetch ${topDl.status}` }, { status: 400 });
    const baseBuf = Buffer.from(await baseDl.arrayBuffer());
    const topBufRaw = Buffer.from(await topDl.arrayBuffer());

    const baseMeta = await sharp(baseBuf).metadata();
    const W = baseMeta.width || 1024;
    const H = baseMeta.height || 1024;

    // Resize top to base dimensions, set its alpha to the blend strength
    const topResized = await sharp(topBufRaw)
      .resize(W, H, { fit: "fill" })
      .ensureAlpha(alpha)
      .png()
      .toBuffer();

    const out = await sharp(baseBuf)
      .resize(W, H, { fit: "fill" })
      .composite([{ input: topResized, blend: "over" }])
      .png()
      .toBuffer();

    const url = await uploadBufferToStorage(out, "image/png", buildUploadPath, uploadToStorage, "blend");
    return Response.json({ ok: true, image_url: url });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// Use Grok Vision to look at BOTH images and write a P-Edit-tuned prompt
// that anchors the subject and the garment so P-Edit doesn't confuse them.
async function handleDescribeWearPrompt(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const personUrl = String(body.image_url || "");
    const garmentUrl = String(body.garment_url || "");
    if (!personUrl || !garmentUrl) {
      return Response.json({ error: "image_url and garment_url required" }, { status: 400 });
    }

    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("XAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-4-1-fast-non-reasoning",
        messages: [
          {
            role: "system",
            content:
              "You write prompts for P-Edit (Flux Kontext family) which takes 2 input images and a text prompt. Both images are uploaded — image 1 is the SUBJECT, image 2 is the GARMENT. The prompt must anchor the subject's identity (so P-Edit doesn't lose it) and command the garment swap. Output ONE paragraph, no markdown, no preamble. Format: '[describe the woman in image 1: hair, body position, environment]. Take the [describe garment in image 2 specifically: color, type, fabric] from the second image and dress her in it. Keep her face, hair, body shape, pose, and the background from the first image identical. Only the clothing changes. Photorealistic skin texture, soft natural lighting.'",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Image 1 (subject):" },
              { type: "image_url", image_url: { url: personUrl } },
              { type: "text", text: "Image 2 (garment to dress her in):" },
              { type: "image_url", image_url: { url: garmentUrl } },
              { type: "text", text: "Write the prompt." },
            ],
          },
        ],
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      throw new Error(`Grok ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const prompt = String(data.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
    if (!prompt) throw new Error("empty prompt");
    return Response.json({ ok: true, prompt });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// /api/wear-garment — P-Edit multi-image: person + garment ref → person wearing
// the garment. No mask needed. NSFW-permissive (disable_safety_checker).
// Body: { image_url, garment_url, prompt?, upscaler? }
// -----------------------------------------------------------------------------

async function handleWearGarment(
  req: Request,
  deps: Pick<RouteDeps, "saveGeneration">
): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    const garmentUrls: string[] = Array.isArray(body.garment_urls)
      ? body.garment_urls.filter(Boolean).map(String)
      : body.garment_url
        ? [String(body.garment_url)]
        : [];
    const upscaler = String(body.upscaler || "none") as "topaz" | "freepik" | "none";
    let prompt = String(body.prompt || "").trim();

    if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });
    if (garmentUrls.length === 0) return Response.json({ error: "at least one garment_url required" }, { status: 400 });

    if (!prompt) {
      // Pruna's documented prompt formula: ACTION_VERB + TARGET + PRESERVATION clause.
      // Trained verbs: add / remove / modify / transform. Multi-image syntax:
      // explicitly assign roles ("use image 1 as scene, image 2 as garment ref").
      const refList = garmentUrls.length === 1
        ? "the garment shown in image 2"
        : `the garment shown in images 2 through ${garmentUrls.length + 1} (multiple angles of the same item)`;
      prompt = `Modify the person in image 1: change their clothing to ${refList}, matching the color, fabric, cut, and texture of the garment reference, while keeping their facial features, hair, body pose, position in frame, the lighting, color grade, and the entire background of image 1 unchanged.`;
    }

    // P-Edit gets confused by transparent PNGs (interprets alpha as a mask
    // hint and regenerates the garment shape instead of dressing the subject).
    // Flatten any transparent garment refs onto a clean white background.
    const flattenedRefs = await Promise.all(garmentUrls.map(flattenTransparencyToWhite));

    let resultUrl = await callPEdit({
      imageUrl,
      prompt,
      refUrls: flattenedRefs,
    });

    if (upscaler === "topaz") {
      resultUrl = await callTopaz(resultUrl);
    } else if (upscaler === "freepik") {
      resultUrl = await callFreepikSkinEnhancer(resultUrl);
    }

    try {
      await deps.saveGeneration({
        prompt: `[wear-garment] ${prompt}`,
        image_url: resultUrl,
        engine: upscaler === "none" ? "p-edit-multi" : `p-edit-multi+${upscaler}`,
      } as any);
    } catch {}

    return Response.json({
      ok: true,
      image_url: resultUrl,
      model: upscaler === "none" ? "p-edit (multi-image)" : `p-edit (multi-image) + ${upscaler}`,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

async function handleDescribeGarment(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const garmentUrl = String(body.garment_url || "");
    if (!garmentUrl) return Response.json({ error: "garment_url required" }, { status: 400 });

    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("XAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-4-1-fast-non-reasoning",
        messages: [
          {
            role: "system",
            content:
              "You write short, vivid prompts for an AI inpainting model. The prompt will be paired with a garment reference image (Redux conditioning). Output ONE sentence describing the garment AS IF the woman in the source image is wearing it. Include color, fabric, cut, and key detail. End with: 'photorealistic skin texture, soft natural lighting'. No quotes, no preamble, no markdown.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Write the inpaint prompt for this garment." },
              { type: "image_url", image_url: { url: garmentUrl } },
            ],
          },
        ],
        temperature: 0.4,
      }),
    });
    if (!res.ok) {
      throw new Error(`Grok ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const description = String(data.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
    if (!description) throw new Error("empty description");
    return Response.json({ ok: true, prompt: description });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// /api/remove-bg — strip background → transparent PNG via BiRefNet on FAL.
// Body: { image_url } → { image_url }
// -----------------------------------------------------------------------------

async function handleRemoveBg(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });

    const res = await fetch("https://fal.run/fal-ai/birefnet/v2", {
      method: "POST",
      headers: {
        Authorization: `Key ${env("FAL_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image_url: imageUrl, output_format: "png" }),
    });
    if (!res.ok) {
      throw new Error(`BiRefNet ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    const url = data.image?.url || data.images?.[0]?.url;
    if (!url) throw new Error("BiRefNet returned no image");

    // Re-host to our Supabase so it doesn't expire and is CORS-friendly for the canvas
    const dl = await fetch(url);
    if (!dl.ok) throw new Error(`download ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const { uploadToStorage, buildUploadPath } = await import("../supabase");
    const finalUrl = await uploadBufferToStorage(buf, "image/png", buildUploadPath, uploadToStorage, "cutout");

    return Response.json({ ok: true, image_url: finalUrl });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// /api/auto-mask-garment
//   Body: { image_url, garment_url? , garment_type? }
//   1. Grok Vision classifies the garment (if URL given) → garment_type
//   2. Grok Vision finds the body region(s) on the source image that the
//      garment will cover, returns normalized bounding boxes.
//   3. Returns a soft white-on-black mask PNG (data URL) sized to the source.
//
//   The painter modal pre-fills its foreground canvas with this mask so the
//   user can refine before inpaint.
// -----------------------------------------------------------------------------

async function handleAutoMaskGarment(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    const garmentUrl = String(body.garment_url || "");
    let garmentType = String(body.garment_type || "").toLowerCase();
    if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });

    // Step 1: classify garment if not provided
    if (!garmentType && garmentUrl) {
      garmentType = await classifyGarmentWithGrok(garmentUrl);
    }
    if (!garmentType) garmentType = "lingerie_set"; // safe default

    // Step 2: figure out source dimensions
    const sharp = (await import("sharp")).default;
    const dl = await fetch(imageUrl);
    if (!dl.ok) return Response.json({ error: `fetch source ${dl.status}` }, { status: 400 });
    const sourceBuf = Buffer.from(await dl.arrayBuffer());
    const meta = await sharp(sourceBuf).metadata();
    const W = meta.width || 1024;
    const H = meta.height || 1024;

    // Step 3: have Grok Vision return bounding boxes for the body regions the
    // garment will cover.
    const regions = await detectGarmentRegionsWithGrok(imageUrl, garmentType);

    if (regions.length === 0) {
      return Response.json({
        ok: false,
        error: `Could not detect garment region for "${garmentType}". Paint manually.`,
        garment_type: garmentType,
      });
    }

    // Step 4: rasterize boxes → white-on-black mask, dilate slightly, soft edge
    const maskBuf = await rasterizeRegionsToMask(regions, W, H, 0.12);
    const dataUrl = `data:image/png;base64,${maskBuf.toString("base64")}`;

    return Response.json({
      ok: true,
      garment_type: garmentType,
      regions,
      mask_b64: dataUrl,
      width: W,
      height: H,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

async function classifyGarmentWithGrok(garmentUrl: string): Promise<string> {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("XAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-4-1-fast-non-reasoning",
      messages: [
        {
          role: "system",
          content:
            "You classify lingerie/clothing items. Return ONLY a single lowercase word from this list: bra, panty, bodysuit, teddy, lingerie_set, robe, dress, top, bottom, swimsuit, other. No prose, no JSON, no quotes — just the word.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "What is this garment? One word." },
            { type: "image_url", image_url: { url: garmentUrl } },
          ],
        },
      ],
      temperature: 0,
    }),
  });
  if (!res.ok) return "lingerie_set";
  const data = await res.json();
  const word = String(data.choices?.[0]?.message?.content || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z_]/g, "");
  const allowed = ["bra", "panty", "bodysuit", "teddy", "lingerie_set", "robe", "dress", "top", "bottom", "swimsuit", "other"];
  return allowed.includes(word) ? word : "lingerie_set";
}

const GARMENT_REGION_HINTS: Record<string, string> = {
  bra: "the upper torso / bust / breast region (collarbone down to just under the breasts, shoulder strap to shoulder strap)",
  panty: "the hip / crotch / pelvis region (top of hips down to upper thighs, hip to hip across the front)",
  bodysuit: "the entire torso plus hips (collarbone down to upper thighs, shoulder to shoulder)",
  teddy: "the entire torso plus hips (collarbone down to upper thighs)",
  lingerie_set: "TWO separate regions: (1) upper torso / bust, and (2) hip / crotch / pelvis area",
  robe: "the entire torso, arms, and upper legs",
  dress: "the entire body from shoulders to mid-thigh or below",
  top: "the upper torso / bust / chest region",
  bottom: "the hip / crotch / pelvis / upper thigh region",
  swimsuit: "TWO separate regions: (1) upper torso / bust, and (2) hip / crotch area",
  other: "the central body / torso region",
};

async function detectGarmentRegionsWithGrok(
  imageUrl: string,
  garmentType: string
): Promise<Array<{ label: string; box: { x: number; y: number; width: number; height: number } }>> {
  const hint = GARMENT_REGION_HINTS[garmentType] || GARMENT_REGION_HINTS.lingerie_set;
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("XAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-4-1-fast-non-reasoning",
      messages: [
        {
          role: "system",
          content: "You analyze images and return ONLY JSON. No prose, no markdown fences.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Find the body region(s) on the person in this image that should be masked so a "${garmentType}" garment can be inpainted there.

Region target: ${hint}.

Return ONLY a JSON object:
{"regions": [{"label": "<region name>", "box": {"x": <0-1 left>, "y": <0-1 top>, "width": <0-1>, "height": <0-1>}}]}

If the garment covers two distinct body areas (e.g., a lingerie_set has both bra and panty), return TWO regions.
Be generous — pad the boxes ~10% on each side. Coordinates are 0-1 normalized (0 = top-left, 1 = bottom-right). Return only regions for the body, NOT the face, neck, hands, feet, or background.

If no person is visible, return: {"regions": []}.`,
            },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0,
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const content = String(data.choices?.[0]?.message?.content || "{}").trim();
  const cleaned = content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    const regions: any[] = Array.isArray(parsed.regions) ? parsed.regions : [];
    return regions
      .filter((r) => r?.box && typeof r.box.x === "number")
      .map((r) => ({
        label: String(r.label || garmentType),
        box: {
          x: clamp01(r.box.x),
          y: clamp01(r.box.y),
          width: clamp01(r.box.width),
          height: clamp01(r.box.height),
        },
      }));
  } catch {
    return [];
  }
}

async function rasterizeRegionsToMask(
  regions: Array<{ box: { x: number; y: number; width: number; height: number } }>,
  W: number,
  H: number,
  pad = 0.1
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const composites = regions.map((r) => {
    const padX = r.box.width * pad;
    const padY = r.box.height * pad;
    const x = Math.max(0, Math.round((r.box.x - padX) * W));
    const y = Math.max(0, Math.round((r.box.y - padY) * H));
    const w = Math.min(W - x, Math.max(1, Math.round((r.box.width + padX * 2) * W)));
    const h = Math.min(H - y, Math.max(1, Math.round((r.box.height + padY * 2) * H)));
    return {
      input: {
        create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } },
      } as any,
      left: x,
      top: y,
    };
  });
  let canvas = sharp({
    create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).composite(composites);
  // Soft-blur the rectangle edges so the painter sees feathered ovals, not hard boxes.
  return sharp(await canvas.png().toBuffer())
    .blur(Math.max(8, Math.round(Math.min(W, H) * 0.012)))
    .threshold(60)
    .toColorspace("srgb")
    .png()
    .toBuffer();
}

// -----------------------------------------------------------------------------
// /api/sandwich-edit — clothe → safe-edit → unclothe pipeline.
// Lets you run mainstream editors (gpt-image-2 / nano-banana) on NSFW source
// images by temporarily putting clothes on the subject before the edit, then
// stripping them after. Body:
//   { image_url, edit_prompt, edit_engine: 'gpt'|'nano', upscaler? }
// -----------------------------------------------------------------------------

async function handleSandwichEdit(
  req: Request,
  deps: Pick<RouteDeps, "saveGeneration">
): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    const editPrompt = String(body.edit_prompt || "");
    const editEngine = String(body.edit_engine || "nano") as "gpt" | "nano";
    const upscaler = String(body.upscaler || "none") as "topaz" | "freepik" | "none";
    const clothePrompt = String(body.clothe_prompt || "Add a simple plain black tank top and shorts to the subject. Keep everything else identical.");
    const unclothePrompt = String(body.unclothe_prompt || "Remove the tank top and shorts. Restore the subject's original nude appearance. Keep everything else identical.");

    if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });
    if (!editPrompt) return Response.json({ error: "edit_prompt required" }, { status: 400 });

    // 1. Clothe via P-Edit (NSFW-permissive)
    const clothedUrl = await callPEdit({ imageUrl, prompt: clothePrompt });

    // 2. Run the safe edit on the clothed image
    let editedUrl = "";
    if (editEngine === "gpt") {
      editedUrl = await callGptImage2Edit({
        imageUrl: clothedUrl,
        prompt: editPrompt,
        size: GPT_SIZE,
        quality: GPT_QUALITY,
      });
    } else {
      editedUrl = await callNanoBanana({ imageUrl: clothedUrl, prompt: editPrompt });
    }

    // 3. Unclothe via P-Edit
    let finalUrl = await callPEdit({ imageUrl: editedUrl, prompt: unclothePrompt });

    if (upscaler === "topaz") {
      finalUrl = await callTopaz(finalUrl);
    } else if (upscaler === "freepik") {
      finalUrl = await callFreepikSkinEnhancer(finalUrl);
    }

    try {
      await deps.saveGeneration({
        prompt: `[sandwich:${editEngine}] ${editPrompt}`,
        image_url: finalUrl,
        engine: `sandwich-${editEngine}${upscaler !== "none" ? "+" + upscaler : ""}`,
      } as any);
    } catch {}

    return Response.json({
      ok: true,
      image_url: finalUrl,
      clothed_url: clothedUrl,
      edited_url: editedUrl,
      model: `sandwich (pedit → ${editEngine} → pedit)${upscaler !== "none" ? " + " + upscaler : ""}`,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// /api/resize — shrink an image to fit within target_size (default 1200) on the
// long edge. Preserves aspect ratio. Useful before sending to Grok which is
// slow on large images.
// -----------------------------------------------------------------------------

async function handleResize(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    const target = Math.max(256, Math.min(4096, Number(body.target_size || 1200)));
    if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });

    const sharp = (await import("sharp")).default;
    const { uploadToStorage, buildUploadPath } = await import("../supabase");

    const dl = await fetch(imageUrl);
    if (!dl.ok) return Response.json({ error: `fetch ${dl.status}` }, { status: 400 });
    const buf = Buffer.from(await dl.arrayBuffer());

    const resized = await sharp(buf)
      .resize(target, target, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();

    const meta = await sharp(resized).metadata();
    const url = await uploadBufferToStorage(resized, "image/png", buildUploadPath, uploadToStorage, "resize");

    return Response.json({
      ok: true,
      image_url: url,
      width: meta.width,
      height: meta.height,
      original_bytes: buf.byteLength,
      resized_bytes: resized.byteLength,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// /api/inpaint — paint-your-own-mask inpainting via Flux Fill Pro
//
// Body: { image_url, mask_b64, prompt, upscaler?: 'topaz'|'freepik'|'none' }
//   mask_b64 is a PNG data URL or raw base64. White pixels = repaint here.
// -----------------------------------------------------------------------------

async function handleInpaint(
  req: Request,
  deps: Pick<RouteDeps, "saveGeneration">
): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    const maskB64Raw = String(body.mask_b64 || "");
    const prompt = String(body.prompt || "");
    const upscaler = String(body.upscaler || "none") as "topaz" | "freepik" | "none";
    const garmentUrls: string[] = Array.isArray(body.garment_urls)
      ? body.garment_urls.filter(Boolean).map(String)
      : body.garment_url
        ? [String(body.garment_url)]
        : [];
    const garmentStrength = body.garment_strength !== undefined ? Number(body.garment_strength) : undefined;

    if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });
    if (!maskB64Raw) return Response.json({ error: "mask_b64 required" }, { status: 400 });
    if (!prompt) return Response.json({ error: "prompt required" }, { status: 400 });

    const maskB64 = maskB64Raw.replace(/^data:image\/\w+;base64,/, "");

    // Normalize the painted mask: force RGB, white-where-painted, black elsewhere.
    // Browser canvas exports RGBA where alpha encodes the brush. Convert alpha
    // > 0 to white so Flux Fill sees a clean binary mask.
    const sharp = (await import("sharp")).default;
    const { uploadToStorage, buildUploadPath } = await import("../supabase");
    const maskBuf = Buffer.from(maskB64, "base64");
    const maskMeta = await sharp(maskBuf).metadata();
    const W = maskMeta.width || 1024;
    const H = maskMeta.height || 1024;

    const alpha = await sharp(maskBuf)
      .ensureAlpha()
      .extractChannel(3)
      .threshold(10)
      .png()
      .toBuffer();

    const blackBg = await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const cleanMaskBuf = await sharp(blackBg)
      .composite([{ input: alpha, blend: "screen" }])
      .png()
      .toBuffer();

    const maskUrl = await uploadBufferToStorage(cleanMaskBuf, "image/png", buildUploadPath, uploadToStorage, "inpaint-mask");

    let imagePromptUrl: string | undefined;
    if (garmentUrls.length === 1) {
      imagePromptUrl = garmentUrls[0];
    } else if (garmentUrls.length > 1) {
      // Auto-collage multiple angles into one Redux ref
      imagePromptUrl = await collageImagesToSingle(garmentUrls, uploadToStorage, buildUploadPath);
    }

    const editedBuf = await callFluxFillPro({
      imageUrl,
      maskUrl,
      prompt,
      imagePromptUrl,
      imagePromptStrength: garmentStrength,
    });
    let resultUrl = await uploadBufferToStorage(editedBuf, "image/png", buildUploadPath, uploadToStorage, "inpaint");

    if (upscaler === "topaz") {
      resultUrl = await callTopaz(resultUrl);
    } else if (upscaler === "freepik") {
      resultUrl = await callFreepikSkinEnhancer(resultUrl);
    }

    try {
      await deps.saveGeneration({
        prompt: `[inpaint] ${prompt}`,
        image_url: resultUrl,
        engine: upscaler === "none" ? "flux-fill-pro" : `flux-fill-pro+${upscaler}`,
      } as any);
    } catch {}

    return Response.json({
      ok: true,
      image_url: resultUrl,
      mask_url: maskUrl,
      model: upscaler === "none" ? "flux-fill-pro" : `flux-fill-pro + ${upscaler}`,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// /api/detect-nsfw — Replicate-backed NSFW region detection
// -----------------------------------------------------------------------------

async function handleDetectNsfw(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });

    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("REPLICATE_API_TOKEN")}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({
        version: NSFW_DETECTOR_MODEL,
        input: { image: imageUrl, threshold: 0.5 },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`NSFW detect ${res.status}: ${err}`);
    }

    const data = await res.json();
    const regions: NsfwRegion[] = parseNsfwRegions(data.output);

    return Response.json({
      ok: true,
      regions,
      mask_url: data.output?.mask_url || null,
      raw: data.output,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

function parseNsfwRegions(output: unknown): NsfwRegion[] {
  if (!output || typeof output !== "object") return [];
  // Different Replicate models return different shapes; normalize defensively.
  const out: any = output;
  if (Array.isArray(out.detections)) {
    return out.detections
      .filter((d: any) => d?.box)
      .map((d: any) => ({
        label: String(d.label || "nsfw"),
        confidence: Number(d.confidence ?? d.score ?? 0),
        box: {
          x: Number(d.box.x ?? d.box[0]),
          y: Number(d.box.y ?? d.box[1]),
          width: Number(d.box.width ?? d.box[2]),
          height: Number(d.box.height ?? d.box[3]),
        },
      }));
  }
  return [];
}

// -----------------------------------------------------------------------------
// /api/smart-edit — gpt-image-2 first, Grok fallback, optional protect mask
// -----------------------------------------------------------------------------

type SmartEditBody = {
  image_url: string;
  prompt: string;
  mask_url?: string;        // protect-mask: white regions are PRESERVED
  prefer_model?: "gpt" | "grok" | "pedit" | "nano" | "auto";
  character?: string;
  scene?: string;
  size?: string;            // gpt-image-2 size, e.g. "1024x1024" / "2048x2048"
  quality?: "low" | "medium" | "high" | "auto";
};

type MakeNsfwBody = {
  image_url: string;
  prompt: string;            // edit prompt — P-Edit will transform freely
  upscaler?: "topaz" | "freepik" | "none";
  character?: string;
  scene?: string;
};

type SurgicalEditBody = {
  image_url: string;
  prompt: string;
  manual_mask_url?: string;   // optional client-painted mask (white = preserve)
  feather?: number;           // edge softening, default 8 px
  upscale_after?: boolean;    // optional Topaz pass after the edit
  character?: string;
  scene?: string;
};

async function handleSmartEdit(
  req: Request,
  deps: Pick<RouteDeps, "saveGeneration" | "getCharacter">
): Promise<Response> {
  try {
    const body: SmartEditBody = await req.json();
    if (!body.image_url) return Response.json({ error: "image_url required" }, { status: 400 });
    if (!body.prompt) return Response.json({ error: "prompt required" }, { status: 400 });

    const preferModel = body.prefer_model ?? "auto";
    let resultUrl = "";
    let modelUsed = "";
    let fallbackReason: string | null = null;

    // Explicit model paths
    if (preferModel === "pedit") {
      resultUrl = await callPEdit({ imageUrl: body.image_url, prompt: body.prompt });
      modelUsed = "p-image-edit";
    } else if (preferModel === "nano") {
      resultUrl = await callNanoBanana({ imageUrl: body.image_url, prompt: body.prompt });
      modelUsed = "nano-banana";
    } else if (preferModel === "grok") {
      resultUrl = await callGrokEdit({ imageUrl: body.image_url, prompt: body.prompt });
      modelUsed = "grok-imagine-image";
    } else if (preferModel === "gpt" || preferModel === "auto") {
      // gpt-image-2 first
      try {
        resultUrl = await callGptImage2Edit({
          imageUrl: body.image_url,
          maskUrl: body.mask_url,
          prompt: body.prompt,
          size: body.size ?? GPT_SIZE,
          quality: body.quality ?? GPT_QUALITY,
        });
        modelUsed = GPT_IMAGE_MODEL;
      } catch (err: any) {
        const msg = String(err?.message || err);
        const isContentRefusal =
          msg.includes("safety") ||
          msg.includes("content_policy") ||
          msg.includes("rejected") ||
          msg.includes("400");
        if (preferModel === "gpt" || !isContentRefusal) {
          if (preferModel === "gpt") throw err;
          fallbackReason = `gpt-image-2 error: ${msg.slice(0, 200)}`;
        } else {
          fallbackReason = "gpt-image-2 refused (content policy); falling back to P-Edit";
        }
      }

      // Auto fallback to P-Edit (handles NSFW + general edits) if gpt-image-2 didn't deliver.
      if (!resultUrl) {
        resultUrl = await callPEdit({ imageUrl: body.image_url, prompt: body.prompt });
        modelUsed = "p-image-edit";
      }
    }

    // Persist the generation
    const character = body.character ? await deps.getCharacter(body.character) : null;
    await deps.saveGeneration({
      character_id: character?.id,
      character_name: body.character || null,
      scene: body.scene || `[smart-edit] ${body.prompt.slice(0, 80)}`,
      model: modelUsed,
      image_url: resultUrl,
      revised_prompt: body.prompt,
    });

    return Response.json({
      ok: true,
      url: resultUrl,
      model: modelUsed,
      fallback_reason: fallbackReason,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// gpt-image-2 edit call
// -----------------------------------------------------------------------------

async function callGptImage2Edit(args: {
  imageUrl: string;
  maskUrl?: string;
  prompt: string;
  size: string;
  quality: string;
}): Promise<string> {
  // Fetch the image bytes; gpt-image-2 edit endpoint takes multipart with raw file.
  const imageBlob = await fetchAsBlob(args.imageUrl);
  const form = new FormData();
  form.append("model", GPT_IMAGE_MODEL);
  form.append("image", imageBlob, "image.png");
  form.append("prompt", args.prompt);
  form.append("size", args.size);
  form.append("quality", args.quality);
  if (args.maskUrl) {
    const maskBlob = await fetchAsBlob(args.maskUrl);
    form.append("mask", maskBlob, "mask.png");
  }

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`gpt-image-2 ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  // OpenAI returns { data: [{ b64_json: '...' }] } for gpt-image-1/2.
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) {
    // Some endpoints may return a URL instead — handle both.
    const url = data.data?.[0]?.url;
    if (url) return url;
    throw new Error("gpt-image-2 returned no image");
  }
  // Re-upload the b64 image to our Supabase storage so we get a stable URL.
  return await uploadBase64ToSupabase(b64);
}

// -----------------------------------------------------------------------------
// P-Edit (prunaai/p-image-edit) — workhorse for free-form edits incl. NSFW
// -----------------------------------------------------------------------------

async function callNanoBanana(args: { imageUrl: string; prompt: string }): Promise<string> {
  // Google Gemini 2.5 Flash Image ("Nano Banana") via FAL.
  // Fast, photoreal, less prone to scene reinterpretation than gpt-image-2.
  const res = await fetch("https://fal.run/fal-ai/nano-banana/edit", {
    method: "POST",
    headers: {
      Authorization: `Key ${env("FAL_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image_urls: [args.imageUrl],
      prompt: args.prompt,
      num_images: 1,
      output_format: "png",
    }),
  });
  if (!res.ok) {
    throw new Error(`Nano Banana ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = await res.json();
  const url = data.images?.[0]?.url || data.image?.url;
  if (!url) throw new Error("Nano Banana returned no image");
  return String(url);
}

async function callPEdit(args: { imageUrl: string; prompt: string; refUrls?: string[] }): Promise<string> {
  const images = [args.imageUrl, ...(args.refUrls || [])];
  const res = await fetch(
    "https://api.replicate.com/v1/models/prunaai/p-image-edit/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("REPLICATE_API_TOKEN")}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({
        input: {
          images,
          prompt: args.prompt,
          disable_safety_checker: true,
          turbo: false,
          aspect_ratio: "match_input_image",
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`P-Edit ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  if (data.status === "failed") {
    throw new Error(`P-Edit failed: ${data.error || "unknown"}`);
  }
  const output = data.output;
  const url = Array.isArray(output) ? output[0] : output;
  if (!url) throw new Error("P-Edit returned no image");
  return String(url);
}

// -----------------------------------------------------------------------------
// /api/make-nsfw — P-Edit transform → upscaler. The Joe pipeline.
// -----------------------------------------------------------------------------

async function handleMakeNsfw(
  req: Request,
  deps: Pick<RouteDeps, "saveGeneration" | "getCharacter">
): Promise<Response> {
  try {
    const body: MakeNsfwBody = await req.json();
    if (!body.image_url) return Response.json({ error: "image_url required" }, { status: 400 });
    if (!body.prompt) return Response.json({ error: "prompt required" }, { status: 400 });

    const upscaler = body.upscaler ?? "topaz";

    // Stage 1: P-Edit transforms the image (NSFW or anything else)
    const editedUrl = await callPEdit({
      imageUrl: body.image_url,
      prompt: body.prompt,
    });

    // Stage 2: upscale → realism
    let finalUrl = editedUrl;
    let upscalerUsed = "none";
    if (upscaler === "topaz") {
      finalUrl = await callTopaz(editedUrl);
      upscalerUsed = "topaz";
    } else if (upscaler === "freepik") {
      finalUrl = await callFreepikSkinEnhancer(editedUrl);
      upscalerUsed = "freepik";
    }

    // Persist the final result
    const character = body.character ? await deps.getCharacter(body.character) : null;
    await deps.saveGeneration({
      character_id: character?.id,
      character_name: body.character || null,
      scene: body.scene || `[make-nsfw] ${body.prompt.slice(0, 80)}`,
      model: `p-image-edit+${upscalerUsed}`,
      image_url: finalUrl,
      revised_prompt: body.prompt,
    });

    return Response.json({
      ok: true,
      url: finalUrl,
      stages: {
        edited_url: editedUrl,
        upscaled_url: finalUrl,
        upscaler: upscalerUsed,
      },
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

async function callTopaz(imageUrl: string): Promise<string> {
  // Submit + poll pattern matching media.ts
  const submitRes = await fetch("https://api.topazlabs.com/image/v1/upscale-and-enhance/async", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("TOPAZ_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image_url: imageUrl, model: "Bloom Realism" }),
  });
  if (!submitRes.ok) {
    throw new Error(`Topaz submit ${submitRes.status}: ${(await submitRes.text()).slice(0, 200)}`);
  }
  const submitData = await submitRes.json();
  const processId = submitData.process_id || submitData.id;

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const statusRes = await fetch(`https://api.topazlabs.com/image/v1/status/${processId}`, {
      headers: { Authorization: `Bearer ${env("TOPAZ_API_KEY")}` },
    });
    const statusData = await statusRes.json();
    if (statusData.status === "completed" || statusData.status === "succeeded") {
      const dlRes = await fetch(`https://api.topazlabs.com/image/v1/download/${processId}`, {
        headers: { Authorization: `Bearer ${env("TOPAZ_API_KEY")}` },
      });
      const dlData = await dlRes.json();
      return dlData.download_url || dlData.url || imageUrl;
    }
    if (statusData.status === "failed") {
      throw new Error(`Topaz failed: ${statusData.error || "unknown"}`);
    }
  }
  throw new Error("Topaz timed out after 2 minutes");
}

async function callFreepikSkinEnhancer(imageUrl: string): Promise<string> {
  const submitRes = await fetch(
    "https://api.freepik.com/v1/ai/image-upscaler",
    {
      method: "POST",
      headers: {
        "x-freepik-api-key": env("FREEPIK_API_KEY"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image: imageUrl, scale_factor: "2x" }),
    }
  );
  if (!submitRes.ok) {
    throw new Error(`Freepik ${submitRes.status}: ${(await submitRes.text()).slice(0, 200)}`);
  }
  const submitData = await submitRes.json();
  return submitData.data?.image_url || submitData.url || imageUrl;
}

// -----------------------------------------------------------------------------
// /api/surgical-edit — Joe's actual pipeline:
//   1. Detect NSFW regions (or use manual mask)
//   2. Composite white over those regions to sanitize the source
//   3. Send sanitized image + preserve-mask + edit prompt to gpt-image-2
//   4. Composite the ORIGINAL NSFW pixels back over the gpt-image-2 result
//   5. (Optional) Topaz upscale
// -----------------------------------------------------------------------------

async function handleSurgicalEdit(
  req: Request,
  deps: Pick<RouteDeps, "saveGeneration" | "getCharacter">
): Promise<Response> {
  try {
    const body: SurgicalEditBody = await req.json();
    if (!body.image_url) return Response.json({ error: "image_url required" }, { status: 400 });
    if (!body.prompt) return Response.json({ error: "prompt required" }, { status: 400 });

    const sharp = (await import("sharp")).default;
    const { uploadToStorage, buildUploadPath } = await import("../supabase");
    const feather = body.feather ?? 8;

    // Step 1: load original image bytes
    const originalRes = await fetch(body.image_url);
    if (!originalRes.ok) {
      throw new Error(`Failed to fetch source image: ${originalRes.status}`);
    }
    const originalBuf = Buffer.from(await originalRes.arrayBuffer());
    const originalMeta = await sharp(originalBuf).metadata();
    const width = originalMeta.width || 1024;
    const height = originalMeta.height || 1024;

    // Step 2: get the preserve-mask (white = preserve, black/transparent = editable)
    let preserveMaskBuf: Buffer;
    if (body.manual_mask_url) {
      const r = await fetch(body.manual_mask_url);
      if (!r.ok) throw new Error(`mask fetch failed: ${r.status}`);
      preserveMaskBuf = await sharp(Buffer.from(await r.arrayBuffer()))
        .resize(width, height, { fit: "fill" })
        .grayscale()
        .png()
        .toBuffer();
    } else {
      preserveMaskBuf = await detectAndBuildMask(body.image_url, width, height);
    }

    // Optional: feather the mask edges so the seam blends
    if (feather > 0) {
      preserveMaskBuf = await sharp(preserveMaskBuf).blur(feather).png().toBuffer();
    }

    // Ensure preserve mask is single-channel grayscale (extractChannel pulls one band)
    const maskAlphaBuf = await sharp(preserveMaskBuf)
      .extractChannel(0)
      .toColorspace("b-w")
      .png()
      .toBuffer();

    // Step 3: build the sanitized source — paste solid white over the preserve regions.
    // gpt-image-2 should see "blank silhouette" instead of skin/anatomy.
    const whiteOverlayRgb = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();

    // Compose the white overlay with the mask as its alpha channel:
    // RGB = pure white, alpha = mask (white pixels of mask → opaque white over original)
    const whiteOverlayWithAlpha = await sharp(whiteOverlayRgb)
      .joinChannel(maskAlphaBuf)
      .png()
      .toBuffer();

    const sanitizedMasked = await sharp(originalBuf)
      .composite([{ input: whiteOverlayWithAlpha, blend: "over" }])
      .png()
      .toBuffer();

    // For gpt-image-2's mask param: the model uses TRANSPARENT regions as edit-allowed.
    // So we want: transparent where editable, opaque where preserved.
    // Our maskAlphaBuf is single-channel grayscale (white = preserve).
    const gptMaskBuf = await maskToGptInpaintFormat(maskAlphaBuf, width, height);

    // Step 4: upload sanitized image + mask to Supabase so gpt-image-2 can fetch them
    // (gpt-image-2 edits endpoint takes file uploads; we'll use multipart directly)

    // Step 5: call gpt-image-2 edit endpoint
    let gptResultBuf: Buffer | null = null;
    let gptError: string | null = null;
    try {
      gptResultBuf = await callGptImage2EditWithBuffers({
        imageBuffer: sanitizedMasked,
        maskBuffer: gptMaskBuf,
        prompt: body.prompt,
      });
    } catch (err: any) {
      gptError = String(err?.message || err);
    }

    // Step 6: if gpt-image-2 refused, fall back to Flux Fill Pro on FAL
    let editedBuf: Buffer;
    let modelUsed = "gpt-image-2";
    if (gptResultBuf) {
      editedBuf = gptResultBuf;
    } else {
      // Flux Fill fallback — uploads, calls, downloads
      const sanitizedUrl = await uploadBufferToStorage(
        sanitizedMasked,
        "image/png",
        buildUploadPath,
        uploadToStorage,
        "surgical-sanitized",
      );
      const maskUploadBuf = await invertMaskForFluxFill(maskAlphaBuf, width, height);
      const maskUrl = await uploadBufferToStorage(
        maskUploadBuf,
        "image/png",
        buildUploadPath,
        uploadToStorage,
        "surgical-mask",
      );
      editedBuf = await callFluxFillPro({
        imageUrl: sanitizedUrl,
        maskUrl,
        prompt: body.prompt,
      });
      modelUsed = `flux-fill-pro (gpt-image-2 ${gptError ? "refused" : "n/a"})`;
    }

    // Step 7: composite ORIGINAL pixels back over the edited result, using the
    // preserve mask. This is the surgical-restore step — guarantees pixel
    // identity in the preserve region.
    // Build a 4-channel RGBA from the original + mask-as-alpha.
    const originalRgb = await sharp(originalBuf).removeAlpha().png().toBuffer();
    const originalWithMaskAlpha = await sharp(originalRgb)
      .joinChannel(maskAlphaBuf)
      .png()
      .toBuffer();

    const finalBuf = await sharp(editedBuf)
      .resize(width, height, { fit: "fill" })
      .composite([{ input: originalWithMaskAlpha, blend: "over" }])
      .png()
      .toBuffer();

    // Step 8: upload final
    const finalUrl = await uploadBufferToStorage(
      finalBuf,
      "image/png",
      buildUploadPath,
      uploadToStorage,
      "surgical",
    );

    // Optional Topaz pass
    let upscaledUrl: string | null = null;
    if (body.upscale_after) {
      try {
        upscaledUrl = await callTopaz(finalUrl);
      } catch (err: any) {
        // Topaz is optional — if it fails, just return the un-upscaled final
        upscaledUrl = null;
      }
    }

    // Persist
    const character = body.character ? await deps.getCharacter(body.character) : null;
    await deps.saveGeneration({
      character_id: character?.id,
      character_name: body.character || null,
      scene: body.scene || `[surgical-edit] ${body.prompt.slice(0, 80)}`,
      model: modelUsed,
      image_url: upscaledUrl || finalUrl,
      revised_prompt: body.prompt,
    });

    return Response.json({
      ok: true,
      url: upscaledUrl || finalUrl,
      stages: {
        sanitized: "applied",
        edited_url: finalUrl,
        upscaled_url: upscaledUrl,
        model: modelUsed,
        gpt_error: gptError,
      },
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// Surgical-edit helpers
// -----------------------------------------------------------------------------

async function detectAndBuildMask(imageUrl: string, width: number, height: number): Promise<Buffer> {
  // Use Grok Vision to identify NSFW regions and return normalized bounding boxes.
  // We then rasterize to a binary mask where white = preserve.
  const grokRes = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("XAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-4-1-fast-non-reasoning",
      messages: [
        {
          role: "system",
          content:
            "You analyze images and return ONLY JSON. No prose, no explanation, no markdown fences. Just raw JSON.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Identify regions of this image that show nudity, partial nudity, or sensitive body parts that should be MASKED OUT before sending to a content-filtered AI model. Include: bare breasts/nipples, exposed buttocks, genitals, panties/lingerie areas, any explicit skin in intimate zones.

Return ONLY a JSON object with this exact shape:
{"regions": [{"label": "<body part>", "box": {"x": <0-1 normalized left>, "y": <0-1 normalized top>, "width": <0-1 normalized width>, "height": <0-1 normalized height>}}]}

If no NSFW content is present, return: {"regions": []}.

Be GENEROUS with the bounding boxes — pad them slightly. Better to over-mask than under-mask. Coordinates are 0-1 normalized (0 = top-left, 1 = bottom-right).`,
            },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0,
    }),
  });

  if (!grokRes.ok) {
    throw new Error(`Grok Vision ${grokRes.status}: ${(await grokRes.text()).slice(0, 200)}`);
  }

  const grokData = await grokRes.json();
  const content = grokData.choices?.[0]?.message?.content?.trim() || "{}";
  // Strip code fences if Grok added them despite instructions
  const cleaned = content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = { regions: [] };
  }
  const rawRegions: any[] = Array.isArray(parsed.regions) ? parsed.regions : [];

  const sharp = (await import("sharp")).default;

  if (rawRegions.length === 0) {
    // No NSFW detected. Return all-black mask (nothing to preserve, whole image editable).
    return sharp({
      create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
  }

  // Convert normalized boxes to pixels, pad 10%, build white rectangles on a black canvas.
  const composites = rawRegions
    .filter((r) => r?.box && typeof r.box.x === "number")
    .map((r) => {
      const bx = clamp01(r.box.x);
      const by = clamp01(r.box.y);
      const bw = clamp01(r.box.width);
      const bh = clamp01(r.box.height);
      const padX = bw * 0.1;
      const padY = bh * 0.1;
      const x = Math.max(0, Math.round((bx - padX) * width));
      const y = Math.max(0, Math.round((by - padY) * height));
      const w = Math.min(width - x, Math.round((bw + padX * 2) * width));
      const h = Math.min(height - y, Math.round((bh + padY * 2) * height));
      return {
        input: {
          create: {
            width: Math.max(1, w),
            height: Math.max(1, h),
            channels: 3,
            background: { r: 255, g: 255, b: 255 },
          },
        } as any,
        left: x,
        top: y,
      };
    });

  if (composites.length === 0) {
    return sharp({
      create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
  }

  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

function clamp01(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

async function maskToGptInpaintFormat(
  maskAlphaBuf: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  // gpt-image-2 expects: transparent (alpha=0) where it should EDIT,
  // opaque (alpha=255) where it should PRESERVE.
  // maskAlphaBuf is single-channel grayscale (white = preserve).
  const sharp = (await import("sharp")).default;
  const blackBg = await sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  return sharp(blackBg).joinChannel(maskAlphaBuf).png().toBuffer();
}

async function invertMaskForFluxFill(
  maskAlphaBuf: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  // Flux Fill expects: white = INPAINT (edit), black = preserve.
  // maskAlphaBuf has white = preserve, so invert.
  const sharp = (await import("sharp")).default;
  return sharp(maskAlphaBuf).negate().png().toBuffer();
}

// If the garment image has transparent regions, flatten onto white. P-Edit
// (and most multi-image diffusion models) interpret alpha as a mask cue and
// produce garbage when it's left intact.
async function flattenTransparencyToWhite(url: string): Promise<string> {
  try {
    const sharp = (await import("sharp")).default;
    const { uploadToStorage, buildUploadPath } = await import("../supabase");
    const dl = await fetch(url);
    if (!dl.ok) return url;
    const buf = Buffer.from(await dl.arrayBuffer());
    const meta = await sharp(buf).metadata();
    if (!meta.hasAlpha) return url; // already opaque, no work needed
    const flattened = await sharp(buf)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();
    return await uploadBufferToStorage(flattened, "image/png", buildUploadPath, uploadToStorage, "garment-flattened");
  } catch {
    return url;
  }
}

async function collageImagesToSingle(
  urls: string[],
  uploadToStorage: any,
  buildUploadPath: any,
): Promise<string> {
  const sharp = (await import("sharp")).default;
  const TILE = 768;
  const cols = urls.length <= 2 ? urls.length : 2;
  const rows = Math.ceil(urls.length / 2);
  const W = TILE * cols;
  const H = TILE * rows;

  const buffers = await Promise.all(
    urls.slice(0, 4).map(async (u) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`fetch garment ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      return sharp(b)
        .resize(TILE, TILE, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .png()
        .toBuffer();
    }),
  );

  const composites = buffers.map((buf, i) => ({
    input: buf,
    left: (i % cols) * TILE,
    top: Math.floor(i / cols) * TILE,
  }));

  const out = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(composites)
    .png()
    .toBuffer();

  return uploadBufferToStorage(out, "image/png", buildUploadPath, uploadToStorage, "garment-collage");
}

async function uploadBufferToStorage(
  buf: Buffer, contentType: string,
  buildUploadPath: any, uploadToStorage: any,
  filename_prefix: string = "asset",
): Promise<string> {
  const filename = `${filename_prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`;
  const path = buildUploadPath("uploads", filename, contentType);
  return uploadToStorage(path, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), contentType);
}

async function callGptImage2EditWithBuffers(args: {
  imageBuffer: Buffer;
  maskBuffer: Buffer;
  prompt: string;
}): Promise<Buffer> {
  const form = new FormData();
  form.append("model", GPT_IMAGE_MODEL);
  form.append("image", new Blob([args.imageBuffer], { type: "image/png" }), "image.png");
  form.append("mask", new Blob([args.maskBuffer], { type: "image/png" }), "mask.png");
  form.append("prompt", args.prompt);
  form.append("size", GPT_SIZE);
  form.append("quality", GPT_QUALITY);

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`gpt-image-2 ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (b64) return Buffer.from(b64, "base64");
  const url = data.data?.[0]?.url;
  if (url) {
    const dlRes = await fetch(url);
    return Buffer.from(await dlRes.arrayBuffer());
  }
  throw new Error("gpt-image-2 returned no image");
}

async function callFluxFillPro(args: {
  imageUrl: string;
  maskUrl: string;
  prompt: string;
  imagePromptUrl?: string;       // Redux-style garment/style reference
  imagePromptStrength?: number;  // 0..1, default 0.6
}): Promise<Buffer> {
  // FAL endpoint for Flux Fill Pro inpainting — permissive, mask-aware.
  // image_prompt acts as a Redux conditioning image (garment, style, pose).
  const body: any = {
    image_url: args.imageUrl,
    mask_url: args.maskUrl,
    prompt: args.prompt,
    num_inference_steps: 50,
    guidance_scale: 20,
  };
  if (args.imagePromptUrl) {
    body.image_prompt = args.imagePromptUrl;
    body.image_prompt_strength = args.imagePromptStrength ?? 0.6;
  }
  const res = await fetch("https://fal.run/fal-ai/flux-pro/v1/fill", {
    method: "POST",
    headers: {
      Authorization: `Key ${env("FAL_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Flux Fill ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = await res.json();
  const url = data.images?.[0]?.url || data.image?.url;
  if (!url) throw new Error("Flux Fill returned no image");
  const dlRes = await fetch(url);
  return Buffer.from(await dlRes.arrayBuffer());
}

// -----------------------------------------------------------------------------
// Grok fallback
// -----------------------------------------------------------------------------

async function callGrokEdit(args: { imageUrl: string; prompt: string }): Promise<string> {
  const res = await fetch("https://api.x.ai/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("XAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-imagine-image",
      prompt: args.prompt,
      image: { url: args.imageUrl, type: "image_url" },
      n: 1,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Grok ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  const url = data.data?.[0]?.url;
  if (!url) throw new Error("Grok returned no image URL");
  return url;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function fetchAsBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.blob();
}

async function uploadBase64ToSupabase(b64: string): Promise<string> {
  const { uploadToStorage, buildUploadPath } = await import("../supabase");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const filename = `smart-edit-${Date.now()}.png`;
  const path = buildUploadPath("uploads", filename, "image/png");
  return uploadToStorage(path, bytes.buffer as ArrayBuffer, "image/png");
}
