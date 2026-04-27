// =============================================================================
// src/server/enhancor.ts
//
// Enhancor AI API wrapper module for Darkroom.
//
// Purpose: Submit enhancement jobs to the Enhancor API, poll for completion,
//          and expose per-model typed wrappers (skin, lens, develop, etc.)
//
// Inputs:  ENHANCOR_API_KEY env var (required at call time, not module load)
// Outputs: { requestId } on submit; { status, result?, cost? } on status;
//          { result, cost? } on pollUntilDone
// Side effects: HTTP calls to apireq.enhancor.ai
// Failure behavior:
//   - Missing env var throws immediately with a clear message
//   - Non-2xx responses from the API throw an Error with status + body
//   - pollUntilDone throws on FAILED status or timeout
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnhancorModelSlug =
  | "realistic-skin"
  | "kora"
  | "kora-reality"
  | "detailed"
  | "upscaler"
  | "image-upscaler";

export type EnhancorStatus =
  | "PENDING"
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED";

export interface EnhancorRequest {
  slug: EnhancorModelSlug;
  params: Record<string, unknown>;
}

export interface EnhancorResponse {
  success: boolean;
  requestId: string;
}

export interface EnhancorStatusResponse {
  status: EnhancorStatus;
  result?: string;
  cost?: number;
}

// ---------------------------------------------------------------------------
// Area-lock booleans for the skin endpoint
// ---------------------------------------------------------------------------

export interface SkinAreaLocks {
  background?: boolean;
  skin?: boolean;
  nose?: boolean;
  eye_g?: boolean;
  r_eye?: boolean;
  l_eye?: boolean;
  r_brow?: boolean;
  l_brow?: boolean;
  r_ear?: boolean;
  l_ear?: boolean;
  mouth?: boolean;
  u_lip?: boolean;
  l_lip?: boolean;
  hair?: boolean;
  hat?: boolean;
  ear_r?: boolean;
  neck_l?: boolean;
  neck?: boolean;
  cloth?: boolean;
}

// ---------------------------------------------------------------------------
// Per-model parameter types
// ---------------------------------------------------------------------------

export interface SkinParams extends SkinAreaLocks {
  img_url: string;
  webhookUrl?: string;
  model_version?: "enhancorv1" | "enhancorv3";
  enhancementType?: "face" | "body";
  /** 0-100 */
  skin_refinement_level?: number;
  /**
   * v1: 0-5, v3: 0-3.
   * Note: intentional mixed-case from the API spec ("skin_realism_Level").
   */
  skin_realism_Level?: number;
  portrait_depth?: number;
  /** v3 only */
  output_resolution?: string;
  /** v3 only */
  mask_image_url?: string;
  /** v3 only */
  mask_expand?: number;
}

export interface LensParams {
  prompt: string;
  webhookUrl?: string;
  img_url?: string;
  generation_mode?: "normal" | "2k_pro" | "4k_ultra";
  image_size?:
    | "portrait_3:4"
    | "portrait_9:16"
    | "square"
    | "landscape_4:3"
    | "landscape_16:9"
    | `custom_${number}_${number}`;
  is_uncensored?: boolean;
  is_hyper_real?: boolean;
  // Internal — callers do NOT set this; wrappers inject it.
  model?: "kora_pro" | "kora_pro_cinema";
}

// lensReality shares most of LensParams but the endpoint is undocumented.
// Wire conservatively: only the clearly applicable params are typed here.
// Extend as the Enhancor team documents more.
export interface LensRealityParams {
  prompt: string;
  webhookUrl?: string;
  image_size?: LensParams["image_size"];
  generation_mode?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://apireq.enhancor.ai";

// Default placeholder webhook. Enhancor returns 400 if this is absent.
// Replace with the actual webhook endpoint once the routes/webhooks slice ships.
const PLACEHOLDER_WEBHOOK = "https://placeholder.darkroom.local/webhooks/enhancor";

function getApiKey(): string {
  const key = process.env.ENHANCOR_API_KEY;
  if (!key) {
    throw new Error(
      "[enhancor] ENHANCOR_API_KEY is not set. " +
        "Add it to your .env or environment before calling Enhancor."
    );
  }
  return key;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getApiKey(),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // ignore
    }
    throw new Error(
      `[enhancor] ${path} → HTTP ${response.status}: ${detail || response.statusText}`
    );
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Submit an enhancement job for any model slug.
 *
 * @param slug  - The Enhancor model slug (e.g. 'realistic-skin', 'kora')
 * @param params - Request parameters forwarded as-is to the queue endpoint.
 *                 webhookUrl defaults to the placeholder if not provided.
 */
export async function submitJob(
  slug: EnhancorModelSlug,
  params: Record<string, unknown>
): Promise<{ requestId: string }> {
  const payload = {
    webhookUrl: PLACEHOLDER_WEBHOOK,
    ...params,
  };

  const data = await apiPost<EnhancorResponse>(
    `/api/${slug}/v1/queue`,
    payload
  );

  if (!data.success || !data.requestId) {
    throw new Error(
      `[enhancor] submitJob (${slug}): unexpected response shape: ${JSON.stringify(data)}`
    );
  }

  return { requestId: data.requestId };
}

/**
 * Fetch the current status of an enhancement job.
 *
 * @param slug      - The Enhancor model slug used when the job was submitted.
 * @param requestId - The requestId returned by submitJob.
 */
export async function getStatus(
  slug: EnhancorModelSlug,
  requestId: string
): Promise<{ status: EnhancorStatus; result?: string; cost?: number }> {
  const data = await apiPost<EnhancorStatusResponse>(
    `/api/${slug}/v1/status`,
    { request_id: requestId }
  );

  return {
    status: data.status,
    result: data.result,
    cost: data.cost,
  };
}

/**
 * Poll a job until it reaches COMPLETED or FAILED, or until timeout.
 *
 * @param slug      - The Enhancor model slug used when the job was submitted.
 * @param requestId - The requestId returned by submitJob.
 * @param opts.intervalMs  - How often to poll (default: 8000 ms)
 * @param opts.timeoutMs   - Maximum wait time (default: 600000 ms / 10 min)
 */
export async function pollUntilDone(
  slug: EnhancorModelSlug,
  requestId: string,
  opts?: { intervalMs?: number; timeoutMs?: number }
): Promise<{ result: string; cost?: number }> {
  const intervalMs = opts?.intervalMs ?? 8000;
  const timeoutMs = opts?.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { status, result, cost } = await getStatus(slug, requestId);

    if (status === "COMPLETED") {
      if (!result) {
        throw new Error(
          `[enhancor] pollUntilDone (${slug}/${requestId}): COMPLETED but result is empty`
        );
      }
      return { result, cost };
    }

    if (status === "FAILED") {
      throw new Error(
        `[enhancor] pollUntilDone (${slug}/${requestId}): job FAILED`
      );
    }

    // PENDING | IN_QUEUE | IN_PROGRESS — keep waiting
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }

