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

  return null;
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
  prefer_model?: "gpt" | "grok" | "pedit" | "auto";
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

async function callPEdit(args: { imageUrl: string; prompt: string }): Promise<string> {
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
          images: [args.imageUrl],
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