  throw new Error(
    `[enhancor] pollUntilDone (${slug}/${requestId}): timed out after ${timeoutMs}ms`
  );
}

// ---------------------------------------------------------------------------
// Per-model typed wrappers
// ---------------------------------------------------------------------------

/**
 * Submit a realistic-skin enhancement job.
 * Wraps /api/realistic-skin/v1/queue
 */
export async function skin(
  params: SkinParams
): Promise<{ requestId: string }> {
  const { webhookUrl, ...rest } = params;
  return submitJob("realistic-skin", {
    webhookUrl: webhookUrl ?? PLACEHOLDER_WEBHOOK,
    ...rest,
  });
}

/**
 * Submit a Kora Pro generation job (lens).
 * Wraps /api/kora/v1/queue with model='kora_pro'
 */
export async function lens(
  params: LensParams
): Promise<{ requestId: string }> {
  const { webhookUrl, ...rest } = params;
  return submitJob("kora", {
    model: "kora_pro",
    webhookUrl: webhookUrl ?? PLACEHOLDER_WEBHOOK,
    ...rest,
  });
}

/**
 * Submit a Kora Pro Cinema generation job.
 * Wraps /api/kora/v1/queue with model='kora_pro_cinema'
 *
 * Same params as lens() except `model` is injected automatically.
 */
export async function lensCinema(
  params: Omit<LensParams, "model">
): Promise<{ requestId: string }> {
  const { webhookUrl, ...rest } = params;
  return submitJob("kora", {
    model: "kora_pro_cinema",
    webhookUrl: webhookUrl ?? PLACEHOLDER_WEBHOOK,
    ...rest,
  });
}

/**
 * Submit a Kora Reality generation job.
 * Wraps /api/kora-reality/v1/queue
 *
 * NOTE: This endpoint is undocumented by Enhancor. Params wired conservatively.
 * Extend LensRealityParams as the API is documented further.
 */
export async function lensReality(
  params: LensRealityParams
): Promise<{ requestId: string }> {
  const { webhookUrl, ...rest } = params;
  return submitJob("kora-reality", {
    webhookUrl: webhookUrl ?? PLACEHOLDER_WEBHOOK,
    ...rest,
  });
}

/**
 * Submit a detailed-enhancement job (develop).
 * Wraps /api/detailed/v1/queue
 */
export async function develop(params: {
  img_url: string;
  webhookUrl?: string;
}): Promise<{ requestId: string }> {
  return submitJob("detailed", {
    webhookUrl: params.webhookUrl ?? PLACEHOLDER_WEBHOOK,
    img_url: params.img_url,
  });
}

/**
 * Submit a portrait-upscaler job (sharpenPortrait).
 * Wraps /api/upscaler/v1/queue
 */
export async function sharpenPortrait(params: {
  img_url: string;
  mode: "fast" | "professional";
  webhookUrl?: string;
}): Promise<{ requestId: string }> {
  return submitJob("upscaler", {
    webhookUrl: params.webhookUrl ?? PLACEHOLDER_WEBHOOK,
    img_url: params.img_url,
    mode: params.mode,
  });
}

/**
 * Submit a general image-upscaler job (sharpen).
 * Wraps /api/image-upscaler/v1/queue
 */
export async function sharpen(params: {
  img_url: string;
  webhookUrl?: string;
}): Promise<{ requestId: string }> {
  return submitJob("image-upscaler", {
    webhookUrl: params.webhookUrl ?? PLACEHOLDER_WEBHOOK,
    img_url: params.img_url,
  });
}
