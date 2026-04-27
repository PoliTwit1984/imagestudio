import { checkAuth } from "../auth";
import { env, SUPABASE_URL } from "../config";
import { encodeFilterValue, supaHeaders, toStorageSlug } from "../supabase";
import {
  CUBE_FLOATS,
  CUBE_LEN,
  SIZE as LUT_SIZE,
  encodeHaldClut,
  decodeHaldClut,
  cubeToText,
  cubeToXmp,
} from "../lut";
import {
  skin,
  lens,
  lensCinema,
  lensReality,
  develop,
  sharpenPortrait,
  sharpen,
  getStatus as enhancorGetStatus,
} from "../enhancor";
import type { RouteDeps } from "./types";

// =============================================================================
// Quota middleware (wave 39)
//
// Pairs with src/server/billing.ts (wave 38). Public surface:
//
//   * extractUserId(req)              — pull a user id from the x-user-id header,
//                                       returning null when unset/invalid. v1
//                                       hook until per-user auth is wired.
//   * checkQuotaOrReject(req, metric) — gate a route. Returns null when the user
//                                       is under quota OR unauthed (silent
//                                       passthrough — single shared bearer
//                                       today, no per-user enforcement). Returns
//                                       a 402 Response when over quota.
//   * incrementUsageBackground(req,m) — fire-and-forget +1 against the user's
//                                       monthly counter. Always non-fatal.
//
// 402 response shape (consumed by the upgrade modal so it can target the
// metric that hit):
//   { error, quota_exceeded: true, metric, used, limit, tier, remaining }
//
// TODO(per-user-auth): when checkAuth() / Supabase Auth gives us a real
// session.user.id, replace the x-user-id header read with that lookup. The
// silent passthrough below preserves existing behavior in the meantime.
// =============================================================================

function extractUserId(req: Request): string | null {
  // v1: optional x-user-id header. When auth is wired per-user, this becomes
  // a real session lookup. Until then, null = unauthed = free-tier passthrough.
  const fromHeader = req.headers.get("x-user-id");
  if (fromHeader && /^[a-f0-9-]{8,}$/i.test(fromHeader)) return fromHeader;
  return null;
}

async function checkQuotaOrReject(
  req: Request,
  metric: import("../billing").BillingMetric,
): Promise<Response | null> {
  const userId = extractUserId(req);
  // TODO(per-user-auth): silent passthrough until checkAuth surfaces a real
  // user id. Single shared bearer today — enforcing on it would either gate
  // every caller (broken) or bucket all calls under one synthetic id (lies
  // in usage_quota). Better to no-op until the upgrade modal has a real
  // identity to send back.
  if (!userId) return null;

  const { checkQuota } = await import("../billing");
  const check = await checkQuota(userId, metric);
  if (check.ok) return null;

  return Response.json(
    {
      error: `Quota exceeded for ${metric}. You've used ${check.used} of ${check.limit} this month on ${check.tier} tier.`,
      quota_exceeded: true,
      metric: check.metric,
      used: check.used,
      limit: check.limit,
      tier: check.tier,
      remaining: check.remaining,
    },
    { status: 402 },
  );
}

async function incrementUsageBackground(
  req: Request,
  metric: import("../billing").BillingMetric,
): Promise<void> {
  const userId = extractUserId(req);
  if (!userId) return;
  try {
    const { incrementUsage } = await import("../billing");
    await incrementUsage(userId, metric, 1);
  } catch (e) {
    console.warn("[quota] incrementUsage failed (non-fatal):", e);
  }
}

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

// Identity anchor: prepended server-side to single-image Glance (Nano Banana)
// and Lens (Grok) edit prompts so the engine preserves the subject's identity.
// NOT applied to sandwich-edit, surgical-edit, brush/inpaint, or any flow that
// uses a mask or a second reference image — those carry their own identity
// logic (mask-bound preservation, face-swap targeting, etc.).
const IDENTITY_ANCHOR = "keep her face, hair, body shape, pose unchanged";

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
  // ---------------------------------------------------------------------------
  // /api/edit watch dispatcher (Watch engine — auto-routing).
  //
  // POST /api/edit with body.engine === "watch":
  //   1. Pull (or compute) the source image's content profile.
  //   2. Hard-refuse if profile.minor_concern || profile.violence (422).
  //   3. Otherwise apply pickWatchEngine() rules → choose lens/glance/strip/
  //      brush/eye based on profile + prompt intent + mask/ref presence.
  //   4. Dispatch to the corresponding internal engine call and return the
  //      result with a watch_decision: { chosen_engine, reason, profile }
  //      field appended so the UI can surface what fired.
  //
  // body._watch is set as a re-entry guard — if any future callsite
  // accidentally produces engine="watch" while this handler is dispatching
  // downstream, the guard short-circuits to a friendly fallback instead of
  // recursing.
  //
  // Note on route ordering: handleGenerationRoutes also registers
  // POST /api/edit (for engines fal/pedit/grok) and is dispatched before
  // handleSafeEditRoutes in the routes/index.ts chain. The watch handler
  // here is therefore reached when (a) a downstream caller invokes
  // handleSafeEditRoutes directly (tests, future composition), or (b) the
  // route order is adjusted so safe-edit catches /api/edit first. The
  // implementation is fully self-contained: no recursive HTTP self-calls,
  // no dependency on handleGenerationRoutes — engine dispatch fans out to
  // the per-engine call functions (callGrokEdit, callNanoBanana, etc.)
  // already defined in this file.
  // ---------------------------------------------------------------------------
  if (url.pathname === "/api/edit" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    let watchBody: any = null;
    try {
      watchBody = await req.clone().json();
    } catch {
      // Body unreadable as JSON — fall through so the regular handler can
      // surface a 400. Do NOT swallow the request here.
      watchBody = null;
    }
    if (watchBody && watchBody.engine === "watch" && !watchBody._watch) {
      return handleWatchRoute(watchBody, deps);
    }
    // Not engine="watch" — let downstream handlers (or 404) take it.
    return null;
  }

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

  if (url.pathname === "/api/details/skin-tone-match" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleSkinToneMatch(req);
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
    // Source order: detail_brush_assets DB table → DETAIL_BRUSH_REGISTRY fallback.
    const registry = await getDetailBrushAssets({});
    return Response.json({
      brushes: Object.entries(registry).map(([id, b]) => ({
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

  if (url.pathname === "/api/analyze-image" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleAnalyzeImage(req);
  }

  // ---------------------------------------------------------------------------
  // /api/face-lock/drift-check — vision-based face similarity between two
  // images (typically a "before" version and an "after" edit result). Used by
  // the UI to flag edits where the face drifted away from the source identity
  // (a common failure mode of Eye / gpt-image-2 outputs and high-temperature
  // re-routing chains).
  //
  // Body: { before_url: string, after_url: string }
  // Returns:
  //   {
  //     similarity: number (0..1, higher = same person),
  //     drift_level: 'identical' | 'minor' | 'moderate' | 'significant' |
  //                  'no_face' | 'face_count_mismatch',
  //     face_count_before: integer,
  //     face_count_after:  integer,
  //     notable_differences?: string,
  //     same_person?: boolean | null,
  //   }
  //
  // Implementation: a single multi-image Grok Vision call (the same chat
  // completions endpoint we already use in handleAnalyzeImage) with both
  // images attached to one user-message content array. Grok-2-vision and
  // grok-4-1-fast-non-reasoning both accept multi-image payloads where the
  // "content" field is an ordered array of image_url + text parts. We use
  // the same model the rest of the codebase uses for vision classification
  // so we don't introduce a new vendor dependency.
  // ---------------------------------------------------------------------------
  if (url.pathname === "/api/face-lock/drift-check" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleFaceLockDriftCheck(req);
  }

  if (url.pathname === "/api/asset-chain" && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!SUPABASE_URL) return Response.json({ error: "supabase not configured" }, { status: 503 });
    try {
      const id = url.searchParams.get("id");
      const sourceUrl = url.searchParams.get("source_url");
      if (!id && !sourceUrl) {
        return Response.json({ error: "id or source_url required" }, { status: 400 });
      }
      const headers = supaHeaders();

      // 1. Resolve the seed asset
      const seedQuery = id
        ? `id=eq.${encodeFilterValue(id)}`
        : `source_url=eq.${encodeFilterValue(sourceUrl!)}`;
      const seedResp = await fetch(
        `${SUPABASE_URL}/rest/v1/assets?${seedQuery}&select=*&limit=1`,
        { headers },
      );
      if (!seedResp.ok) return Response.json({ error: `seed lookup ${seedResp.status}` }, { status: 502 });
      const seedRows = await seedResp.json();
      const seed = seedRows[0];
      if (!seed) return Response.json({ error: "asset not found" }, { status: 404 });

      // 2. Walk UP via parent_id to find root
      const ancestors: any[] = [];
      let cur: any = seed;
      const seenUp = new Set<string>([seed.id]);
      let upHops = 0;
      while (cur?.parent_id && upHops < 20) {
        if (seenUp.has(cur.parent_id)) break;
        const parentResp = await fetch(
          `${SUPABASE_URL}/rest/v1/assets?id=eq.${encodeFilterValue(cur.parent_id)}&select=*&limit=1`,
          { headers },
        );
        if (!parentResp.ok) break;
        const rows = await parentResp.json();
        const parent = rows[0];
        if (!parent) break;
        ancestors.unshift(parent);
        seenUp.add(parent.id);
        cur = parent;
        upHops++;
      }
      const root = ancestors[0] || seed;

      // 3. BFS DOWN from root to collect all descendants
      const descendants: any[] = [];
      let frontier = [root.id];
      const seenDown = new Set<string>([root.id]);
      let depth = 0;
      while (frontier.length && depth < 8) {
        const inList = frontier.map((x) => `"${x}"`).join(",");
        const childResp = await fetch(
          `${SUPABASE_URL}/rest/v1/assets?parent_id=in.(${encodeURIComponent(inList)})&select=*&limit=200`,
          { headers },
        );
        if (!childResp.ok) break;
        const rows = await childResp.json();
        const fresh = rows.filter((r: any) => !seenDown.has(r.id));
        if (!fresh.length) break;
        for (const r of fresh) {
          descendants.push(r);
          seenDown.add(r.id);
        }
        frontier = fresh.map((r: any) => r.id);
        depth++;
      }

      return Response.json({
        ok: true,
        seed_id: seed.id,
        root,
        nodes: [root, ...descendants.filter((d) => d.id !== root.id)],
        ancestors_walked: upHops,
        descendants_found: descendants.filter((d) => d.id !== root.id).length,
      });
    } catch (e: any) {
      return Response.json({ error: e?.message || "asset-chain failed" }, { status: 500 });
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/replay-chain — re-execute a saved edit chain on a new source.
  //
  //   Body: { chain_root_asset_id, new_source_url }
  //   Response: { ok: true, job_id, step_count }
  //
  // Walks the chain anchored at `chain_root_asset_id` (BFS down via
  // parent_id), picks ROOT → most-recent leaf as the canonical edit path,
  // then dispatches a spawnJob() that re-applies each step's
  // (engine + prompt + params) on top of `new_source_url` in sequence,
  // chaining intermediate URLs. The final result lands as a new asset row
  // whose parent_id is the asset for new_source_url (when one exists),
  // so the replayed chain shows up as a sibling branch in the history
  // graph the next time the user opens it.
  //
  // Async by design — chains can be 5-15 edits deep and each step is a
  // 5-30s vendor call. UI polls /api/jobs/:id (already wired into the
  // Active Jobs panel) for status / progress / final output_asset_id.
  //
  // See darkroom.catalog.replay-edit-chain.
  // ---------------------------------------------------------------------------
  if (url.pathname === "/api/replay-chain" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const quotaReject = await checkQuotaOrReject(req, "chains_runs");
    if (quotaReject) return quotaReject;
    if (!SUPABASE_URL) return Response.json({ error: "supabase not configured" }, { status: 503 });
    try {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid_json_body" }, { status: 400 });
      }
      const chainRootId = String(body.chain_root_asset_id || "").trim();
      const newSourceUrl = String(body.new_source_url || "").trim();
      if (!chainRootId || !newSourceUrl) {
        return Response.json(
          { error: "chain_root_asset_id and new_source_url required" },
          { status: 400 },
        );
      }

      // Resolve the chain to a flat edit sequence BEFORE spawning the job —
      // a missing/empty chain should surface as a 4xx synchronously, not
      // get buried in a job-row failure that the user has to poll for.
      const sequence = await buildEditSequenceFromChain(chainRootId);
      if (!sequence.length) {
        return Response.json(
          { error: "chain has no edit steps (only root)", chain_root_asset_id: chainRootId },
          { status: 400 },
        );
      }

      const { job_id } = await spawnJob(deps, {
        engine: "replay",
        job_type: "chain-run",
        params: {
          chain_root_asset_id: chainRootId,
          new_source_url: newSourceUrl,
          step_count: sequence.length,
        },
        worker: async (jobId, updateProgress) => {
          try {
            const result = await executeEditSequence(
              newSourceUrl,
              sequence,
              updateProgress,
            );

            // Cradle the final result into the assets table as a new edit
            // row whose parent_id chains back to whatever asset was at
            // new_source_url (so the replayed chain renders as a branch
            // in the history graph rooted at the new source). Failure to
            // catalog is non-fatal — the job still completed.
            let outputAssetId: string | null = null;
            try {
              const parentId = await (deps as any).lookupAssetIdByUrl?.(newSourceUrl);
              outputAssetId = await (deps as any).saveAsset?.({
                asset_type: "edit",
                source_url: result.final_url,
                engine: "replay",
                edit_action: "replay-chain",
                prompt: `Replay of chain ${chainRootId}`,
                parent_id: parentId || null,
                metadata: {
                  replay_chain_root: chainRootId,
                  replay_steps: sequence.length,
                  replay_steps_applied: result.steps_applied,
                  replay_steps_skipped: result.steps_skipped,
                  intermediate_urls: result.intermediate_urls,
                  new_source_url: newSourceUrl,
                  job_id: jobId,
                },
                tags: ["replay", "chain"],
              });
            } catch (e) {
              console.error("[replay-chain] saveAsset failed (non-fatal):", e);
            }

            return {
              output_url: result.final_url,
              output_asset_id: outputAssetId || undefined,
            };
          } catch (e: any) {
            // Cancellation rebubbles to spawnJob to skip the failed-state
            // PATCH; everything else gets classified as a service failure.
            if (e instanceof CancellationError) throw e;
            return {
              error: String(e?.message || e),
              error_class: "service",
            };
          }
        },
      });

      void incrementUsageBackground(req, "chains_runs");
      return Response.json({ ok: true, job_id, step_count: sequence.length });
    } catch (e: any) {
      return Response.json({ error: e?.message || "replay-chain failed" }, { status: 500 });
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/chains/run — execute an inline or saved chain definition on a
  // fresh source URL.
  //
  //   Body (Mode A — inline):
  //     { chain_definition: [{ engine, prompt, params? }, ...], source_url, user_id? }
  //   Body (Mode B — saved):
  //     { chain_id: <slug>, source_url, user_id?, params_overrides? }
  //   Response: { ok, job_id, step_count, chain_name }
  //
  // Mirrors /api/replay-chain but consumes a forward-declared step list (from
  // body or from a `presets` row with preset_type='chain') instead of walking
  // an existing asset chain. Each step's output URL feeds the next step's
  // input. Final asset row chains via parent_id back to the source URL's
  // asset, intermediates land in metadata.intermediates so the UI can
  // surface the per-step trail.
  //
  // Reuses executeEditSequence (defined below) — same engine dispatch +
  // rehosting + skip-non-replayable behavior the replay-chain handler uses.
  // ---------------------------------------------------------------------------
  if (url.pathname === "/api/chains/run" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const quotaReject = await checkQuotaOrReject(req, "chains_runs");
    if (quotaReject) return quotaReject;
    if (!SUPABASE_URL) return Response.json({ error: "supabase not configured" }, { status: 503 });
    const res = await handleChainsRun(req, deps);
    if (res.status >= 200 && res.status < 300) void incrementUsageBackground(req, "chains_runs");
    return res;
  }

  // ---------------------------------------------------------------------------
  // Asset metadata mutate — star / archive / tag a row in `assets`.
  //
  //   PATCH /api/assets/:id   body { starred?, archived?, tags? }
  //   POST  /api/assets/:id   (alias — same body, same behavior)
  //
  // Only those three fields are accepted; everything else is silently
  // dropped so the route can't be used to overwrite source_url, parent_id,
  // engine, etc. Returns the updated row via Prefer: return=representation.
  //
  // Used by the result-image toolbar (asset-toolbar) in public/index.html
  // for the star ⭐ / archive 🗄 / tag + chip-list affordances. The UI
  // calls /api/asset-chain first to resolve source_url → asset_id, then
  // hits this endpoint with the resolved id.
  //
  // See darkroom.catalog.star-archive-tags.
  // ---------------------------------------------------------------------------
  {
    const assetIdMatch = url.pathname.match(/^\/api\/assets\/([0-9a-fA-F-]{36})$/);
    if (assetIdMatch && (req.method === "PATCH" || req.method === "POST")) {
      if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (!SUPABASE_URL) {
        return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
      }
      const assetId = assetIdMatch[1];
      try {
        let body: any = {};
        try {
          body = await req.json();
        } catch {
          // Empty body / unreadable JSON — treat as no-op error.
          return Response.json({ error: "invalid_json_body" }, { status: 400 });
        }
        const patch: Record<string, any> = {};
        if (typeof body.starred === "boolean") patch.starred = body.starred;
        if (typeof body.archived === "boolean") patch.archived = body.archived;
        if (Array.isArray(body.tags)) {
          // Normalize: strings only, trimmed, deduped, max 32 chars each, max 32 tags.
          const seen = new Set<string>();
          const cleaned: string[] = [];
          for (const t of body.tags) {
            const s = String(t || "").trim().slice(0, 32);
            if (!s) continue;
            if (seen.has(s)) continue;
            seen.add(s);
            cleaned.push(s);
            if (cleaned.length >= 32) break;
          }
          patch.tags = cleaned;
        }
        if (Object.keys(patch).length === 0) {
          return Response.json(
            { error: "no_valid_fields", accepted: ["starred", "archived", "tags"] },
            { status: 400 },
          );
        }
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/assets?id=eq.${encodeFilterValue(assetId)}`,
          {
            method: "PATCH",
            headers: { ...supaHeaders(), Prefer: "return=representation" },
            body: JSON.stringify(patch),
          },
        );
        if (!res.ok) {
          const t = await res.text();
          return Response.json(
            { error: "asset_patch_failed", detail: t.slice(0, 300) },
            { status: 502 },
          );
        }
        const rows = await res.json();
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row) {
          return Response.json({ error: "not_found", asset_id: assetId }, { status: 404 });
        }
        return Response.json({ ok: true, asset: row });
      } catch (e: any) {
        return Response.json(
          { error: "asset_patch_error", detail: e?.message || String(e) },
          { status: 500 },
        );
      }
    }
  }

  if (url.pathname === "/api/engine-compatibility" && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    // Static map of (engine × content_profile) → verdict. Frontend uses this
    // to render the engine card strip with green/amber/red dots and to gray
    // out hopeless engine choices for the active source's content profile.
    //
    // House names (PLAN.md §1.3): lens=Grok img2img, glance=Nano Banana,
    // strip=P-Edit, brush=Flux Fill Pro, eye=gpt-image-2, frame=Bria,
    // skin=Darkroom Skin (Grok-PRO based), blend=multi-image blend,
    // lock=fal.ai face-swap.
    return Response.json({
      schema_version: 1,
      content_profiles: ["sfw", "nsfw_topless"],
      verdicts: ["likely", "may-refuse", "will-refuse"],
      engines: {
        lens:   { sfw: "likely", nsfw_topless: "may-refuse" },
        glance: { sfw: "likely", nsfw_topless: "may-refuse" },
        strip:  { sfw: "likely", nsfw_topless: "likely" },
        brush:  { sfw: "likely", nsfw_topless: "likely" },
        eye:    { sfw: "likely", nsfw_topless: "will-refuse" },
        frame:  { sfw: "likely", nsfw_topless: "will-refuse" },
        skin:   { sfw: "likely", nsfw_topless: "may-refuse" },
        blend:  { sfw: "likely", nsfw_topless: "likely" },
        lock:   { sfw: "likely", nsfw_topless: "likely" },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Darkroom LUT/aesthetic presets — apply by slug.
  //   POST /api/preset/:slug   { image_url, intensity? } → { url, slug, ... }
  // Lookup table is the server-side DARKROOM_PRESETS const (hidden prompts).
  // ---------------------------------------------------------------------------

  if (url.pathname.startsWith("/api/preset/") && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const slug = url.pathname.slice("/api/preset/".length);
    // ?with_lut=true asks the handler to also blend the curated Hald-CLUT
    // (if any) for this slug on top of the engine result. Default = off so
    // existing callers see no behavior change.
    const withLut = url.searchParams.get("with_lut") === "true";
    return handleApplyPreset(req, slug, deps, { withLut });
  }

  // ---------------------------------------------------------------------------
  // Reveal (Magnific upscale) — async + preset variants.
  //
  //   POST /api/reveal/async          { image_url, scale?, mode?, prompt? }
  //                                   → { ok, job_id }
  //                                   Wraps the existing Magnific call in
  //                                   spawnJob so the request thread doesn't
  //                                   block on the 30-90s upscale; UI's Active
  //                                   Jobs panel polls /api/jobs/:id.
  //
  //   POST /api/reveal/preset/:slug   { image_url, intensity? }
  //                                   → { ok, job_id }
  //                                   Curated prompt + creativity/hdr/
  //                                   resemblance bag from REVEAL_PRESETS.
  //                                   Engine="reveal:<slug>" on the saved
  //                                   asset row.
  //
  // The synchronous /api/upscale route in media.ts is left untouched.
  // ---------------------------------------------------------------------------

  if (url.pathname === "/api/reveal/async" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const quotaReject = await checkQuotaOrReject(req, "upscales");
    if (quotaReject) return quotaReject;
    const res = await handleRevealAsync(req, deps);
    if (res.status >= 200 && res.status < 300) void incrementUsageBackground(req, "upscales");
    return res;
  }

  if (url.pathname.startsWith("/api/reveal/preset/") && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const quotaReject = await checkQuotaOrReject(req, "upscales");
    if (quotaReject) return quotaReject;
    const slug = url.pathname.slice("/api/reveal/preset/".length);
    const res = await handleRevealPreset(req, slug, deps);
    if (res.status >= 200 && res.status < 300) void incrementUsageBackground(req, "upscales");
    return res;
  }

  // ---------------------------------------------------------------------------
  // LUT extraction — reverse-engineer a 33×33×33 Hald-CLUT from a before/after
  // image pair (e.g., before = original, after = original with a Darkroom
  // preset applied). Builds the cube by sampling pixel pairs, fills empty
  // cells via nearest-non-empty, encodes via lut.ts encodeHaldClut(), uploads
  // to Supabase, and returns lut_url + sample preview_url.
  // ---------------------------------------------------------------------------

  if (url.pathname === "/api/lut/extract" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const quotaReject = await checkQuotaOrReject(req, "lut_extracts");
    if (quotaReject) return quotaReject;
    const res = await handleLutExtract(req);
    if (res.status >= 200 && res.status < 300) void incrementUsageBackground(req, "lut_extracts");
    return res;
  }

  // ---------------------------------------------------------------------------
  // LUT apply — apply a Hald-CLUT PNG to a target image with trilinear
  // interpolation and optional intensity blend (LUT-mapped vs original).
  // Pure pixel math: no engine call, deterministic, ~100-200ms for a 1MP image.
  // ---------------------------------------------------------------------------

  if (url.pathname === "/api/lut/apply" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleLutApply(req);
  }

  // ---------------------------------------------------------------------------
  // LUT export — fetch a Hald-CLUT PNG by URL, decode it, and return it as a
  // portable LUT file for use in external editors.
  //   GET /api/lut/export?format=cube|xmp&lut_url=<url>&title=<optional>
  // .cube  → Adobe / DaVinci Resolve standard ASCII format.
  // .xmp   → Lightroom Profile sidecar (simplified — see cubeToXmp docstring).
  // ---------------------------------------------------------------------------

  if (url.pathname === "/api/lut/export" && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleLutExport(req);
  }

  // ---------------------------------------------------------------------------
  // Presets CRUD (engine_config | lut | chain) — see migration 0044 + 0049.
  // ---------------------------------------------------------------------------

  if (url.pathname === "/api/presets" && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePresetsList(url);
  }

  if (url.pathname === "/api/presets" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePresetsCreate(req);
  }

  if (url.pathname.startsWith("/api/presets/") && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const slug = url.pathname.slice("/api/presets/".length);
    return handlePresetsGetBySlug(slug);
  }

  if (url.pathname.startsWith("/api/presets/") && req.method === "PATCH") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const id = url.pathname.slice("/api/presets/".length);
    return handlePresetsPatch(req, id);
  }

  if (url.pathname.startsWith("/api/presets/") && req.method === "DELETE") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const id = url.pathname.slice("/api/presets/".length);
    return handlePresetsSoftDelete(id);
  }

  // ---------------------------------------------------------------------------
  // Wardrobe — curated garment library (migration 0043). Each row points at an
  // entry in `assets` via asset_id. The list endpoint joins back to assets so
  // the client gets the actual image URL alongside the catalog metadata.
  // ---------------------------------------------------------------------------

  if (url.pathname === "/api/wardrobe" && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleWardrobeList(url);
  }

  if (url.pathname === "/api/wardrobe" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleWardrobeCreate(req);
  }

  if (url.pathname === "/api/wardrobe/forge" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleWardrobeForge(req);
  }

  // ---------------------------------------------------------------------------
  // User-submitted detail brushes
  //
  //   POST /api/details/submit       Insert a user's custom detail-brush row
  //                                   into detail_brush_assets with
  //                                   is_hidden=true. Operator must flip the
  //                                   flag (manual SQL) before the brush
  //                                   appears in the public catalog.
  //
  //   GET  /api/details/submissions  List submissions matching ?is_hidden=
  //                                   (default true → pending). v1 has no
  //                                   per-user filter; detail_brush_assets
  //                                   does not yet carry user_id.
  //
  // See darkroom.details.user-asset-submission.
  // ---------------------------------------------------------------------------
  if (url.pathname === "/api/details/submit" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleDetailSubmit(req);
  }

  if (url.pathname === "/api/details/submissions" && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleDetailSubmissions(url);
  }

  // Multi-angle variant routes — POST to add an angle, DELETE to remove one.
  // Path shape: /api/wardrobe/:id/angles[/:angle]. The id segment must look
  // like a uuid so we don't shadow other /api/wardrobe/* routes.
  //
  //   POST   /api/wardrobe/:id/angles            body { angle, asset_url }
  //   DELETE /api/wardrobe/:id/angles/:angle
  {
    const angleMatch = url.pathname.match(
      /^\/api\/wardrobe\/([0-9a-fA-F-]{36})\/angles(?:\/([a-zA-Z0-9_-]+))?$/
    );
    if (angleMatch) {
      if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const wardrobeId = angleMatch[1];
      const angleSeg = angleMatch[2];
      if (req.method === "POST" && !angleSeg) {
        return handleWardrobeAngleAdd(req, wardrobeId);
      }
      if (req.method === "DELETE" && angleSeg) {
        return handleWardrobeAngleDelete(wardrobeId, angleSeg);
      }
      return Response.json(
        { error: "method_not_allowed", method: req.method, path: url.pathname },
        { status: 405 }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Async jobs — read + cancel surface for the spawnJob() helper below.
  //
  //   GET    /api/jobs/:id          → row from `jobs` table or 404
  //   GET    /api/jobs?status=...&user_id=...&limit=
  //                                 → list of recent jobs (default order:
  //                                   created_at DESC). Both filters
  //                                   optional; missing filters return
  //                                   everything.
  //   DELETE /api/jobs/:id          → mark status='cancelled'. Best-effort:
  //                                   the in-flight worker promise can't
  //                                   be killed (we have no signal handles
  //                                   in v1), so the cancellation just
  //                                   instructs the final-state writer to
  //                                   skip overwriting the cancelled flag.
  //
  // The list filter for ?status= accepts any of the CHECK values from
  // migration 0050: queued, running, completed, failed, cancelled, expired.
  // Garbage values fall through to PostgREST and the client sees the
  // upstream error — no client-side validation here on purpose (keeps the
  // route thin; the DB is the canonical source of truth on valid states).
  // ---------------------------------------------------------------------------
  {
    const jobIdMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-fA-F-]{36})$/);
    if (jobIdMatch) {
      if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const jobId = jobIdMatch[1];
      if (req.method === "GET") return handleJobsGet(jobId);
      if (req.method === "DELETE") return handleJobsCancel(jobId);
      return Response.json(
        { error: "method_not_allowed", method: req.method, path: url.pathname },
        { status: 405 }
      );
    }
  }
  if (url.pathname === "/api/jobs" && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleJobsList(url);
  }

  // Crop workspace outpaint — extend canvas via Brush (Flux Fill Pro inpaint)
  // of the new area. See handleCropOutpaint comment block for shape.
  if (url.pathname === "/api/crop/outpaint" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleCropOutpaint(req, deps);
  }

  // ---------------------------------------------------------------------------
  // Billing read endpoints (wave 39).
  //
  //   GET /api/billing/tiers — public-ish (still gated by checkAuth so
  //                            unauthenticated callers can't enumerate the
  //                            pricing matrix). Returns the BILLING_TIERS map
  //                            with stripe_price_id_monthly stripped, so the
  //                            UI can render the pricing/upgrade view without
  //                            leaking operator-side IDs.
  //
  //   GET /api/billing/me    — current user's tier + per-metric usage snapshot
  //                            for the active calendar month. When no
  //                            x-user-id is supplied (single-shared-bearer
  //                            mode), returns the free-tier defaults with
  //                            zeroed usage so the UI can still render a
  //                            usage panel pre-auth.
  //
  // The two endpoints together give the upgrade modal (triggered by the 402
  // shape above) enough to (a) tell the user where they are, and (b) show
  // the upgrade options without a Stripe round-trip.
  // ---------------------------------------------------------------------------
  if (url.pathname === "/api/billing/tiers" && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const { BILLING_TIERS } = await import("../billing");
    // Strip stripe_price_id_monthly from the public response — defense in depth
    // even though those slots are null until the operator wires Stripe up.
    const safe = Object.fromEntries(
      Object.entries(BILLING_TIERS).map(([k, v]) => {
        const { stripe_price_id_monthly: _drop, ...rest } = v as any;
        return [k, rest];
      }),
    );
    return Response.json({ ok: true, tiers: safe });
  }

  if (url.pathname === "/api/billing/me" && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const userId = extractUserId(req);
    const { getUserTier, getTierLimits, getCurrentUsage } = await import("../billing");
    const tier = await getUserTier(userId);
    const limits = getTierLimits(tier);
    const metrics: import("../billing").BillingMetric[] = [
      "generations",
      "edits",
      "upscales",
      "jobs",
      "chains_runs",
      "lut_extracts",
    ];
    const usage: Record<string, number> = {};
    for (const m of metrics) usage[m] = await getCurrentUsage(userId, m);
    return Response.json({ ok: true, tier, user_id: userId, limits, usage });
  }

  // ---------------------------------------------------------------------------
  // Stripe webhook + Checkout Session (wave 39).
  //
  //   POST /api/billing/stripe-webhook
  //     Receives signed Stripe events (subscription.created/updated/deleted,
  //     invoice.paid/payment_failed). Verifies HMAC-SHA256 signature using
  //     STRIPE_WEBHOOK_SECRET; updates the local subscriptions table via
  //     PostgREST upsert keyed on stripe_subscription_id (Postgres handles the
  //     idempotency race). Refuses with 503 when STRIPE_WEBHOOK_SECRET is
  //     unset so we don't accidentally mark users as paid in dev.
  //
  //     NOTE: this endpoint is intentionally auth-bypassed because Stripe
  //     can't send our internal bearer token. Security is provided by the
  //     HMAC signature check inside handleStripeWebhook().
  //
  //   POST /api/billing/checkout
  //     Creates a Stripe Checkout Session for a tier slug. Returns { url } so
  //     the client can redirect to Stripe-hosted checkout. Refuses with 503
  //     when STRIPE_SECRET_KEY is unset or when the tier has no
  //     stripe_price_id_monthly configured.
  // ---------------------------------------------------------------------------
  if (url.pathname === "/api/billing/stripe-webhook" && req.method === "POST") {
    return handleStripeWebhook(req, deps);
  }

  if (url.pathname === "/api/billing/checkout" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleCreateCheckout(req);
  }

  // ---------------------------------------------------------------------------
  // Enhancor webhook — POST /api/enhancor/webhook
  //
  //   Receives job-completion callbacks from Enhancor (at-least-once delivery).
  //   Body: { request_id, result, status, cost? }
  //
  //   NOTE: intentionally auth-bypassed — Enhancor can't send our internal
  //   bearer token. Correlation-id matching (vendor_request_id) provides the
  //   equivalent security guarantee: only Enhancor knows the request_id they
  //   assigned on intake.
  // ---------------------------------------------------------------------------
  if (url.pathname === "/api/enhancor/webhook" && req.method === "POST") {
    return handleEnhancorWebhook(req);
  }

  // ---------------------------------------------------------------------------
  // Enhancor engine routes — POST endpoints (queue pattern)
  //
  //   Each route accepts parameters, submits the job to the Enhancor API,
  //   inserts a `jobs` table row with vendor='enhancor' + vendor_request_id,
  //   and immediately returns { request_id, job_id } without waiting for the
  //   vendor to finish. Completion arrives via POST /api/enhancor/webhook.
  //
  //   Webhook URL passed to the Enhancor wrapper is built from the request host
  //   so it works across dev / staging / prod without env-var plumbing.
  // ---------------------------------------------------------------------------

  // POST /api/enhancor/skin
  if (url.pathname === "/api/enhancor/skin" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleEnhancorSkin(req);
  }

  // POST /api/enhancor/lens
  if (url.pathname === "/api/enhancor/lens" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleEnhancorLens(req);
  }

  // POST /api/enhancor/lens-cinema
  if (url.pathname === "/api/enhancor/lens-cinema" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleEnhancorLensCinema(req);
  }

  // POST /api/enhancor/lens-reality
  if (url.pathname === "/api/enhancor/lens-reality" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleEnhancorLensReality(req);
  }

  // POST /api/enhancor/develop
  if (url.pathname === "/api/enhancor/develop" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleEnhancorDevelop(req);
  }

  // POST /api/enhancor/sharpen-portrait
  if (url.pathname === "/api/enhancor/sharpen-portrait" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleEnhancorSharpenPortrait(req);
  }

  // POST /api/enhancor/sharpen
  if (url.pathname === "/api/enhancor/sharpen" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleEnhancorSharpen(req);
  }

  // GET /api/enhancor/health
  if (url.pathname === "/api/enhancor/health" && req.method === "GET") {
    return handleEnhancorHealth();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Stripe webhook handler
//
// Reads the RAW request body (req.text()) — required because Stripe computes
// the signature over the raw bytes, not over a re-serialized JSON object. Bun
// gives us this via Request.text(); we never call req.json() on this path.
//
// On success: upserts the subscriptions row keyed on stripe_subscription_id
// (Postgres handles concurrent retries via on_conflict merge). On any
// signature failure we return 4xx and Stripe stops retrying. On any
// downstream upsert failure we return 500 so Stripe retries — the upsert is
// idempotent so retries are safe.
// ---------------------------------------------------------------------------
async function handleStripeWebhook(
  req: Request,
  deps: Pick<RouteDeps, "saveGeneration" | "getCharacter">,
): Promise<Response> {
  const { verifyStripeSignature, STRIPE_WEBHOOK_SECRET } = await import("../stripe");

  // Gate: refuse cleanly when not configured. Prevents accidental processing
  // (and avoids the surprising case where a webhook in dev silently flips a
  // user's tier without keys configured).
  if (!STRIPE_WEBHOOK_SECRET) {
    return Response.json(
      { error: "Stripe webhook not configured (STRIPE_WEBHOOK_SECRET unset)" },
      { status: 503 },
    );
  }

  // Read raw body for signature verification — must be the bytes Stripe sent,
  // not a re-serialized parse.
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  const verified = await verifyStripeSignature(rawBody, sig);
  if (!verified.ok) {
    console.warn(`[stripe-webhook] signature verification failed: ${verified.reason}`);
    return Response.json({ error: `signature: ${verified.reason}` }, { status: 400 });
  }

  // Parse event after signature passes.
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const eventId = event?.id;
  const eventType = event?.type;
  if (!eventId || !eventType) {
    return Response.json({ error: "missing_event_id_or_type" }, { status: 400 });
  }

  // Idempotency: the subscriptions upsert is keyed on stripe_subscription_id
  // with on_conflict=stripe_subscription_id, so re-processing the same Stripe
  // event simply re-applies the same row. For the events that don't touch a
  // subscription row (invoice.*), we no-op for v1 — the subscription event
  // already updated the user's state.
  try {
    await processStripeEvent(event, deps);
  } catch (e: any) {
    console.error(
      `[stripe-webhook] processing ${eventType} (${eventId}) failed:`,
      e,
    );
    // 500 → Stripe will retry. Idempotency in processStripeEvent keeps that safe.
    return Response.json({ error: e?.message || "processing_failed" }, { status: 500 });
  }

  return Response.json({ ok: true, event_type: eventType, event_id: eventId });
}

// Per-event branch. Subscription events update the local mirror; invoice
// events are logged-only for v1 (the matching subscription event already
// updated state, and we don't yet act on payment_failed beyond what Stripe
// reflects via subscription.status transitions).
async function processStripeEvent(
  event: any,
  _deps: Pick<RouteDeps, "saveGeneration" | "getCharacter">,
): Promise<void> {
  const type: string = event.type;
  const obj = event?.data?.object || {};
  const eventId: string = event?.id;

  switch (type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subId = obj.id;
      const customerId = obj.customer;
      const status = obj.status;
      const periodStart = obj.current_period_start
        ? new Date(obj.current_period_start * 1000).toISOString()
        : null;
      const periodEnd = obj.current_period_end
        ? new Date(obj.current_period_end * 1000).toISOString()
        : null;
      const cancelAtPeriodEnd = !!obj.cancel_at_period_end;

      // Resolve tier from price id by matching against BILLING_TIERS. Falls
      // back to 'free' when nothing matches (operator hasn't filled a slot
      // yet, or Stripe sent a price we don't recognize). Free is a safe
      // fallback — the user just won't see the upgraded limits until the
      // operator wires the price id in.
      const { BILLING_TIERS } = await import("../billing");
      let tier: string | null = null;
      const items = obj.items?.data || [];
      for (const item of items) {
        const priceId = item?.price?.id;
        if (!priceId) continue;
        for (const [tierKey, cfg] of Object.entries(BILLING_TIERS)) {
          if ((cfg as any).stripe_price_id_monthly === priceId) {
            tier = tierKey;
            break;
          }
        }
        if (tier) break;
      }

      // Upsert keyed on stripe_subscription_id. Idempotent under concurrent
      // delivery from Stripe.
      if (!SUPABASE_URL) {
        console.log(
          `[stripe-webhook] ${type} (${eventId}) — SUPABASE_URL unset, skipping upsert`,
        );
        return;
      }

      const upsertBody = {
        stripe_subscription_id: subId,
        stripe_customer_id: customerId,
        status: type === "customer.subscription.deleted" ? "cancelled" : status,
        tier: tier || "free",
        current_period_start: periodStart,
        current_period_end: periodEnd,
        cancel_at_period_end: cancelAtPeriodEnd,
        // user_id set by checkout via metadata.user_id; null is acceptable
        // (the row still mirrors Stripe state and can be reconciled later).
        user_id: obj?.metadata?.user_id || null,
        updated_at: new Date().toISOString(),
      };

      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=stripe_subscription_id`,
        {
          method: "POST",
          headers: {
            ...supaHeaders(),
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify(upsertBody),
        },
      );
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`subscriptions upsert ${r.status}: ${txt.slice(0, 200)}`);
      }
      console.log(
        `[stripe-webhook] upserted ${subId} (${type}) → tier=${tier} status=${upsertBody.status}`,
      );
      return;
    }
    case "invoice.paid":
    case "invoice.payment_failed":
      // No-op for v1 — the matching subscription.updated event already
      // updated state. Logged so we can confirm Stripe is delivering.
      console.log(`[stripe-webhook] ${type} (${eventId}) — no-op for v1`);
      return;
    default:
      console.log(`[stripe-webhook] unhandled event type ${type} (${eventId})`);
      return;
  }
}

// ---------------------------------------------------------------------------
// Checkout Session handler — POST /api/billing/checkout
//
// Body: { tier, success_url, cancel_url, customer_email?, user_id? }
// Returns: { ok: true, url, id } on success, 4xx/5xx on input or Stripe error.
//
// Validates the tier against BILLING_TIERS, refuses 'free' (no checkout
// needed), then asks Stripe to mint a hosted Checkout Session and returns
// the URL for the client to redirect to. The metadata.user_id we set here
// is what the webhook reads back when it sees customer.subscription.created
// — that's how we tie the Stripe subscription back to a Darkroom user.
// ---------------------------------------------------------------------------
async function handleCreateCheckout(req: Request): Promise<Response> {
  const { isStripeConfigured, createCheckoutSession } = await import("../stripe");
  if (!isStripeConfigured()) {
    return Response.json(
      {
        error:
          "Stripe not configured (set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET in env)",
      },
      { status: 503 },
    );
  }

  try {
    const body = await req.json();
    const tierKey = String(body.tier || "");
    const successUrl = String(body.success_url || "");
    const cancelUrl = String(body.cancel_url || "");
    const customerEmail = body.customer_email ? String(body.customer_email) : undefined;
    const userId = body.user_id ? String(body.user_id) : undefined;

    if (!tierKey || !successUrl || !cancelUrl) {
      return Response.json(
        { error: "tier, success_url, cancel_url required" },
        { status: 400 },
      );
    }

    const { BILLING_TIERS } = await import("../billing");
    const tier = (BILLING_TIERS as any)[tierKey];
    if (!tier) return Response.json({ error: `unknown tier: ${tierKey}` }, { status: 400 });
    if (tier.tier === "free") {
      return Response.json(
        { error: "Free tier doesn't require checkout" },
        { status: 400 },
      );
    }
    const priceId = tier.stripe_price_id_monthly;
    if (!priceId) {
      return Response.json(
        { error: `tier ${tierKey} has no stripe_price_id_monthly configured` },
        { status: 503 },
      );
    }

    const session = await createCheckoutSession({
      priceId,
      successUrl,
      cancelUrl,
      customerEmail,
      metadata: userId ? { user_id: userId, tier: tierKey } : { tier: tierKey },
    });

    return Response.json({ ok: true, url: session.url, id: session.id });
  } catch (e: any) {
    return Response.json({ error: e?.message || "checkout_failed" }, { status: 500 });
  }
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
          error: `AI vision couldn't locate "${prompt.slice(0, 60)}" in the image. Use Paint Mask for manual control.`,
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

    // Detect blank/uniform-color results — fal.ai's content moderation
    // silently returns a black placeholder instead of an error. Catch it.
    const isBlank = await isImageBlankOrUniform(editedBuf);
    if (isBlank) {
      return Response.json({
        ok: false,
        error: "Brush edit blocked by content filter on this image. Try a different engine (Strip is more permissive).",
      }, { status: 422 });
    }

    const resultUrl = await uploadBufferToStorage(editedBuf, "image/png", buildUploadPath, uploadToStorage, "flux-edit");

    try {
      await deps.saveGeneration({
        prompt: `[flux-edit] ${prompt}`,
        image_url: resultUrl,
        engine: "flux-fill-pro-direct",
      } as any);
    } catch {}
    // Dual-write: flux-edit is a brush/inpaint edit on the source image.
    try {
      const parentId = await (deps as any).lookupAssetIdByUrl?.(imageUrl);
      await (deps as any).saveAsset?.({
        asset_type: "edit",
        source_url: resultUrl,
        engine: "flux-fill-pro",
        edit_action: "inpaint",
        prompt,
        parent_id: parentId || null,
        metadata: {
          source_url: imageUrl,
          mask_url: maskUrl,
          mask_source: maskSource,
          garment_count: garmentUrls.length,
        },
        tags: ["edit", "flux-edit", "brush"],
      });
    } catch (e) {
      console.error("[safe-edit:flux-edit] saveAsset failed (non-fatal):", e);
    }

    // Pre-warm content-profile cache for the new asset. Fire-and-forget.
    queueBackgroundReanalysis(resultUrl);

    return Response.json({
      ok: true,
      url: resultUrl,
      mask_url: maskUrl,
      mask_source: maskSource,
      model: "Brush (auto-masked)",
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// /api/crop/outpaint — extend canvas via Brush (Flux Fill Pro inpaint).
//
// Takes the original image plus pixel-amounts to extend each side, then:
//   1. Builds a new canvas (newW × newH) with the original placed at
//      (left, top) and a neutral grey fill in the extension band.
//   2. Builds a mask where the extension band is white (inpaint here) and
//      the original-image rectangle is black (preserve).
//   3. Calls Flux Fill Pro with the extended image + mask + prompt.
//   4. Saves the result as a new asset row with edit_action="outpaint" and
//      parent_id pointing back to the source asset row, so the asset chain
//      preserves outpainting as a distinct edit step.
//
// Body: { image_url: string, extend: { top, right, bottom, left }, prompt? }
// Response: { ok, url, asset_id?, original_dims, new_dims, extend }
async function handleCropOutpaint(
  req: Request,
  deps: Pick<RouteDeps, "saveGeneration">
): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    const extend = body.extend || {};
    const top = Math.max(0, Math.round(Number(extend.top) || 0));
    const right = Math.max(0, Math.round(Number(extend.right) || 0));
    const bottom = Math.max(0, Math.round(Number(extend.bottom) || 0));
    const left = Math.max(0, Math.round(Number(extend.left) || 0));
    const prompt = String(
      body.prompt ||
        "extend the scene naturally, photorealistic, seamless continuation, preserve color and lighting"
    );

    if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });
    const totalExtend = top + right + bottom + left;
    if (totalExtend === 0) {
      return Response.json({ error: "no extension specified" }, { status: 400 });
    }
    // Bound how far we'll extend so a misclick can't blow up the request.
    if (totalExtend > 4096) {
      return Response.json({ error: "extension too large" }, { status: 400 });
    }

    const sharp = (await import("sharp")).default;
    const { uploadToStorage, buildUploadPath } = await import("../supabase");

    // Fetch original
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) {
      return Response.json({ error: `image fetch ${imgResp.status}` }, { status: 422 });
    }
    const imgBuf = Buffer.from(await imgResp.arrayBuffer());
    const meta = await sharp(imgBuf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h) return Response.json({ error: "invalid image dimensions" }, { status: 422 });

    const newW = w + left + right;
    const newH = h + top + bottom;

    // Extended canvas: 50% grey background with the original composited in.
    // (Grey, not transparent, gives the inpaint model a neutral baseline so
    // the boundary doesn't bleed alpha into the result.)
    const extendedBuf = await sharp({
      create: {
        width: newW,
        height: newH,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .composite([{ input: imgBuf, top, left }])
      .png()
      .toBuffer();

    // Mask: white everywhere (extension band), black rectangle covering the
    // original image bounds (preserve original pixels).
    const blackRectBuf = await sharp({
      create: {
        width: w,
        height: h,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    const maskBuf = await sharp({
      create: {
        width: newW,
        height: newH,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([{ input: blackRectBuf, top, left }])
      .png()
      .toBuffer();

    const extUrl = await uploadBufferToStorage(
      extendedBuf,
      "image/png",
      buildUploadPath,
      uploadToStorage,
      "outpaint-ext",
    );
    const maskUrl = await uploadBufferToStorage(
      maskBuf,
      "image/png",
      buildUploadPath,
      uploadToStorage,
      "outpaint-mask",
    );

    // Inpaint just the extension band via the existing Brush helper.
    const editedBuf = await callFluxFillPro({
      imageUrl: extUrl,
      maskUrl,
      prompt,
    });

    // Same blank-result detector used by other Brush callsites — Flux Fill's
    // content-mod refusal silently returns a uniform-color placeholder.
    const isBlank = await isImageBlankOrUniform(editedBuf);
    if (isBlank) {
      return Response.json(
        {
          ok: false,
          error:
            "Outpaint blocked by content filter on this image. Try a different engine or smaller extension.",
        },
        { status: 422 },
      );
    }

    const resultUrl = await uploadBufferToStorage(
      editedBuf,
      "image/png",
      buildUploadPath,
      uploadToStorage,
      "outpaint",
    );

    try {
      await deps.saveGeneration({
        prompt: `[outpaint] ${prompt}`,
        image_url: resultUrl,
        engine: "flux-fill-pro-outpaint",
      } as any);
    } catch {}

    let assetId: string | null = null;
    try {
      const parentId = await (deps as any).lookupAssetIdByUrl?.(imageUrl);
      assetId = await (deps as any).saveAsset?.({
        asset_type: "edit",
        source_url: resultUrl,
        engine: "flux-fill-pro",
        edit_action: "outpaint",
        prompt,
        parent_id: parentId || null,
        metadata: {
          source_url: imageUrl,
          extended_image_url: extUrl,
          mask_url: maskUrl,
          outpaint_extend: { top, right, bottom, left },
          original_width: w,
          original_height: h,
          new_width: newW,
          new_height: newH,
        },
        width: newW,
        height: newH,
        tags: ["edit", "outpaint", "brush"],
      });
    } catch (e) {
      console.error("[safe-edit:crop-outpaint] saveAsset failed (non-fatal):", e);
    }

    // Pre-warm content-profile cache for the new asset.
    queueBackgroundReanalysis(resultUrl);

    return Response.json({
      ok: true,
      url: resultUrl,
      asset_id: assetId,
      original_dims: { w, h },
      new_dims: { w: newW, h: newH },
      extend: { top, right, bottom, left },
      mask_url: maskUrl,
      model: "Brush (outpaint)",
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message || "outpaint failed" },
      { status: 500 },
    );
  }
}

// Use AI vision to find the bounding box(es) for whatever the user wants to edit.
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

// =============================================================================
// getDetailBrushAssets
//
// Returns the active detail-brush catalog. DB-first, code-fallback:
//   1. If `detail_brush_assets` exists and has visible rows, map them into
//      the DETAIL_BRUSH_REGISTRY shape and return that. This lets brushes
//      be added/edited/reordered at runtime without a code change.
//   2. Otherwise (table missing, empty, error, or disabled) — return the
//      in-code DETAIL_BRUSH_REGISTRY. Safe default.
//
// `deps.db` is reserved for a future Supabase JS client; today the code
// uses the project's PostgREST fetch pattern (see src/server/routes/public.ts).
// =============================================================================
async function getDetailBrushAssets(
  deps: { db?: any } = {}
): Promise<typeof DETAIL_BRUSH_REGISTRY> {
  try {
    if (deps?.db && typeof deps.db.from === "function") {
      // Supabase JS client path (forward-compat — not used today).
      const { data, error } = await deps.db
        .from("detail_brush_assets")
        .select("*")
        .eq("is_hidden", false)
        .order("position", { ascending: true });
      if (!error && Array.isArray(data) && data.length > 0) {
        return mapDetailBrushRows(data);
      }
    } else if (SUPABASE_URL) {
      // Project-standard PostgREST path. Mirrors how characters.ts +
      // public.ts read from Supabase: a plain fetch with supaHeaders().
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/detail_brush_assets?is_hidden=eq.false&order=position.asc`,
        { headers: supaHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          return mapDetailBrushRows(data);
        }
      }
      // res.status === 404 → table not yet migrated; fall through to registry.
    }
  } catch {
    // Network error, table missing, malformed row — fall through.
  }
  return DETAIL_BRUSH_REGISTRY;
}

// Map a detail_brush_assets row to the DETAIL_BRUSH_REGISTRY shape so
// downstream code (route handlers, brush-id lookups) keeps working
// unchanged whether the catalog comes from DB or from code.
function mapDetailBrushRows(
  rows: Array<{
    slug?: string;
    label?: string;
    category?: string | null;
    prompt?: string;
    params?: Record<string, any> | null;
  }>
): typeof DETAIL_BRUSH_REGISTRY {
  const out: Record<string, DetailBrush> = {};
  for (const row of rows) {
    if (!row || !row.slug || !row.prompt) continue;
    const params = (row.params || {}) as Record<string, any>;
    const intensity =
      params.intensity === "low" || params.intensity === "high" ? params.intensity : "medium";
    const category =
      row.category &&
      ["Anatomy", "Fabric", "Lighting", "Hair", "Mood", "Removal"].includes(row.category)
        ? (row.category as DetailBrush["category"])
        : "Anatomy";
    out[row.slug] = {
      name: String(row.label ?? row.slug),
      category,
      description: typeof params.description === "string" ? params.description : "",
      prompt: String(row.prompt),
      brushSizePx:
        typeof params.brush_size_px === "number" && params.brush_size_px > 0
          ? params.brush_size_px
          : 30,
      intensity,
      intensityLabel:
        typeof params.intensity_label === "string"
          ? params.intensity_label
          : intensity === "low"
          ? "Subtle"
          : intensity === "high"
          ? "Bold"
          : "Medium",
      dilatePct:
        typeof params.dilate_pct === "number" && params.dilate_pct > 0
          ? params.dilate_pct
          : undefined,
    };
  }
  return out as typeof DETAIL_BRUSH_REGISTRY;
}

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
// Darkroom LUT / Aesthetic Presets
//
// Hidden-prompt registry. Each preset is a one-shot aesthetic apply: the user
// hands us an image_url + intensity, the server composes the full color-grade
// stanza server-side (so the prompt cannot be reverse-engineered by clients),
// runs Lens (Grok img2img) at the chosen guidance scale, and rehosts the
// result to Supabase. lut_asset_id is reserved for a future Hald-CLUT export
// path; nullable today.
//
// Style notes baked into every prompt:
//   - identity preservation language (face/pose/wardrobe unchanged)
//   - generic engine verbs ("apply", "render with") — no vendor names leaked
//   - real-world reference (film stock / lighting condition) for grounding
//   - "photorealistic, no plastic look" anchor on every stanza
// =============================================================================

type DarkroomPreset = {
  slug: string;
  name: string;
  description: string;
  engine: "lens" | "glance" | "brush" | "strip";
  prompt: string;
  guidance_scale?: { low: number; medium: number; high: number };
  strength?: { low: number; medium: number; high: number };
  lut_asset_id?: string | null;
};

// Short, imperative tail. Long preservation lists were causing Grok PRO to
// interpret the prompt as a no-op (Joe reported clicking presets did nothing
// to the image). Now the transform language dominates and identity is a
// single trailing sentence.
const DARKROOM_PRESET_IDENTITY_TAIL =
  "Same person, same pose, same composition. Photorealistic.";

const DARKROOM_PRESETS: Record<string, DarkroomPreset> = {
  "darkroom-dawn": {
    slug: "darkroom-dawn",
    name: "Darkroom Dawn",
    description: "Cool blue hour, muted palette, soft cyan shadows.",
    engine: "lens",
    prompt: `Recolor this photo to cool blue-hour: deep teal shadows, lifted blacks tinted cyan, desaturated warm tones, low-contrast film curve like Fuji Eterna 250D. The whole image is noticeably cooler and more cinematic than the source. ${DARKROOM_PRESET_IDENTITY_TAIL}`,
    guidance_scale: { low: 2.5, medium: 3.5, high: 4.5 },
    lut_asset_id: null,
  },
  "darkroom-glow": {
    slug: "darkroom-glow",
    name: "Darkroom Glow",
    description: "Boudoir warmth, soft highlights, subtle bloom.",
    engine: "lens",
    prompt: `Recolor this photo with warm boudoir glow: golden highlights blooming softly, halation around bright edges, lifted skin warmth, creamy diffused midtones, tungsten-tinted whites like Cinestill 800T. Visibly warmer and more luminous than the source. ${DARKROOM_PRESET_IDENTITY_TAIL}`,
    guidance_scale: { low: 2.5, medium: 3.5, high: 4.5 },
    lut_asset_id: null,
  },
  "darkroom-lace": {
    slug: "darkroom-lace",
    name: "Darkroom Lace",
    description: "Delicate intimate diffusion, soft focus around face and skin.",
    engine: "lens",
    prompt: `Add a soft Pro-Mist diffusion grade: dreamy halo around skin and bright edges, gentle pastel midtones, faint pearl sheen on lit skin, lifted shadows. Eyes and lashes stay sharp; everything else softens. Visibly diffused and dreamy compared to the source. ${DARKROOM_PRESET_IDENTITY_TAIL}`,
    guidance_scale: { low: 2.5, medium: 3.5, high: 4.5 },
    lut_asset_id: null,
  },
  "darkroom-noir": {
    slug: "darkroom-noir",
    name: "Darkroom Noir",
    description: "Black-and-white film noir, deep contrast, sculpted shadows.",
    engine: "lens",
    prompt: `Convert to high-contrast black and white film noir. Crush blacks deep, push silvery highlights, sculpt hard shadow falloff, add Tri-X 400 grain pushed to 800. NO color anywhere — pure monochrome with rich tonal nuance. Dramatically different from the source. ${DARKROOM_PRESET_IDENTITY_TAIL}`,
    guidance_scale: { low: 2.8, medium: 3.8, high: 4.8 },
    lut_asset_id: null,
  },
  "darkroom-polaroid": {
    slug: "darkroom-polaroid",
    name: "Darkroom Polaroid",
    description: "Instant film stock, slight magenta cast, faded blacks.",
    engine: "lens",
    prompt: `Recolor as faded Polaroid SX-70 instant film: warm magenta cast through midtones, lifted blacks with no true shadow, cyan bleed in cooler tones, soft analog low-contrast curve, creamy off-white highlights, gentle edge vignette. Looks decades-old, sun-faded. Visibly nostalgic compared to source. ${DARKROOM_PRESET_IDENTITY_TAIL}`,
    guidance_scale: { low: 2.5, medium: 3.5, high: 4.5 },
    lut_asset_id: null,
  },
  "darkroom-studio": {
    slug: "darkroom-studio",
    name: "Darkroom Studio",
    description: "Clean editorial studio light, neutral palette.",
    engine: "lens",
    prompt: `Recolor with clean editorial studio grade: neutral white balance, evenly lifted midtones, gentle beauty diffusion on skin, calibrated whites with zero color cast. Phase One IQ4 magazine-beauty look. Visibly cleaner and more polished than the source. ${DARKROOM_PRESET_IDENTITY_TAIL}`,
    guidance_scale: { low: 2.5, medium: 3.5, high: 4.5 },
    lut_asset_id: null,
  },
  "darkroom-sunkissed": {
    slug: "darkroom-sunkissed",
    name: "Darkroom Sunkissed",
    description: "Golden hour, warm orange wash, lifted shadows.",
    engine: "lens",
    prompt: `Recolor as golden-hour 30 minutes before sunset: warm orange wash through highlights and midtones, amber-tinted shadows, sun-warmed skin tones, soft amber backlight halo, faint atmospheric haze. Kodak Gold 200 look. Visibly warmer and sunlit compared to the source. ${DARKROOM_PRESET_IDENTITY_TAIL}`,
    guidance_scale: { low: 2.5, medium: 3.5, high: 4.5 },
    lut_asset_id: null,
  },
  "darkroom-thirty-five-mm": {
    slug: "darkroom-thirty-five-mm",
    name: "Darkroom 35mm",
    description: "Analog film grain, halation, color shifts in shadows.",
    engine: "lens",
    prompt: `Recolor as Kodak Portra 400 35mm scan: visible film grain throughout, halation rings around bright skin highlights, greens shifted cooler, warms drifted toward magenta, lifted blacks, soft shoulder rolloff. Noritsu HS-1800 hybrid scan look. Visibly analog and film-grained compared to source. ${DARKROOM_PRESET_IDENTITY_TAIL}`,
    guidance_scale: { low: 2.5, medium: 3.5, high: 4.5 },
    lut_asset_id: null,
  },
  "darkroom-velvet": {
    slug: "darkroom-velvet",
    name: "Darkroom Velvet",
    description: "Rich saturated reds and maroons, deep luxury palette.",
    engine: "lens",
    prompt: `Recolor with deep velvet luxury grade: heavily saturated reds and maroons, plum-tinted shadows, low-key sculpted falloff, slight specular shine on skin, warm-leaning whites. Hasselblad fragrance-campaign look. Dramatically richer and more saturated than the source. ${DARKROOM_PRESET_IDENTITY_TAIL}`,
    guidance_scale: { low: 2.8, medium: 3.8, high: 4.8 },
    lut_asset_id: null,
  },
  "darkroom-wet-look": {
    slug: "darkroom-wet-look",
    name: "Darkroom Wet Look",
    description: "High-shine skin emphasis, glossy specular highlights.",
    engine: "lens",
    prompt: `Add high-shine wet sheen to all visible skin: glossy specular highlights on cheekbones, collarbone, shoulders, slick reflective surface, sharpened edge clarity, bumped contrast, cool-neutral whites. Pores stay visible under the gloss. Steven Klein wet-set look. Visibly wet and glossy compared to source. ${DARKROOM_PRESET_IDENTITY_TAIL}`,
    guidance_scale: { low: 2.8, medium: 3.8, high: 4.8 },
    lut_asset_id: null,
  },
};

// /api/preset/:slug — apply a Darkroom preset to an image_url.
// Body: { image_url, intensity? = 'low'|'medium'|'high' (default 'medium') }
// Query: ?with_lut=true → if a curated Hald-CLUT exists for this slug
//   (CURATED_LUT_REFS[slug] !== null), additionally apply it to the engine
//   result and return the LUT-blended URL alongside the raw engine output.
//   Default = off (additive feature, no behavior change for existing callers).
// Returns: { ok, url, slug, intensity, name, lut_url?, lut_applied? }
async function handleApplyPreset(
  req: Request,
  slug: string,
  deps: Pick<RouteDeps, "saveGeneration">,
  opts: { withLut?: boolean } = {}
): Promise<Response> {
  try {
    const preset = DARKROOM_PRESETS[slug];
    if (!preset) {
      return Response.json({ error: `unknown preset: ${slug}` }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const imageUrl = String(body.image_url || "");
    const intensityRaw = String(body.intensity || "medium");
    const intensity = (["low", "medium", "high"].includes(intensityRaw)
      ? intensityRaw
      : "medium") as "low" | "medium" | "high";

    if (!imageUrl) {
      return Response.json({ error: "image_url required" }, { status: 400 });
    }

    // All current presets ride on lens (Grok img2img). The engine field is
    // structural — left in place so future presets can route to brush/strip.
    if (preset.engine !== "lens") {
      return Response.json(
        { error: `preset engine ${preset.engine} not yet wired` },
        { status: 501 }
      );
    }

    // Map intensity → guidance_scale. xAI's images/edits endpoint doesn't
    // accept guidance_scale today, but we record the intended value in the
    // saved generation row so a future engine swap (or a Hald-CLUT export
    // path) can use it. The actual intensity lever for Grok is prompt
    // emphasis — we leave the prompt as-authored and rely on Grok's
    // moderate edit-strength default.
    const _gs = preset.guidance_scale?.[intensity] ?? 3.5;

    const grokRes = await fetch("https://api.x.ai/v1/images/edits", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("XAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-imagine-image-pro",
        prompt: preset.prompt,
        image: { url: imageUrl, type: "image_url" },
        n: 1,
      }),
    });

    if (!grokRes.ok) {
      const upstreamBody = await grokRes.text();
      console.error(
        `[preset:${slug}] upstream ${grokRes.status}:`,
        upstreamBody.slice(0, 500)
      );
      const status = grokRes.status;
      let userMsg: string;
      if (status === 400 || status === 422) {
        userMsg = `${preset.name} couldn't process this image. Try a different source.`;
      } else if (status === 401 || status === 403) {
        userMsg = `${preset.name} authentication issue. Try again in a moment.`;
      } else if (status === 429) {
        userMsg = `${preset.name} rate limited. Wait a few seconds and try again.`;
      } else if (status >= 500) {
        userMsg = `${preset.name} service temporarily unavailable.`;
      } else {
        userMsg = `${preset.name} failed (status ${status}).`;
      }
      return Response.json(
        { error: userMsg, upstream_status: status },
        { status: 502 }
      );
    }

    const data = await grokRes.json();
    const upstreamUrl = data.data?.[0]?.url;
    if (!upstreamUrl) {
      return Response.json(
        { error: `${preset.name} produced no image` },
        { status: 502 }
      );
    }

    const dl = await fetch(upstreamUrl);
    if (!dl.ok) {
      return Response.json(
        { error: `${preset.name} re-host failed` },
        { status: 502 }
      );
    }
    const buf = Buffer.from(await dl.arrayBuffer());
    const { uploadToStorage, buildUploadPath } = await import("../supabase");
    const finalUrl = await uploadBufferToStorage(
      buf,
      "image/png",
      buildUploadPath,
      uploadToStorage,
      slug
    );

    try {
      await deps.saveGeneration({
        prompt: `[${slug}] intensity=${intensity}`,
        image_url: finalUrl,
        engine: `preset:${slug}`,
      } as any);
    } catch {}
    // Dual-write: preset application is an edit relative to the source image.
    try {
      const parentId = await (deps as any).lookupAssetIdByUrl?.(imageUrl);
      await (deps as any).saveAsset?.({
        asset_type: "edit",
        source_url: finalUrl,
        engine: preset.engine,
        edit_action: "preset",
        prompt: preset.prompt,
        parent_id: parentId || null,
        metadata: {
          preset_slug: slug,
          preset_name: preset.name,
          intensity,
          source_url: imageUrl,
          guidance_scale: preset.guidance_scale?.[intensity] ?? null,
        },
        tags: ["edit", "preset", slug],
      });
    } catch (e) {
      console.error("[safe-edit:preset] saveAsset failed (non-fatal):", e);
    }

    // Optional: if the caller passed ?with_lut=true AND a curated Hald-CLUT
    // exists for this slug in CURATED_LUT_REFS, blend it on top of the engine
    // result and return BOTH urls. No-op when the registry entry is null
    // (the seeded default for every slug today).
    let lutUrl: string | undefined;
    let lutAppliedUrl: string | undefined;
    if (opts.withLut) {
      const curated = getCuratedLutForPreset(slug);
      if (curated) {
        try {
          const lutResult = await applyLutToImage({
            imageUrl: finalUrl,
            lutUrl: curated,
            intensity: 1,
            curve: "linear",
          });
          if (lutResult.ok) {
            lutUrl = curated;
            lutAppliedUrl = lutResult.url;
          }
        } catch {
          // LUT path is additive — never let a LUT failure break the main
          // preset response. Caller still gets the engine URL.
        }
      }
    }

    // Pre-warm content-profile cache for the new asset. Fire-and-forget.
    queueBackgroundReanalysis(finalUrl);

    return Response.json({
      ok: true,
      url: finalUrl,
      slug,
      name: preset.name,
      intensity,
      ...(lutUrl ? { lut_url: lutUrl, lut_applied: lutAppliedUrl } : {}),
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message || "preset apply failed" },
      { status: 500 }
    );
  }
}

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
    // Dual-write: stamp composites an asset onto a base image (an edit).
    try {
      const parentId = await (deps as any).lookupAssetIdByUrl?.(imageUrl);
      await (deps as any).saveAsset?.({
        asset_type: "edit",
        source_url: url,
        engine: "darkroom-stamp",
        edit_action: "stamp",
        prompt: `[stamp:${blend}]`,
        parent_id: parentId || null,
        metadata: {
          base_url: imageUrl,
          asset_url: assetUrl,
          blend,
          x, y, w, h, rot,
        },
        tags: ["edit", "stamp", blend],
      });
    } catch (e) {
      console.error("[safe-edit:stamp] saveAsset failed (non-fatal):", e);
    }

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
    // Dual-write: detail brush is an inpaint edit on the source image.
    try {
      const parentId = await (deps as any).lookupAssetIdByUrl?.(imageUrl);
      await (deps as any).saveAsset?.({
        asset_type: "edit",
        source_url: resultUrl,
        engine: "darkroom-detail-brush",
        edit_action: "detail-brush",
        prompt: brush.prompt,
        parent_id: parentId || null,
        metadata: {
          source_url: imageUrl,
          mask_url: maskUrl,
          brush_id: brushId,
          brush_name: brush.name,
        },
        tags: ["edit", "detail-brush", brushId],
      });
    } catch (e) {
      console.error("[safe-edit:detail-brush] saveAsset failed (non-fatal):", e);
    }

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
          userMsg = "Darkroom Skin declined this image (content filter). Try Skin instead — it's permissive and pore-aware.";
        } else {
          userMsg = "Darkroom Skin couldn't process this image. Try a different source or Skin for body skin.";
        }
      } else if (status === 401 || status === 403) {
        userMsg = "Darkroom Skin authentication issue. Try again in a moment.";
      } else if (status === 429) {
        userMsg = "Darkroom Skin rate limited. Wait a few seconds and try again.";
      } else if (status >= 500) {
        userMsg = "Darkroom Skin service temporarily unavailable. Try again or use Skin.";
      } else {
        userMsg = `Darkroom Skin failed (status ${status}). Try Skin for skin pores.`;
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
    // Dual-write: darkroom-skin is a skin-pass edit on the source image.
    try {
      const parentId = await (deps as any).lookupAssetIdByUrl?.(imageUrl);
      await (deps as any).saveAsset?.({
        asset_type: "edit",
        source_url: finalUrl,
        engine: "darkroom-skin",
        edit_action: "skin-pass",
        prompt: "[darkroom-skin]",
        parent_id: parentId || null,
        metadata: {
          source_url: imageUrl,
          intensity,
          version: "v1",
        },
        tags: ["edit", "darkroom-skin", "skin-pass", intensity],
      });
    } catch (e) {
      console.error("[safe-edit:darkroom-skin] saveAsset failed (non-fatal):", e);
    }

    // Pre-warm content-profile cache for the new asset. Fire-and-forget.
    queueBackgroundReanalysis(finalUrl);

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
      throw new Error(`AI vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
// /api/wear-garment — Strip multi-image: person + garment ref → person wearing
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
    // Dual-write: wear-garment dresses the subject (an edit on the source).
    try {
      const parentId = await (deps as any).lookupAssetIdByUrl?.(imageUrl);
      await (deps as any).saveAsset?.({
        asset_type: "edit",
        source_url: resultUrl,
        engine: upscaler === "none" ? "p-edit-multi" : `p-edit-multi+${upscaler}`,
        edit_action: "wear",
        prompt,
        parent_id: parentId || null,
        metadata: {
          source_url: imageUrl,
          garment_urls: garmentUrls,
          upscaler,
        },
        tags: ["edit", "wear-garment", "p-edit"],
      });
    } catch (e) {
      console.error("[safe-edit:wear-garment] saveAsset failed (non-fatal):", e);
    }

    // Pre-warm content-profile cache for the new asset. Fire-and-forget.
    queueBackgroundReanalysis(resultUrl);

    return Response.json({
      ok: true,
      image_url: resultUrl,
      model: upscaler === "none" ? "Strip (multi-image)" : `Strip (multi-image) + ${upscaler === "topaz" ? "Develop" : upscaler}`,
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
      throw new Error(`AI vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
// /api/remove-bg — strip background → transparent PNG via Cutout on FAL.
// Body: { image_url } → { image_url }
// -----------------------------------------------------------------------------

// Wardrobe-eligibility heuristics for a cutout produced by /api/remove-bg.
// A garment is "save-to-wardrobe" eligible when:
//   - dimensions exceed a minimum (256 × 256) so the saved entry isn't a
//     thumbnail, AND
//   - alpha coverage is between 5% and 95% — i.e. the image actually has a
//     visible subject AND a transparent background. Coverage outside that
//     range usually means BiRefNet either cut everything (~0%) or nothing
//     (~100%, fully opaque), neither of which is a useful wardrobe asset.
// Returns {eligible, reason} so the caller can echo the decision.
const WARDROBE_MIN_DIM = 256;
const WARDROBE_MIN_ALPHA_COVERAGE = 0.30; // 30% per spec — keeps small accents in
const WARDROBE_MAX_ALPHA_COVERAGE = 0.95; // ~fully opaque means bg-strip didn't fire

async function computeWardrobeEligibility(buf: Buffer): Promise<{
  eligible: boolean;
  reason: string;
  alpha_coverage?: number;
  width?: number;
  height?: number;
}> {
  try {
    const sharp = (await import("sharp")).default;
    const img = sharp(buf);
    const meta = await img.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < WARDROBE_MIN_DIM || height < WARDROBE_MIN_DIM) {
      return {
        eligible: false,
        reason: "too_small",
        width,
        height,
      };
    }
    if (!meta.hasAlpha) {
      return {
        eligible: false,
        reason: "no_alpha_channel",
        width,
        height,
      };
    }
    // Compute fraction of pixels with alpha > 128 (i.e. solidly visible).
    // sharp.stats() returns mean alpha in 0..255 — convert to 0..1 coverage
    // proxy. Cheaper than rasterizing and counting pixels manually.
    const alphaStats = await sharp(buf).extractChannel("alpha").stats();
    const alphaChannel = alphaStats.channels[0];
    if (!alphaChannel) {
      return { eligible: false, reason: "alpha_stats_unavailable", width, height };
    }
    const coverage = alphaChannel.mean / 255; // 0..1
    if (coverage < WARDROBE_MIN_ALPHA_COVERAGE) {
      return {
        eligible: false,
        reason: "alpha_too_low",
        alpha_coverage: Number(coverage.toFixed(3)),
        width,
        height,
      };
    }
    if (coverage > WARDROBE_MAX_ALPHA_COVERAGE) {
      return {
        eligible: false,
        reason: "alpha_too_high",
        alpha_coverage: Number(coverage.toFixed(3)),
        width,
        height,
      };
    }
    return {
      eligible: true,
      reason: "eligible",
      alpha_coverage: Number(coverage.toFixed(3)),
      width,
      height,
    };
  } catch (err: any) {
    // Eligibility check is best-effort — never block the cutout response.
    return {
      eligible: false,
      reason: `eligibility_check_failed: ${String(err?.message || err).slice(0, 80)}`,
    };
  }
}

async function handleRemoveBg(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const imageUrl = String(body.image_url || "");
    if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });

    // Short-circuit: if the source image already has non-uniform alpha
    // (i.e. it's already cut out / has real transparency), skip BiRefNet.
    try {
      const probe = await fetch(imageUrl);
      if (probe.ok) {
        const probeBuf = Buffer.from(await probe.arrayBuffer());
        const sharp = (await import("sharp")).default;
        const meta = await sharp(probeBuf).metadata();
        if (meta.hasAlpha) {
          // Sample alpha channel — if min < 250, the image has real transparency
          // (not just edge anti-aliasing on an otherwise opaque PNG).
          const alphaStats = await sharp(probeBuf).extractChannel("alpha").stats();
          const alphaChannel = alphaStats.channels[0];
          if (alphaChannel && alphaChannel.min < 250) {
            // Image is already a cutout — re-use it AND run the wardrobe
            // eligibility check on it so the UI can prompt to save.
            const elig = await computeWardrobeEligibility(probeBuf);
            return Response.json({
              ok: true,
              image_url: imageUrl,
              skipped: true,
              reason: "already has transparency",
              wardrobe_eligible: elig.eligible,
              wardrobe_eligibility_reason: elig.reason,
              wardrobe_eligibility_meta: {
                alpha_coverage: elig.alpha_coverage,
                width: elig.width,
                height: elig.height,
              },
            });
          }
        }
      }
    } catch {
      // Probe failure is non-fatal — fall through to BiRefNet.
    }

    const res = await fetch("https://fal.run/fal-ai/birefnet/v2", {
      method: "POST",
      headers: {
        Authorization: `Key ${env("FAL_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image_url: imageUrl, output_format: "png" }),
    });
    if (!res.ok) {
      throw new Error(`Cutout ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    const url = data.image?.url || data.images?.[0]?.url;
    if (!url) throw new Error("Cutout returned no image");

    // Re-host to our Supabase so it doesn't expire and is CORS-friendly for the canvas
    const dl = await fetch(url);
    if (!dl.ok) throw new Error(`download ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const { uploadToStorage, buildUploadPath } = await import("../supabase");
    const finalUrl = await uploadBufferToStorage(buf, "image/png", buildUploadPath, uploadToStorage, "cutout");

    // Wardrobe-eligibility post-check on the cutout we just produced. The
    // value is advisory only — failures are non-fatal and don't change the
    // cutout response. UI uses this to decide whether to surface the
    // "★ Save to Wardrobe" affordance on the result image.
    const elig = await computeWardrobeEligibility(buf);

    return Response.json({
      ok: true,
      image_url: finalUrl,
      wardrobe_eligible: elig.eligible,
      wardrobe_eligibility_reason: elig.reason,
      wardrobe_eligibility_meta: {
        alpha_coverage: elig.alpha_coverage,
        width: elig.width,
        height: elig.height,
      },
    });
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
    // Dual-write: sandwich is a clothe→edit→unclothe pipeline; final is an
    // edit relative to the original (not the intermediate clothed/edited URLs).
    try {
      const parentId = await (deps as any).lookupAssetIdByUrl?.(imageUrl);
      await (deps as any).saveAsset?.({
        asset_type: "edit",
        source_url: finalUrl,
        engine: `sandwich-${editEngine}${upscaler !== "none" ? "+" + upscaler : ""}`,
        edit_action: "sandwich",
        prompt: editPrompt,
        parent_id: parentId || null,
        metadata: {
          source_url: imageUrl,
          edit_engine: editEngine,
          upscaler,
          clothed_url: clothedUrl,
          edited_url: editedUrl,
        },
        tags: ["edit", "sandwich", editEngine],
      });
    } catch (e) {
      console.error("[safe-edit:sandwich] saveAsset failed (non-fatal):", e);
    }

    // Pre-warm content-profile cache for the new asset. Fire-and-forget.
    queueBackgroundReanalysis(finalUrl);

    return Response.json({
      ok: true,
      image_url: finalUrl,
      clothed_url: clothedUrl,
      edited_url: editedUrl,
      model: `sandwich (Strip → ${editEngine === "nano" ? "Glance" : editEngine === "gpt" ? "Eye" : editEngine} → Strip)${upscaler !== "none" ? " + " + (upscaler === "topaz" ? "Develop" : upscaler) : ""}`,
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

    // Detect blank/uniform-color results — fal.ai's content moderation
    // silently returns a black placeholder instead of an error. Catch it.
    const isBlank = await isImageBlankOrUniform(editedBuf);
    if (isBlank) {
      return Response.json({
        ok: false,
        error: "Inpaint blocked by content filter on this image. Try a different engine (Strip is more permissive).",
      }, { status: 422 });
    }

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
    // Dual-write: inpaint is a brush edit on the source image.
    try {
      const parentId = await (deps as any).lookupAssetIdByUrl?.(imageUrl);
      await (deps as any).saveAsset?.({
        asset_type: "edit",
        source_url: resultUrl,
        engine: upscaler === "none" ? "flux-fill-pro" : `flux-fill-pro+${upscaler}`,
        edit_action: "inpaint",
        prompt,
        parent_id: parentId || null,
        metadata: {
          source_url: imageUrl,
          mask_url: maskUrl,
          upscaler,
          garment_urls: garmentUrls,
          garment_strength: garmentStrength ?? null,
        },
        tags: ["edit", "inpaint", "brush"],
      });
    } catch (e) {
      console.error("[safe-edit:inpaint] saveAsset failed (non-fatal):", e);
    }

    // Pre-warm content-profile cache for the new asset. Fire-and-forget.
    queueBackgroundReanalysis(resultUrl);

    return Response.json({
      ok: true,
      image_url: resultUrl,
      mask_url: maskUrl,
      model: upscaler === "none" ? "Brush" : `Brush + ${upscaler === "topaz" ? "Develop" : upscaler}`,
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
// /api/analyze-image — one-shot Grok Vision content classifier (v2)
//
// Returns a structured content profile the UI uses to drive engine routing
// (see GET /api/engine-compatibility for the verdict map). v2 profile shape:
//   {
//     nudity_level: "none" | "implied" | "topless" | "explicit",
//     face_visible: boolean,
//     scene_type:   "studio" | "outdoor" | "bedroom" | "bathroom"
//                  | "abstract" | "other",
//     subject_count: integer,
//     content_complexity: "simple" | "moderate" | "complex",
//     skin_tone_dominant: "light" | "medium" | "dark" | "varied" | "n/a",
//     explicit_text: boolean,
//     primary_subject: "person" | "object" | "scene" | "abstract" | "other",
//     explicit_acts: boolean,
//     minor_concern: boolean,
//     violence: boolean,
//     tags: string[]
//   }
//
// Cache layers (read in order, write best-effort):
//   1. assets.metadata.content_profile — DB-backed, keyed by source_url. Only
//      counts as a hit if the cached profile has all v2 fields (we re-classify
//      and overwrite wave-11 partials).
//   2. Client-side sessionStorage — cache_key (sha256(image_url)) is returned
//      on every response and the UI dedupes there.
//
// Hard-refusal short-circuit: if the classifier flags `minor_concern` or
// `violence`, the endpoint returns 422 with `error: "content_refused"` so
// engines never run on those.
// -----------------------------------------------------------------------------

const ANALYZE_IMAGE_SYSTEM_PROMPT = `You are a content classifier. Analyze the image and return a JSON object with:
{
  "nudity_level": "none" | "implied" | "topless" | "explicit",
  "face_visible": boolean,
  "scene_type": "studio" | "outdoor" | "bedroom" | "bathroom" | "abstract" | "other",
  "subject_count": integer,
  "content_complexity": "simple" | "moderate" | "complex",
  "skin_tone_dominant": "light" | "medium" | "dark" | "varied" | "n/a",
  "explicit_text": boolean,
  "primary_subject": "person" | "object" | "scene" | "abstract" | "other",
  "explicit_acts": boolean,
  "minor_concern": boolean,
  "violence": boolean,
  "tags": string[]
}
For minor_concern, err on the side of caution — true if the image MAY depict a minor.
For violence, true if the image depicts gore, weapons, or injury.
For explicit_acts, true only if the image depicts explicit sexual acts.
For tags, return 3-8 free-form descriptive lowercase tags (e.g. "studio", "softbox", "warm-tones").
Return ONLY the JSON object, no markdown fences, no explanation.`;

const ANALYZE_NUDITY_VALUES = new Set(["none", "implied", "topless", "explicit"]);
const ANALYZE_SCENE_VALUES = new Set([
  "studio",
  "outdoor",
  "bedroom",
  "bathroom",
  "abstract",
  "other",
]);
const ANALYZE_COMPLEXITY_VALUES = new Set(["simple", "moderate", "complex"]);
const ANALYZE_SKIN_TONE_VALUES = new Set(["light", "medium", "dark", "varied", "n/a"]);
const ANALYZE_PRIMARY_SUBJECT_VALUES = new Set([
  "person",
  "object",
  "scene",
  "abstract",
  "other",
]);

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// A cached content_profile is only "v2-complete" if the caution flags + tags
// were populated. Wave-11 rows are missing these — we re-classify those.
function isV2Profile(p: any): boolean {
  if (!p || typeof p !== "object") return false;
  return (
    typeof p.minor_concern === "boolean" &&
    typeof p.violence === "boolean" &&
    typeof p.explicit_acts === "boolean" &&
    typeof p.primary_subject === "string" &&
    Array.isArray(p.tags)
  );
}

// Best-effort lookup of an asset row whose source_url matches imageUrl.
// Returns { id, metadata } on hit, null otherwise. Failures are swallowed —
// caching is non-blocking.
async function lookupAssetBySourceUrl(
  imageUrl: string
): Promise<{ id: string; metadata: any } | null> {
  if (!SUPABASE_URL) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/assets?source_url=eq.${encodeFilterValue(imageUrl)}&select=id,metadata&limit=1`,
      { headers: supaHeaders() }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (!row?.id) return null;
    return { id: String(row.id), metadata: row.metadata || {} };
  } catch {
    return null;
  }
}

// Best-effort write — failures are logged and swallowed so the endpoint never
// fails just because the cache write didn't land.
async function writeAssetContentProfile(
  assetId: string,
  existingMetadata: any,
  profile: any
): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const merged = {
      ...(existingMetadata && typeof existingMetadata === "object" ? existingMetadata : {}),
      content_profile: profile,
    };
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/assets?id=eq.${encodeFilterValue(assetId)}`,
      {
        method: "PATCH",
        headers: supaHeaders(),
        body: JSON.stringify({
          metadata: merged,
          updated_at: new Date().toISOString(),
        }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[analyze-image] cache write failed for asset ${assetId}: ${errText.slice(0, 200)}`);
    }
  } catch (err: any) {
    console.warn(`[analyze-image] cache write threw for asset ${assetId}: ${err?.message || err}`);
  }
}

async function handleAnalyzeImage(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const imageUrl = String(body?.image_url || "").trim();
    if (!imageUrl) {
      return Response.json({ error: "image_url required" }, { status: 400 });
    }

    const cacheKey = await sha256Hex(imageUrl);

    // ── Read path: DB cache lookup ──────────────────────────────────────────
    // If an asset row exists for this source_url AND its metadata.content_profile
    // is v2-complete, return the cached profile immediately (sub-100ms path).
    // Hard-refusal flags still short-circuit cached hits — never let a refused
    // profile get through with status 200.
    const assetHit = await lookupAssetBySourceUrl(imageUrl);
    if (assetHit && isV2Profile(assetHit.metadata?.content_profile)) {
      const cachedProfile = assetHit.metadata.content_profile;
      if (cachedProfile.minor_concern || cachedProfile.violence) {
        return Response.json(
          {
            error: "content_refused",
            refusal_reason: cachedProfile.minor_concern ? "minor_concern" : "violence",
            profile: cachedProfile,
            cache_key: cacheKey,
            cached: true,
          },
          { status: 422 }
        );
      }
      return Response.json({
        ok: true,
        cache_key: cacheKey,
        content_profile: cachedProfile,
        cached: true,
      });
    }

    // ── Classify ────────────────────────────────────────────────────────────
    const visionRes = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("XAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-4-1-fast-non-reasoning",
        messages: [
          { role: "system", content: ANALYZE_IMAGE_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Classify this image. Return ONLY the JSON object." },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        temperature: 0,
      }),
    });

    if (!visionRes.ok) {
      const errText = await visionRes.text();
      return Response.json(
        {
          error: "vision_failed",
          status: visionRes.status,
          detail: errText.slice(0, 400),
        },
        { status: 502 }
      );
    }

    const visionData = await visionRes.json();
    const raw = String(visionData?.choices?.[0]?.message?.content || "{}").trim();
    const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return Response.json(
        { error: "vision_unparseable", raw: cleaned.slice(0, 400) },
        { status: 502 }
      );
    }

    // Defensive normalization — never trust the model's exact spelling.
    const nudity = String(parsed.nudity_level || "").toLowerCase();
    const scene = String(parsed.scene_type || "").toLowerCase();
    const complexity = String(parsed.content_complexity || "").toLowerCase();
    const skinTone = String(parsed.skin_tone_dominant || "").toLowerCase();
    const primarySubject = String(parsed.primary_subject || "").toLowerCase();

    // Tags — array of 3-8 lowercase strings, defensive against scalars/objects.
    let tags: string[] = [];
    if (Array.isArray(parsed.tags)) {
      tags = parsed.tags
        .map((t: any) => String(t || "").trim().toLowerCase())
        .filter((t: string) => t.length > 0 && t.length <= 64)
        .slice(0, 8);
    }

    const profile = {
      nudity_level: ANALYZE_NUDITY_VALUES.has(nudity) ? nudity : "none",
      face_visible: Boolean(parsed.face_visible),
      scene_type: ANALYZE_SCENE_VALUES.has(scene) ? scene : "other",
      subject_count: Number.isFinite(parsed.subject_count)
        ? Math.max(0, Math.round(Number(parsed.subject_count)))
        : 0,
      content_complexity: ANALYZE_COMPLEXITY_VALUES.has(complexity)
        ? complexity
        : "moderate",
      skin_tone_dominant: ANALYZE_SKIN_TONE_VALUES.has(skinTone) ? skinTone : "n/a",
      explicit_text: Boolean(parsed.explicit_text),
      primary_subject: ANALYZE_PRIMARY_SUBJECT_VALUES.has(primarySubject)
        ? primarySubject
        : "other",
      explicit_acts: Boolean(parsed.explicit_acts),
      minor_concern: Boolean(parsed.minor_concern),
      violence: Boolean(parsed.violence),
      tags,
    };

    // ── Write path: best-effort DB cache update ─────────────────────────────
    // If an asset row exists for this source_url, persist the profile under
    // metadata.content_profile so the next call hits the cache. We write
    // BEFORE the refusal short-circuit so refused profiles also get cached
    // (next call will short-circuit faster).
    if (assetHit) {
      await writeAssetContentProfile(assetHit.id, assetHit.metadata, profile);
    }

    // ── Hard-refusal short-circuit ──────────────────────────────────────────
    if (profile.minor_concern || profile.violence) {
      return Response.json(
        {
          error: "content_refused",
          refusal_reason: profile.minor_concern ? "minor_concern" : "violence",
          profile,
          cache_key: cacheKey,
        },
        { status: 422 }
      );
    }

    return Response.json({
      ok: true,
      cache_key: cacheKey,
      content_profile: profile,
    });
  } catch (err: any) {
    return Response.json({ error: err?.message || "analyze_failed" }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// queueBackgroundReanalysis — fire-and-forget content-profile pre-warm.
//
// Called after every successful edit handler with the rehosted result URL.
// Invokes handleAnalyzeImage directly (no HTTP self-call, no auth gate) so
// assets.metadata.content_profile is populated before the next request that
// needs the profile (Watch routing, engine-compat lookup) hits this URL.
//
// Contract:
//   - NEVER awaited by the caller. Caller responds immediately.
//   - Errors are logged and swallowed. Cache miss is the worst-case outcome.
//   - No-op when imageUrl is empty/falsy.
// -----------------------------------------------------------------------------
function queueBackgroundReanalysis(imageUrl: string): void {
  if (!imageUrl) return;
  void (async () => {
    try {
      const req = new Request("http://internal/api/analyze-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url: imageUrl }),
      });
      // handleAnalyzeImage has no internal auth check — calling it directly
      // bypasses the route-level checkAuth gate cleanly. We discard the
      // response; the side-effect (writeAssetContentProfile cache write)
      // is what we want.
      await handleAnalyzeImage(req).catch((e: any) =>
        console.warn("[bg-reanalysis] analyze failed:", e?.message || e)
      );
    } catch (e: any) {
      console.warn("[bg-reanalysis] outer error:", e?.message || e);
    }
  })();
}

// -----------------------------------------------------------------------------
// /api/face-lock/drift-check — face-similarity between two images via Grok
// Vision. Single multi-image chat-completions call with strict JSON output.
// Best-effort: failures return the appropriate status without throwing so the
// UI's badge code can swallow the error and skip the badge.
// -----------------------------------------------------------------------------

const FACE_DRIFT_SYSTEM_PROMPT = `You are a face similarity classifier. You will be shown two images: image 1 ("before") and image 2 ("after").

Return ONLY a JSON object — no markdown fences, no commentary — with this exact shape:
{
  "face_count_before": integer,
  "face_count_after": integer,
  "same_person": true | false | null,
  "similarity": float between 0.0 and 1.0,
  "notable_differences": string (max 100 chars)
}

Rules:
- "face_count_*" counts the number of distinct human faces visible in each image. 0 if no face.
- "same_person" is null when either image has zero clear faces or you cannot tell.
- "similarity" is 0.0 for clearly different people; 1.0 for an identical face. Rate STRICTLY: even small shifts in eye color, jaw shape, brow position, nose proportion, or lip shape should drop similarity below 0.9. Lighting / makeup / hair style alone should not penalize similarity below 0.85 if the underlying face is the same.
- "notable_differences" is a short human-readable description (e.g., "eye color shifted blue->green", "jaw narrower", "wider nose"). Empty string if none.
- Return ONLY the raw JSON. No prose, no fences.`;

type FaceDriftResult = {
  similarity: number;
  drift_level:
    | "identical"
    | "minor"
    | "moderate"
    | "significant"
    | "no_face"
    | "face_count_mismatch";
  face_count_before: number;
  face_count_after: number;
  notable_differences: string;
  same_person: boolean | null;
};

function deriveDriftLevel(
  similarity: number,
  faceBefore: number,
  faceAfter: number
): FaceDriftResult["drift_level"] {
  if (faceBefore === 0 && faceAfter === 0) return "no_face";
  if (faceBefore !== faceAfter) return "face_count_mismatch";
  if (similarity >= 0.95) return "identical";
  if (similarity >= 0.85) return "minor";
  if (similarity >= 0.7) return "moderate";
  return "significant";
}

function stripJsonFences(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

async function handleFaceLockDriftCheck(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const beforeUrl = String(body?.before_url || "").trim();
    const afterUrl = String(body?.after_url || "").trim();

    if (!beforeUrl) {
      return Response.json({ error: "before_url required" }, { status: 400 });
    }
    if (!afterUrl) {
      return Response.json({ error: "after_url required" }, { status: 400 });
    }

    // Single Grok Vision call with both images attached to one user message.
    // Grok-2-vision and grok-4-1-fast-non-reasoning accept multi-image content
    // arrays — same shape used by handleAnalyzeImage with one image, just with
    // a second image_url part. The temperature is pinned to 0 so the JSON is
    // deterministic for the same input pair.
    const visionRes = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("XAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-4-1-fast-non-reasoning",
        messages: [
          { role: "system", content: FACE_DRIFT_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Compare the faces in these two images. Return ONLY the JSON object.",
              },
              { type: "image_url", image_url: { url: beforeUrl } },
              { type: "image_url", image_url: { url: afterUrl } },
            ],
          },
        ],
        temperature: 0,
      }),
    });

    if (!visionRes.ok) {
      const errText = await visionRes.text().catch(() => "");
      return Response.json(
        {
          error: "vision_failed",
          status: visionRes.status,
          detail: errText.slice(0, 400),
        },
        { status: 502 }
      );
    }

    const visionData = await visionRes.json();
    const raw = String(visionData?.choices?.[0]?.message?.content || "{}");
    const cleaned = stripJsonFences(raw);

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return Response.json(
        { error: "vision_unparseable", raw: cleaned.slice(0, 400) },
        { status: 502 }
      );
    }

    // Defensive normalization — never trust the model's exact shape.
    const faceBefore = Number.isFinite(parsed.face_count_before)
      ? Math.max(0, Math.round(Number(parsed.face_count_before)))
      : 0;
    const faceAfter = Number.isFinite(parsed.face_count_after)
      ? Math.max(0, Math.round(Number(parsed.face_count_after)))
      : 0;
    const rawSim = Number(parsed.similarity);
    const similarity = Number.isFinite(rawSim) ? Math.max(0, Math.min(1, rawSim)) : 0;
    const samePerson =
      parsed.same_person === true
        ? true
        : parsed.same_person === false
        ? false
        : null;
    const notableDifferences = String(parsed.notable_differences || "").slice(0, 200);

    const drift_level = deriveDriftLevel(similarity, faceBefore, faceAfter);

    const result: FaceDriftResult = {
      similarity,
      drift_level,
      face_count_before: faceBefore,
      face_count_after: faceAfter,
      notable_differences: notableDifferences,
      same_person: samePerson,
    };

    return Response.json(result);
  } catch (err: any) {
    return Response.json(
      { error: err?.message || "drift_check_failed" },
      { status: 500 }
    );
  }
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
    // Re-route diagnostics for explicit model paths that go through the
    // free re-routing wrapper. (Auto path uses its own Eye→Strip fallback
    // below; that's a separate, pre-existing flow that pre-dates the
    // engine-compatibility map.)
    let rerouted:
      | { from: string; to: string; refusal_reason: string }
      | null = null;

    // Single-image edits (no mask) get the identity anchor prepended.
    // If a mask is supplied, this is a brush/protect-region flow and the
    // mask carries identity preservation — skip the anchor.
    const isSingleImageEdit = !body.mask_url;
    const anchoredPrompt = isSingleImageEdit
      ? `${IDENTITY_ANCHOR}. ${body.prompt}`
      : body.prompt;

    // Map model preference → canonical engine name for the re-routing layer.
    const PREF_TO_ENGINE: Record<string, string> = {
      nano: "glance",
      grok: "lens",
      pedit: "strip",
    };

    // Explicit model paths — wrap with callWithRerouting so a content-filter
    // refusal on a SFW-leaning engine fans over to the next-best one.
    // (Strip/P-Edit refusals stay fatal — REROUTING_FATAL_ENGINES.)
    if (preferModel === "pedit" || preferModel === "nano" || preferModel === "grok") {
      const engineKey = PREF_TO_ENGINE[preferModel]!;
      const dispatched = await callWithRerouting(engineKey, null, {
        imageUrl: body.image_url,
        prompt: anchoredPrompt,
        maskUrl: body.mask_url,
      });
      resultUrl = dispatched.url;
      const niceName: Record<string, string> = {
        glance: "Glance",
        lens: "Lens",
        strip: "Strip",
        eye: "Eye",
        brush: "Brush",
      };
      modelUsed = niceName[dispatched.engineUsed] || dispatched.engineUsed;
      if (dispatched.rerouted) {
        rerouted = dispatched.rerouted;
        fallbackReason = `${niceName[dispatched.rerouted.from] || dispatched.rerouted.from} refused; rerouted to ${niceName[dispatched.rerouted.to] || dispatched.rerouted.to}`;
      }
    } else if (preferModel === "gpt" || preferModel === "auto") {
      // Eye first
      try {
        resultUrl = await callGptImage2Edit({
          imageUrl: body.image_url,
          maskUrl: body.mask_url,
          prompt: anchoredPrompt,
          size: body.size ?? GPT_SIZE,
          quality: body.quality ?? GPT_QUALITY,
        });
        modelUsed = "Eye";
      } catch (err: any) {
        const msg = String(err?.message || err);
        const isContentRefusal = isContentFilterError(err);
        if (preferModel === "gpt" || !isContentRefusal) {
          if (preferModel === "gpt") throw err;
          fallbackReason = `Eye error: ${msg.slice(0, 200)}`;
        } else {
          fallbackReason = "Eye refused (content policy); falling back to Strip";
          rerouted = {
            from: "eye",
            to: "strip",
            refusal_reason: msg.slice(0, 200),
          };
        }
      }

      // Auto fallback to Strip (handles NSFW + general edits) if Eye didn't deliver.
      if (!resultUrl) {
        resultUrl = await callPEdit({ imageUrl: body.image_url, prompt: anchoredPrompt });
        modelUsed = "Strip";
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
    // Dual-write: smart-edit is an edit on the source image.
    try {
      const parentId = await (deps as any).lookupAssetIdByUrl?.(body.image_url);
      await (deps as any).saveAsset?.({
        asset_type: "edit",
        source_url: resultUrl,
        engine: modelUsed,
        edit_action: "smart-edit",
        prompt: body.prompt,
        parent_id: parentId || null,
        metadata: {
          character_name: body.character || null,
          character_id: character?.id || null,
          source_url: body.image_url,
          mask_url: body.mask_url || null,
          prefer_model: preferModel,
          fallback_reason: fallbackReason,
          rerouted: rerouted,
        },
        tags: ["edit", "smart-edit", modelUsed.toLowerCase()],
      });
    } catch (e) {
      console.error("[safe-edit:smart-edit] saveAsset failed (non-fatal):", e);
    }

    // Pre-warm content-profile cache for the new asset. Fire-and-forget.
    queueBackgroundReanalysis(resultUrl);

    const smartResp: any = {
      ok: true,
      url: resultUrl,
      model: modelUsed,
      fallback_reason: fallbackReason,
    };
    if (rerouted) smartResp.rerouted = rerouted;
    return Response.json(smartResp);
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
    throw new Error(`Eye ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  // OpenAI returns { data: [{ b64_json: '...' }] } for gpt-image-1/2.
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) {
    // Some endpoints may return a URL instead — handle both.
    const url = data.data?.[0]?.url;
    if (url) return url;
    throw new Error("Eye returned no image");
  }
  // Re-upload the b64 image to our Supabase storage so we get a stable URL.
  return await uploadBase64ToSupabase(b64);
}

// -----------------------------------------------------------------------------
// Strip (prunaai/p-image-edit) — workhorse for free-form edits incl. NSFW
// -----------------------------------------------------------------------------

async function callNanoBanana(args: { imageUrl: string; prompt: string }): Promise<string> {
  // Google Gemini 2.5 Flash Image ("Glance") via FAL.
  // Fast, photoreal, less prone to scene reinterpretation than Eye.
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
    throw new Error(`Glance ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = await res.json();
  const url = data.images?.[0]?.url || data.image?.url;
  if (!url) throw new Error("Glance returned no image");
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
    throw new Error(`Strip ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  if (data.status === "failed") {
    throw new Error(`Strip failed: ${data.error || "unknown"}`);
  }
  const output = data.output;
  const url = Array.isArray(output) ? output[0] : output;
  if (!url) throw new Error("Strip returned no image");
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
    // Dual-write: make-nsfw is a P-Edit transform → upscale on the source.
    try {
      const parentId = await (deps as any).lookupAssetIdByUrl?.(body.image_url);
      await (deps as any).saveAsset?.({
        asset_type: "edit",
        source_url: finalUrl,
        engine: `p-image-edit+${upscalerUsed}`,
        edit_action: "make-nsfw",
        prompt: body.prompt,
        parent_id: parentId || null,
        metadata: {
          character_name: body.character || null,
          character_id: character?.id || null,
          source_url: body.image_url,
          edited_url: editedUrl,
          upscaler: upscalerUsed,
        },
        tags: ["edit", "make-nsfw", "p-edit", upscalerUsed],
      });
    } catch (e) {
      console.error("[safe-edit:make-nsfw] saveAsset failed (non-fatal):", e);
    }

    // Pre-warm content-profile cache for the new asset. Fire-and-forget.
    queueBackgroundReanalysis(finalUrl);

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
    throw new Error(`Develop submit ${submitRes.status}: ${(await submitRes.text()).slice(0, 200)}`);
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
      throw new Error(`Develop failed: ${statusData.error || "unknown"}`);
    }
  }
  throw new Error("Develop timed out after 2 minutes");
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

    // Step 6: if Eye refused, fall back to Brush on FAL
    let editedBuf: Buffer;
    let modelUsed = "Eye";
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
      modelUsed = `Brush (Eye ${gptError ? "refused" : "n/a"})`;
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
    // Dual-write: surgical-edit is a multi-stage edit relative to the source.
    try {
      const parentId = await (deps as any).lookupAssetIdByUrl?.(body.image_url);
      await (deps as any).saveAsset?.({
        asset_type: "edit",
        source_url: upscaledUrl || finalUrl,
        engine: modelUsed,
        edit_action: "surgical-edit",
        prompt: body.prompt,
        parent_id: parentId || null,
        metadata: {
          character_name: body.character || null,
          character_id: character?.id || null,
          source_url: body.image_url,
          manual_mask_url: body.manual_mask_url || null,
          feather: body.feather ?? 8,
          upscaled_url: upscaledUrl || null,
          intermediate_url: finalUrl,
          gpt_error: gptError,
        },
        tags: ["edit", "surgical-edit", modelUsed.toLowerCase()],
      });
    } catch (e) {
      console.error("[safe-edit:surgical-edit] saveAsset failed (non-fatal):", e);
    }

    // Pre-warm content-profile cache for the new asset. Fire-and-forget.
    queueBackgroundReanalysis(upscaledUrl || finalUrl);

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
    throw new Error(`AI Vision ${grokRes.status}: ${(await grokRes.text()).slice(0, 200)}`);
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

// =============================================================================
// /api/details/skin-tone-match — pure pixel-math color correction.
//
// Used by detail-brush + forge flows: take a generated detail asset (e.g. a
// nipple/areola PNG) and re-shift its pixels so the average skin tone matches
// the target image's skin region. Avoids visible color seams when the user
// composites the detail back onto the target.
//
// Body:
//   target_url   required — the canvas the detail will land on
//   detail_url   required — the patch to color-correct
//   mask_url     optional — single-channel mask of target_url where >128 = skin
//   mode         optional — 'lab-mean' (default) | 'histogram-match'
//
// Response:
//   { ok, url, mode, target_lab, detail_lab, shift }
//
// Modes:
//   lab-mean         — compute mean LAB of target skin + mean LAB of detail
//                      non-transparent pixels, shift detail by the delta.
//   histogram-match  — per-channel CDF remap of detail to match target skin's
//                      L/A/B distribution. Better on saturated details, ~3x
//                      slower. Falls back to lab-mean if budget runs out.
// =============================================================================

async function handleSkinToneMatch(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const targetUrl = String(body.target_url || "");
    const detailUrl = String(body.detail_url || "");
    const maskUrl = body.mask_url ? String(body.mask_url) : null;
    const mode = String(body.mode || "lab-mean").toLowerCase();

    if (!targetUrl || !detailUrl) {
      return Response.json({ error: "target_url and detail_url required" }, { status: 400 });
    }
    if (!["lab-mean", "histogram-match"].includes(mode)) {
      return Response.json({ error: "mode must be 'lab-mean' or 'histogram-match'" }, { status: 400 });
    }

    const sharp = (await import("sharp")).default;
    const { uploadToStorage, buildUploadPath } = await import("../supabase");

    const [targetResp, detailResp, maskResp] = await Promise.all([
      fetch(targetUrl),
      fetch(detailUrl),
      maskUrl ? fetch(maskUrl) : Promise.resolve(null as any),
    ]);
    if (!targetResp.ok) return Response.json({ error: "target_url fetch failed" }, { status: 422 });
    if (!detailResp.ok) return Response.json({ error: "detail_url fetch failed" }, { status: 422 });

    const targetBuf = Buffer.from(await targetResp.arrayBuffer());
    const detailBuf = Buffer.from(await detailResp.arrayBuffer());
    const maskBuf = maskResp && maskResp.ok ? Buffer.from(await maskResp.arrayBuffer()) : null;

    // Decode raw RGB(A) for both images.
    const { data: targetData, info: targetInfo } = await sharp(targetBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data: detailData, info: detailInfo } = await sharp(detailBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Resize mask to target dims, single-channel grey.
    let maskData: Buffer | null = null;
    let maskInfo: { width: number; height: number } | null = null;
    if (maskBuf) {
      const m = await sharp(maskBuf)
        .resize(targetInfo.width, targetInfo.height, { fit: "fill" })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      maskData = m.data;
      maskInfo = { width: m.info.width, height: m.info.height };
    }

    // Mean LAB over the target's skin region (mask if present, else center 30%).
    const targetLab = computeMeanLab(targetData, targetInfo, maskData, maskInfo, false);

    // Mean LAB over detail's non-transparent pixels.
    const detailLab = computeMeanLab(detailData, detailInfo, null, null, true);

    let outRaw: Buffer;
    let histogramFallback = false;
    if (mode === "histogram-match") {
      try {
        outRaw = histogramMatchDetailToTarget(targetData, targetInfo, detailData, detailInfo, maskData, maskInfo);
      } catch (e) {
        // Fail soft to lab-mean — still useful.
        histogramFallback = true;
        outRaw = applyLabShift(detailData, detailInfo, [
          targetLab[0] - detailLab[0],
          targetLab[1] - detailLab[1],
          targetLab[2] - detailLab[2],
        ]);
      }
    } else {
      const shift: [number, number, number] = [
        targetLab[0] - detailLab[0],
        targetLab[1] - detailLab[1],
        targetLab[2] - detailLab[2],
      ];
      outRaw = applyLabShift(detailData, detailInfo, shift);
    }

    const outPng = await sharp(outRaw, {
      raw: {
        width: detailInfo.width,
        height: detailInfo.height,
        channels: detailInfo.channels as 1 | 2 | 3 | 4,
      },
    })
      .png()
      .toBuffer();

    const url = await uploadBufferToStorage(
      outPng,
      "image/png",
      buildUploadPath,
      uploadToStorage,
      "skin-match",
    );

    const shift: [number, number, number] = [
      targetLab[0] - detailLab[0],
      targetLab[1] - detailLab[1],
      targetLab[2] - detailLab[2],
    ];

    const headers: Record<string, string> = {};
    if (histogramFallback) headers["x-histogram-fallback"] = "true";

    return Response.json(
      {
        ok: true,
        url,
        mode,
        target_lab: targetLab,
        detail_lab: detailLab,
        shift,
        ...(histogramFallback ? { histogram_fallback: true } : {}),
      },
      { headers },
    );
  } catch (e: any) {
    return Response.json({ error: e?.message || "skin-tone-match failed" }, { status: 500 });
  }
}

// sRGB 0..255 → CIE LAB (D65). Inline math; no new deps.
function rgbToLab(R: number, G: number, B: number): [number, number, number] {
  const r = R / 255, g = G / 255, b = B / 255;
  const lr = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
  const lg = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
  const lb = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
  // D65 reference white.
  const X = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047;
  const Y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750) / 1.00000;
  const Z = (lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041) / 1.08883;
  const fx = X > 0.008856 ? Math.cbrt(X) : (7.787 * X + 16 / 116);
  const fy = Y > 0.008856 ? Math.cbrt(Y) : (7.787 * Y + 16 / 116);
  const fz = Z > 0.008856 ? Math.cbrt(Z) : (7.787 * Z + 16 / 116);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const yp = fy * fy * fy > 0.008856 ? fy * fy * fy : (fy - 16 / 116) / 7.787;
  const xp = fx * fx * fx > 0.008856 ? fx * fx * fx : (fx - 16 / 116) / 7.787;
  const zp = fz * fz * fz > 0.008856 ? fz * fz * fz : (fz - 16 / 116) / 7.787;
  const X = xp * 0.95047;
  const Y = yp * 1.00000;
  const Z = zp * 1.08883;
  const lr = X *  3.2404542 + Y * -1.5371385 + Z * -0.4985314;
  const lg = X * -0.9692660 + Y *  1.8760108 + Z *  0.0415560;
  const lb = X *  0.0556434 + Y * -0.2040259 + Z *  1.0572252;
  const r  = lr <= 0.0031308 ? lr * 12.92 : 1.055 * Math.pow(Math.max(0, lr), 1 / 2.4) - 0.055;
  const g  = lg <= 0.0031308 ? lg * 12.92 : 1.055 * Math.pow(Math.max(0, lg), 1 / 2.4) - 0.055;
  const bo = lb <= 0.0031308 ? lb * 12.92 : 1.055 * Math.pow(Math.max(0, lb), 1 / 2.4) - 0.055;
  return [r * 255, g * 255, bo * 255];
}

function clamp255(v: number): number { return Math.max(0, Math.min(255, Math.round(v))); }

// Compute mean LAB over a region. Region selection:
//   - if mask provided: pixels where mask>128
//   - else if alphaGate: pixels where alpha>128 (detail-image case)
//   - else: center 30% rectangle (heuristic skin-region for target_url)
// Stride 2 for speed; ~4x fewer pixels processed at no visible accuracy cost.
function computeMeanLab(
  data: Buffer,
  info: { width: number; height: number; channels: number },
  mask: Buffer | null,
  maskInfo: { width: number; height: number } | null,
  alphaGate: boolean,
): [number, number, number] {
  const ch = info.channels;
  let sumL = 0, sumA = 0, sumB = 0, count = 0;

  const cx = info.width / 2;
  const cy = info.height / 2;
  const radiusX = info.width * 0.3 / 2;
  const radiusY = info.height * 0.3 / 2;

  for (let y = 0; y < info.height; y += 2) {
    for (let x = 0; x < info.width; x += 2) {
      const idx = (y * info.width + x) * ch;
      let include = false;
      if (mask && maskInfo) {
        const m = mask[y * maskInfo.width + x];
        include = m > 128;
      } else if (alphaGate && ch === 4) {
        include = data[idx + 3] > 128;
      } else {
        include = Math.abs(x - cx) < radiusX && Math.abs(y - cy) < radiusY;
      }
      if (!include) continue;
      const lab = rgbToLab(data[idx], data[idx + 1], data[idx + 2]);
      sumL += lab[0]; sumA += lab[1]; sumB += lab[2];
      count++;
    }
  }
  if (count === 0) return [50, 0, 0];
  return [sumL / count, sumA / count, sumB / count];
}

// Apply a constant LAB shift to every non-transparent pixel of a detail image.
// Returns a fresh raw buffer with the same channel layout as the input.
function applyLabShift(
  data: Buffer,
  info: { width: number; height: number; channels: number },
  shift: [number, number, number],
): Buffer {
  const ch = info.channels;
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += ch) {
    if (ch === 4 && data[i + 3] < 128) {
      out[i] = data[i];
      out[i + 1] = data[i + 1];
      out[i + 2] = data[i + 2];
      out[i + 3] = data[i + 3];
      continue;
    }
    const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
    const rgb = labToRgb(lab[0] + shift[0], lab[1] + shift[1], lab[2] + shift[2]);
    out[i] = clamp255(rgb[0]);
    out[i + 1] = clamp255(rgb[1]);
    out[i + 2] = clamp255(rgb[2]);
    if (ch === 4) out[i + 3] = data[i + 3];
    else if (ch === 2) out[i + 1] = data[i + 1];
  }
  return out;
}

// Per-channel histogram match in LAB space. Build target CDFs from the skin
// region, build detail CDFs from non-transparent pixels, then for each detail
// pixel remap each LAB channel via inverse CDF lookup. ~3x more expensive than
// the lab-mean shift but matches tonal distribution, not just the mean.
function histogramMatchDetailToTarget(
  targetData: Buffer,
  targetInfo: { width: number; height: number; channels: number },
  detailData: Buffer,
  detailInfo: { width: number; height: number; channels: number },
  mask: Buffer | null,
  maskInfo: { width: number; height: number } | null,
): Buffer {
  // Discretize LAB:
  //   L: 0..100   → 256 bins
  //   a: -128..127 → 256 bins
  //   b: -128..127 → 256 bins
  const BINS = 256;
  const binL = (v: number) => Math.max(0, Math.min(BINS - 1, Math.round(v / 100 * (BINS - 1))));
  const binAB = (v: number) => Math.max(0, Math.min(BINS - 1, Math.round(v + 128)));
  const unbinL = (b: number) => b / (BINS - 1) * 100;
  const unbinAB = (b: number) => b - 128;

  const tHistL = new Uint32Array(BINS);
  const tHistA = new Uint32Array(BINS);
  const tHistB = new Uint32Array(BINS);
  const dHistL = new Uint32Array(BINS);
  const dHistA = new Uint32Array(BINS);
  const dHistB = new Uint32Array(BINS);

  // Build target histogram over skin region (mask or center-30%).
  const tch = targetInfo.channels;
  const tcx = targetInfo.width / 2;
  const tcy = targetInfo.height / 2;
  const trX = targetInfo.width * 0.3 / 2;
  const trY = targetInfo.height * 0.3 / 2;
  for (let y = 0; y < targetInfo.height; y += 2) {
    for (let x = 0; x < targetInfo.width; x += 2) {
      const idx = (y * targetInfo.width + x) * tch;
      let include = false;
      if (mask && maskInfo) include = mask[y * maskInfo.width + x] > 128;
      else include = Math.abs(x - tcx) < trX && Math.abs(y - tcy) < trY;
      if (!include) continue;
      const lab = rgbToLab(targetData[idx], targetData[idx + 1], targetData[idx + 2]);
      tHistL[binL(lab[0])]++;
      tHistA[binAB(lab[1])]++;
      tHistB[binAB(lab[2])]++;
    }
  }

  // Build detail histogram over non-transparent pixels.
  const dch = detailInfo.channels;
  for (let y = 0; y < detailInfo.height; y += 2) {
    for (let x = 0; x < detailInfo.width; x += 2) {
      const idx = (y * detailInfo.width + x) * dch;
      if (dch === 4 && detailData[idx + 3] < 128) continue;
      const lab = rgbToLab(detailData[idx], detailData[idx + 1], detailData[idx + 2]);
      dHistL[binL(lab[0])]++;
      dHistA[binAB(lab[1])]++;
      dHistB[binAB(lab[2])]++;
    }
  }

  // CDFs (normalized 0..1) for both.
  const cdf = (h: Uint32Array): Float32Array => {
    const out = new Float32Array(BINS);
    let total = 0;
    for (let i = 0; i < BINS; i++) total += h[i];
    if (total === 0) {
      // Identity ramp — degenerate empty histogram.
      for (let i = 0; i < BINS; i++) out[i] = i / (BINS - 1);
      return out;
    }
    let acc = 0;
    for (let i = 0; i < BINS; i++) {
      acc += h[i];
      out[i] = acc / total;
    }
    return out;
  };
  const tCdfL = cdf(tHistL), tCdfA = cdf(tHistA), tCdfB = cdf(tHistB);
  const dCdfL = cdf(dHistL), dCdfA = cdf(dHistA), dCdfB = cdf(dHistB);

  // Inverse-CDF lookup: for each detail-bin, walk target CDF until we hit the
  // same probability. Build a 256-entry remap table per channel.
  const buildLut = (dC: Float32Array, tC: Float32Array): Uint16Array => {
    const lut = new Uint16Array(BINS);
    let j = 0;
    for (let i = 0; i < BINS; i++) {
      const p = dC[i];
      while (j < BINS - 1 && tC[j] < p) j++;
      lut[i] = j;
    }
    return lut;
  };
  const lutL = buildLut(dCdfL, tCdfL);
  const lutA = buildLut(dCdfA, tCdfA);
  const lutB = buildLut(dCdfB, tCdfB);

  // Apply: for each detail pixel, LAB → bin → lut → unbin → RGB.
  const out = Buffer.alloc(detailData.length);
  for (let i = 0; i < detailData.length; i += dch) {
    if (dch === 4 && detailData[i + 3] < 128) {
      out[i] = detailData[i];
      out[i + 1] = detailData[i + 1];
      out[i + 2] = detailData[i + 2];
      out[i + 3] = detailData[i + 3];
      continue;
    }
    const lab = rgbToLab(detailData[i], detailData[i + 1], detailData[i + 2]);
    const newL = unbinL(lutL[binL(lab[0])]);
    const newA = unbinAB(lutA[binAB(lab[1])]);
    const newB = unbinAB(lutB[binAB(lab[2])]);
    const rgb = labToRgb(newL, newA, newB);
    out[i] = clamp255(rgb[0]);
    out[i + 1] = clamp255(rgb[1]);
    out[i + 2] = clamp255(rgb[2]);
    if (dch === 4) out[i + 3] = detailData[i + 3];
    else if (dch === 2) out[i + 1] = detailData[i + 1];
  }
  return out;
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
    throw new Error(`Eye ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (b64) return Buffer.from(b64, "base64");
  const url = data.data?.[0]?.url;
  if (url) {
    const dlRes = await fetch(url);
    return Buffer.from(await dlRes.arrayBuffer());
  }
  throw new Error("Eye returned no image");
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
    throw new Error(`Brush ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = await res.json();
  const url = data.images?.[0]?.url || data.image?.url;
  if (!url) throw new Error("Brush returned no image");
  const dlRes = await fetch(url);
  return Buffer.from(await dlRes.arrayBuffer());
}

// -----------------------------------------------------------------------------
// Lens fallback
// -----------------------------------------------------------------------------

async function callGrokEdit(args: { imageUrl: string; prompt: string }): Promise<string> {
  const res = await fetch("https://api.x.ai/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("XAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-imagine-image-pro",
      prompt: args.prompt,
      image: { url: args.imageUrl, type: "image_url" },
      n: 1,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Lens ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  const url = data.data?.[0]?.url;
  if (!url) throw new Error("Lens returned no image URL");
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

// =============================================================================
// Presets — CRUD endpoints over the `presets` table (migration 0044 + 0049).
//
// Three preset_types share the table:
//   - engine_config : engine + prompt template + tuned params bundle
//   - lut           : Hald-CLUT PNG reference (color grade)
//   - chain         : saved multi-stage chain definition
//
// All routes auth-gated upstream via checkAuth. Reads default to live
// (archived = false). Slug is the canonical lookup key for GET-by-id.
// Soft-delete via DELETE; physical deletion is intentionally not supported.
// =============================================================================

const VALID_PRESET_TYPES = new Set(["engine_config", "lut", "chain"]);

// Fields a caller may PATCH. is_system, slug, and preset_type are immutable
// post-creation by design (the slug is the URL key; preset_type changes the
// shape of every other column; is_system is provenance and shouldn't flip).
const PRESET_PATCH_ALLOWED = new Set([
  "name",
  "description",
  "engine",
  "config",
  "lut_asset_id",
  "lut_intensity_default",
  "lut_format",
  "sample_before_asset_id",
  "sample_after_asset_id",
  "source_provenance",
  "chain_definition",
  "tags",
  "category",
  "featured",
]);

async function handlePresetsList(url: URL): Promise<Response> {
  try {
    if (!SUPABASE_URL) {
      return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
    }

    const filters: string[] = [];
    const presetType = url.searchParams.get("preset_type");
    if (presetType) {
      if (!VALID_PRESET_TYPES.has(presetType)) {
        return Response.json(
          { error: "invalid preset_type", field: "preset_type" },
          { status: 400 }
        );
      }
      filters.push(`preset_type=eq.${encodeFilterValue(presetType)}`);
    }

    const category = url.searchParams.get("category");
    if (category) {
      filters.push(`category=eq.${encodeFilterValue(category)}`);
    }

    const featured = url.searchParams.get("featured");
    if (featured === "true") {
      filters.push("featured=eq.true");
    } else if (featured === "false") {
      filters.push("featured=eq.false");
    }

    // archived defaults to false (live only) unless explicitly set to true/all.
    const archivedParam = url.searchParams.get("archived");
    if (archivedParam === "true") {
      filters.push("archived=eq.true");
    } else if (archivedParam !== "all") {
      filters.push("archived=eq.false");
    }

    filters.push("order=created_at.desc");
    const qs = filters.join("&");

    const res = await fetch(`${SUPABASE_URL}/rest/v1/presets?${qs}`, {
      headers: supaHeaders(),
    });

    if (!res.ok) {
      const errText = await res.text();
      return Response.json(
        { error: "presets_list_failed", detail: errText },
        { status: 500 }
      );
    }

    const items = await res.json();
    return Response.json({
      items: Array.isArray(items) ? items : [],
      count: Array.isArray(items) ? items.length : 0,
    });
  } catch (err: any) {
    return Response.json(
      { error: "presets_list_error", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}

async function handlePresetsGetBySlug(slug: string): Promise<Response> {
  try {
    if (!slug) {
      return Response.json({ error: "slug required", field: "slug" }, { status: 400 });
    }
    if (!SUPABASE_URL) {
      return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
    }

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/presets?slug=eq.${encodeFilterValue(slug)}&limit=1`,
      { headers: supaHeaders() }
    );

    if (!res.ok) {
      const errText = await res.text();
      return Response.json(
        { error: "presets_get_failed", detail: errText },
        { status: 500 }
      );
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return Response.json({ error: "not_found", slug }, { status: 404 });
    }
    return Response.json(rows[0]);
  } catch (err: any) {
    return Response.json(
      { error: "presets_get_error", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}

async function handlePresetsCreate(req: Request): Promise<Response> {
  try {
    if (!SUPABASE_URL) {
      return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
    }

    const body: any = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid_json_body" }, { status: 400 });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    const presetType = typeof body.preset_type === "string" ? body.preset_type.trim() : "";

    if (!name) return Response.json({ error: "name required", field: "name" }, { status: 400 });
    if (!slug) return Response.json({ error: "slug required", field: "slug" }, { status: 400 });
    if (!presetType) {
      return Response.json(
        { error: "preset_type required", field: "preset_type" },
        { status: 400 }
      );
    }
    if (!VALID_PRESET_TYPES.has(presetType)) {
      return Response.json(
        {
          error: "preset_type must be one of: engine_config, lut, chain",
          field: "preset_type",
        },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    const row: Record<string, any> = {
      name,
      slug,
      preset_type: presetType,
      is_system: false,
      created_by: null,
      created_at: now,
      updated_at: now,
    };

    if (typeof body.description === "string") row.description = body.description;
    if (typeof body.engine === "string") row.engine = body.engine;
    if (body.config && typeof body.config === "object") row.config = body.config;
    if (typeof body.lut_asset_id === "string") row.lut_asset_id = body.lut_asset_id;
    if (typeof body.lut_format === "string") row.lut_format = body.lut_format;
    if (typeof body.lut_intensity_default === "number") {
      row.lut_intensity_default = body.lut_intensity_default;
    }
    if (typeof body.sample_before_asset_id === "string") {
      row.sample_before_asset_id = body.sample_before_asset_id;
    }
    if (typeof body.sample_after_asset_id === "string") {
      row.sample_after_asset_id = body.sample_after_asset_id;
    }
    if (body.source_provenance && typeof body.source_provenance === "object") {
      row.source_provenance = body.source_provenance;
    }
    if (body.chain_definition && typeof body.chain_definition === "object") {
      row.chain_definition = body.chain_definition;
    }
    if (Array.isArray(body.tags)) {
      row.tags = body.tags.filter((t: any) => typeof t === "string");
    }
    if (typeof body.category === "string") row.category = body.category;
    if (typeof body.featured === "boolean") row.featured = body.featured;

    const res = await fetch(`${SUPABASE_URL}/rest/v1/presets`, {
      method: "POST",
      headers: supaHeaders(),
      body: JSON.stringify(row),
    });

    if (res.status === 409) {
      return Response.json(
        { error: "slug_conflict", field: "slug", slug },
        { status: 409 }
      );
    }

    if (!res.ok) {
      const errText = await res.text();
      // PostgREST returns 23505 (unique_violation) on conflicting slugs even
      // without Prefer: resolution headers — surface that as 409 too.
      if (errText.includes("23505") || /duplicate key/i.test(errText)) {
        return Response.json(
          { error: "slug_conflict", field: "slug", slug },
          { status: 409 }
        );
      }
      return Response.json(
        { error: "presets_create_failed", detail: errText },
        { status: 500 }
      );
    }

    const created = await res.json();
    const out = Array.isArray(created) ? created[0] : created;
    return Response.json(out, { status: 201 });
  } catch (err: any) {
    return Response.json(
      { error: "presets_create_error", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}

async function handlePresetsPatch(req: Request, id: string): Promise<Response> {
  try {
    if (!id) {
      return Response.json({ error: "id required", field: "id" }, { status: 400 });
    }
    if (!SUPABASE_URL) {
      return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
    }

    const body: any = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid_json_body" }, { status: 400 });
    }

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    for (const [key, value] of Object.entries(body)) {
      if (PRESET_PATCH_ALLOWED.has(key)) {
        updates[key] = value;
      }
    }

    // Reject attempts to PATCH immutable columns explicitly so callers get a
    // clear error rather than a silent no-op.
    if (
      "is_system" in body ||
      "slug" in body ||
      "preset_type" in body ||
      "id" in body ||
      "created_at" in body ||
      "created_by" in body
    ) {
      return Response.json(
        {
          error: "immutable_field",
          detail: "is_system, slug, preset_type, id, created_at, created_by cannot be patched",
        },
        { status: 400 }
      );
    }

    if (Object.keys(updates).length <= 1) {
      return Response.json({ error: "no_mutable_fields_provided" }, { status: 400 });
    }

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/presets?id=eq.${encodeFilterValue(id)}`,
      {
        method: "PATCH",
        headers: supaHeaders(),
        body: JSON.stringify(updates),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      return Response.json(
        { error: "presets_patch_failed", detail: errText },
        { status: 500 }
      );
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return Response.json({ error: "not_found", id }, { status: 404 });
    }
    return Response.json(rows[0]);
  } catch (err: any) {
    return Response.json(
      { error: "presets_patch_error", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}

// =============================================================================
// /api/lut/extract — reverse-engineer Hald-CLUT from a before/after image pair
//
// Body: { before_url, after_url, name?, intensity?, sample_step? }
//   - before_url, after_url: image URLs (same scene, after has color grade applied)
//   - name: human-readable LUT name (default "Custom LUT") — used for slug
//   - intensity: reserved/forward-compat ('low'|'medium'|'high'), currently unused
//   - sample_step: pixel sampling stride (default 4 → ~1-in-16 pixels)
//
// Algorithm (V1 — nearest-cell + nearest-empty fill):
//   1. Fetch both images, decode to raw RGB via Sharp. Downscale to ≤1024 if
//      bigger and resize the larger to match the smaller (fit:cover).
//   2. Walk pixels with stride=sample_step. For each (before_rgb, after_rgb)
//      pair, snap before to its nearest cube cell (33-step quantize) and
//      accumulate the after color into that cell's running mean.
//   3. After the scan, divide accumulators by counts to compute mean per cell.
//   4. Empty cells (count == 0) are filled by BFS over the cube graph: each
//      empty cell adopts the mean color of its nearest filled cell (city-block
//      distance). Falls back to the identity color (cell coords) if no filled
//      cell is reachable — defensive only; with ≥1000 samples the cube fills
//      most regions and BFS always converges.
//   5. Encode the cube with encodeHaldClut() → 512×512 Hald-CLUT PNG.
//   6. Upload PNG to Supabase storage under `luts/`. Return public URL.
//   7. Generate a preview by applying the LUT (nearest-cell sample, no trilinear
//      yet — V1) back to the before image and uploading that too.
//
// Response: { ok, lut_url, preview_url, slug, sample_count, empty_cells }
// Errors: 400 (missing url), 422 (image decode/size mismatch failed), 500 (else).
// =============================================================================

async function handleLutExtract(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const beforeUrl = String(body.before_url || "");
    const afterUrl = String(body.after_url || "");
    const name = String(body.name || "Custom LUT").trim() || "Custom LUT";
    const sampleStepRaw = Number(body.sample_step ?? 4);
    const sampleStep = Number.isFinite(sampleStepRaw)
      ? Math.max(1, Math.min(32, Math.floor(sampleStepRaw)))
      : 4;
    // intensity reserved — accepted for forward compat, currently unused.
    const _intensity = String(body.intensity || "medium");

    if (!beforeUrl) {
      return Response.json({ error: "before_url required" }, { status: 400 });
    }
    if (!afterUrl) {
      return Response.json({ error: "after_url required" }, { status: 400 });
    }

    const sharp = (await import("sharp")).default;
    const { uploadToStorage, buildUploadPath } = await import("../supabase");

    // -------- Fetch both images --------
    let beforeBuf: Buffer;
    let afterBuf: Buffer;
    try {
      const [bRes, aRes] = await Promise.all([fetch(beforeUrl), fetch(afterUrl)]);
      if (!bRes.ok) throw new Error(`before fetch ${bRes.status}`);
      if (!aRes.ok) throw new Error(`after fetch ${aRes.status}`);
      beforeBuf = Buffer.from(await bRes.arrayBuffer());
      afterBuf = Buffer.from(await aRes.arrayBuffer());
    } catch (err: any) {
      return Response.json(
        { error: `image fetch failed: ${err?.message || err}` },
        { status: 422 }
      );
    }

    // -------- Decode to common-size raw RGB --------
    const MAX_DIM = 1024;
    let beforeRaw: { data: Buffer; w: number; h: number };
    let afterRaw: { data: Buffer; w: number; h: number };
    try {
      const bMeta = await sharp(beforeBuf).metadata();
      const aMeta = await sharp(afterBuf).metadata();
      const targetW = Math.min(
        MAX_DIM,
        Math.min(bMeta.width || MAX_DIM, aMeta.width || MAX_DIM)
      );
      const targetH = Math.min(
        MAX_DIM,
        Math.min(bMeta.height || MAX_DIM, aMeta.height || MAX_DIM)
      );

      const bOut = await sharp(beforeBuf)
        .resize(targetW, targetH, { fit: "cover", position: "center" })
        .removeAlpha()
        .toColorspace("srgb")
        .raw()
        .toBuffer({ resolveWithObject: true });
      const aOut = await sharp(afterBuf)
        .resize(targetW, targetH, { fit: "cover", position: "center" })
        .removeAlpha()
        .toColorspace("srgb")
        .raw()
        .toBuffer({ resolveWithObject: true });

      beforeRaw = { data: bOut.data, w: bOut.info.width, h: bOut.info.height };
      afterRaw = { data: aOut.data, w: aOut.info.width, h: aOut.info.height };

      if (beforeRaw.w !== afterRaw.w || beforeRaw.h !== afterRaw.h) {
        return Response.json(
          { error: "before/after dimensions differ after normalize" },
          { status: 422 }
        );
      }
      if (
        bOut.info.channels !== 3 ||
        aOut.info.channels !== 3
      ) {
        return Response.json(
          { error: `expected 3-channel RGB, got ${bOut.info.channels}/${aOut.info.channels}` },
          { status: 422 }
        );
      }
    } catch (err: any) {
      return Response.json(
        { error: `image decode failed: ${err?.message || err}` },
        { status: 422 }
      );
    }

    // -------- Build accumulator grid --------
    // 35937 cells × (sumR, sumG, sumB) as Float64; counts as Int32.
    const sumR = new Float64Array(CUBE_LEN);
    const sumG = new Float64Array(CUBE_LEN);
    const sumB = new Float64Array(CUBE_LEN);
    const counts = new Int32Array(CUBE_LEN);
    const W = beforeRaw.w;
    const H = beforeRaw.h;
    const totalPixels = W * H;
    const stride = sampleStep;

    let sampleCount = 0;
    for (let y = 0; y < H; y += stride) {
      for (let x = 0; x < W; x += stride) {
        const idx = (y * W + x) * 3;
        const br = beforeRaw.data[idx + 0];
        const bg = beforeRaw.data[idx + 1];
        const bb = beforeRaw.data[idx + 2];
        const ar = afterRaw.data[idx + 0];
        const ag = afterRaw.data[idx + 1];
        const ab = afterRaw.data[idx + 2];

        // Snap before-pixel to its nearest cube cell.
        const cr = Math.round((br / 255) * (LUT_SIZE - 1));
        const cg = Math.round((bg / 255) * (LUT_SIZE - 1));
        const cb = Math.round((bb / 255) * (LUT_SIZE - 1));
        // Cell index uses B-outer/G-mid/R-inner to match encodeHaldClut.
        const cellIdx = (cb * LUT_SIZE + cg) * LUT_SIZE + cr;

        sumR[cellIdx] += ar;
        sumG[cellIdx] += ag;
        sumB[cellIdx] += ab;
        counts[cellIdx]++;
        sampleCount++;
      }
    }

    if (sampleCount < 1000) {
      return Response.json(
        {
          error: `insufficient samples: ${sampleCount} < 1000 (image too small or sample_step too large)`,
          total_pixels: totalPixels,
          sample_step: stride,
        },
        { status: 422 }
      );
    }

    // -------- Resolve mean color per cell, mark empties --------
    const meanR = new Float32Array(CUBE_LEN);
    const meanG = new Float32Array(CUBE_LEN);
    const meanB = new Float32Array(CUBE_LEN);
    const filled = new Uint8Array(CUBE_LEN);
    let emptyCells = 0;
    for (let i = 0; i < CUBE_LEN; i++) {
      const c = counts[i];
      if (c > 0) {
        meanR[i] = sumR[i] / c / 255;
        meanG[i] = sumG[i] / c / 255;
        meanB[i] = sumB[i] / c / 255;
        filled[i] = 1;
      } else {
        emptyCells++;
      }
    }

    // -------- Fill empty cells via BFS over cube graph (nearest filled) --------
    // Multi-source BFS: enqueue every filled cell, propagate its color to
    // unfilled neighbors. Each unfilled cell adopts the color of the first
    // filled cell that reaches it (city-block distance tiebreaker).
    if (emptyCells > 0) {
      const queue: number[] = new Array(CUBE_LEN);
      let qHead = 0;
      let qTail = 0;
      for (let i = 0; i < CUBE_LEN; i++) {
        if (filled[i]) queue[qTail++] = i;
      }
      while (qHead < qTail) {
        const idx = queue[qHead++];
        // Decode (r,g,b) coordinates from idx (B-outer/G-mid/R-inner).
        const r = idx % LUT_SIZE;
        const g = Math.floor(idx / LUT_SIZE) % LUT_SIZE;
        const b = Math.floor(idx / (LUT_SIZE * LUT_SIZE));
        const colorR = meanR[idx];
        const colorG = meanG[idx];
        const colorB = meanB[idx];

        // 6-neighborhood: ±1 in each of r, g, b axes.
        const neighbors: Array<[number, number, number]> = [
          [r - 1, g, b],
          [r + 1, g, b],
          [r, g - 1, b],
          [r, g + 1, b],
          [r, g, b - 1],
          [r, g, b + 1],
        ];
        for (const [nr, ng, nb] of neighbors) {
          if (
            nr < 0 || nr >= LUT_SIZE ||
            ng < 0 || ng >= LUT_SIZE ||
            nb < 0 || nb >= LUT_SIZE
          ) continue;
          const nIdx = (nb * LUT_SIZE + ng) * LUT_SIZE + nr;
          if (filled[nIdx]) continue;
          meanR[nIdx] = colorR;
          meanG[nIdx] = colorG;
          meanB[nIdx] = colorB;
          filled[nIdx] = 1;
          queue[qTail++] = nIdx;
        }
      }
    }

    // -------- Build cube as Float32Array (length CUBE_FLOATS) --------
    const cube = new Float32Array(CUBE_FLOATS);
    for (let i = 0; i < CUBE_LEN; i++) {
      const off = i * 3;
      // Defensive: any cell still unfilled (shouldn't happen — BFS reaches
      // every cell so long as ≥1 cell is filled, and we already required ≥1000
      // samples) gets the identity color from its (r,g,b) coordinates.
      if (filled[i]) {
        cube[off + 0] = clampUnit(meanR[i]);
        cube[off + 1] = clampUnit(meanG[i]);
        cube[off + 2] = clampUnit(meanB[i]);
      } else {
        const r = i % LUT_SIZE;
        const g = Math.floor(i / LUT_SIZE) % LUT_SIZE;
        const b = Math.floor(i / (LUT_SIZE * LUT_SIZE));
        cube[off + 0] = r / (LUT_SIZE - 1);
        cube[off + 1] = g / (LUT_SIZE - 1);
        cube[off + 2] = b / (LUT_SIZE - 1);
      }
    }

    // -------- Encode + upload --------
    const lutPng = await encodeHaldClut(cube);
    const slug = `${toStorageSlug(name)}-${Date.now().toString(36)}-${Math.random()
      .toString(16)
      .slice(2, 8)}`;
    const lutPath = buildUploadPath("luts", `${slug}.png`, "image/png");
    const lutUrl = await uploadToStorage(
      lutPath,
      lutPng.buffer.slice(lutPng.byteOffset, lutPng.byteOffset + lutPng.byteLength),
      "image/png"
    );

    // -------- Build sample preview: apply LUT to before image --------
    let previewUrl = lutUrl;
    try {
      // Sanity-check round-trip via decodeHaldClut, then apply nearest-cell
      // lookup to the before image (V1: no trilinear interp — fast and good
      // enough for a sanity preview).
      const decoded = await decodeHaldClut(lutPng);
      const previewPng = await applyLutNearest(beforeRaw, decoded, sharp);
      const previewPath = buildUploadPath(
        "luts",
        `${slug}-preview.png`,
        "image/png"
      );
      previewUrl = await uploadToStorage(
        previewPath,
        previewPng.buffer.slice(
          previewPng.byteOffset,
          previewPng.byteOffset + previewPng.byteLength
        ),
        "image/png"
      );
    } catch (err: any) {
      // Preview is best-effort. If it fails, return lut_url for both.
      console.error("[lut/extract] preview generation failed:", err?.message || err);
    }

    return Response.json({
      ok: true,
      lut_url: lutUrl,
      preview_url: previewUrl,
      slug,
      sample_count: sampleCount,
      empty_cells: emptyCells,
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message || "lut extract failed" },
      { status: 500 }
    );
  }
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

// Apply a decoded Hald-CLUT cube to a raw RGB image using nearest-cell sampling.
// Output is encoded as a PNG via Sharp.
async function applyLutNearest(
  src: { data: Buffer; w: number; h: number },
  cube: Float32Array,
  sharp: any,
): Promise<Buffer> {
  const { data, w, h } = src;
  const out = Buffer.alloc(w * h * 3);
  const STEP = LUT_SIZE - 1;
  for (let i = 0; i < w * h; i++) {
    const off = i * 3;
    const r = data[off + 0];
    const g = data[off + 1];
    const b = data[off + 2];
    const cr = Math.round((r / 255) * STEP);
    const cg = Math.round((g / 255) * STEP);
    const cb = Math.round((b / 255) * STEP);
    const cellIdx = (cb * LUT_SIZE + cg) * LUT_SIZE + cr;
    const co = cellIdx * 3;
    out[off + 0] = Math.round(cube[co + 0] * 255);
    out[off + 1] = Math.round(cube[co + 1] * 255);
    out[off + 2] = Math.round(cube[co + 2] * 255);
  }
  return await sharp(out, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}

// =============================================================================
// /api/lut/apply — apply a Hald-CLUT PNG to a target image
//
// Body: { image_url, lut_url, intensity?, output_size? }
//   - image_url: target image to grade
//   - lut_url:   public URL of a 512x512 Hald-CLUT PNG (e.g., emitted by
//                /api/lut/extract or any standard 33x33x33 cube renderer)
//   - intensity: 0..1, default 1.0 — blend strength (1.0 = full LUT, 0.0 = original)
//   - output_size: optional max-dim cap; default = source dimensions, no scale
//
// Algorithm: per-pixel trilinear interpolation across the 8 surrounding cube
// cells. Cell index uses the same B-outer/G-mid/R-inner convention as
// encodeHaldClut/decodeHaldClut in src/server/lut.ts. Alpha (if present) is
// passed through untouched.
//
// Response: { ok, url, applied_lut, intensity, duration_ms }
// Errors: 400 (missing url), 422 (fetch/decode failure), 500 (encode/upload).
// =============================================================================

// applyIntensityCurve — re-shapes the 0..1 blend factor used by handleLutApply
// so callers can dial the perceived "feel" of an intensity slider:
//   - 'linear'    (default): pass-through, t maps 1:1
//   - 's-curve'   smoothstep — slower at extremes, faster through the middle
//   - 'cinematic' skewed for "punch" at low intensities (fast lift early)
// Pure function, no side effects, safe to call inside hot pixel loops once
// per request (effectiveAlpha is computed once before the loop).
function applyIntensityCurve(
  t: number,
  curve: "linear" | "s-curve" | "cinematic" = "linear"
): number {
  if (curve === "s-curve") return t * t * (3 - 2 * t);
  if (curve === "cinematic") return 1 - Math.pow(1 - t, 1.6);
  return t; // linear
}

// =============================================================================
// CURATED_LUT_REFS — registry of curated Hald-CLUT URLs per Darkroom preset.
// Initially null-populated. After running /api/lut/extract on a Glow (or other
// preset) before/after pair, the operator manually pastes the resulting URL
// into the entry so /api/preset/:slug?with_lut=true can blend the LUT-mapped
// version on top of the engine result for snappier, server-side recall.
//
// NOTE: every value is null until a real LUT URL is harvested. getCuratedLut-
// ForPreset() returns null for missing entries, which is the no-op fallback.
// =============================================================================

const CURATED_LUT_REFS: Record<string, string | null> = {
  "darkroom-dawn": null,
  "darkroom-glow": null,
  "darkroom-lace": null,
  "darkroom-noir": null,
  "darkroom-polaroid": null,
  "darkroom-studio": null,
  "darkroom-sunkissed": null,
  "darkroom-thirty-five-mm": null,
  "darkroom-velvet": null,
  "darkroom-wet-look": null,
};

function getCuratedLutForPreset(slug: string): string | null {
  return CURATED_LUT_REFS[slug] ?? null;
}

// =============================================================================
// applyLutToImage — reusable core for /api/lut/apply and the preset's optional
// with_lut blend path. Fetches the target image + LUT PNG, decodes the
// Hald-CLUT into a 33³ Float32 cube, and writes a per-pixel trilinearly-
// interpolated PNG into Supabase storage. Returns a structured result with
// either a URL+effective_alpha (success) or an error message + http status
// hint (failure) — the caller decides how to surface the error.
// =============================================================================

type ApplyLutResult =
  | {
      ok: true;
      url: string;
      effective_alpha: number;
    }
  | {
      ok: false;
      error: string;
      status: number;
    };

async function applyLutToImage(args: {
  imageUrl: string;
  lutUrl: string;
  intensity?: number;
  curve?: "linear" | "s-curve" | "cinematic";
  outputSize?: number;
}): Promise<ApplyLutResult> {
  const intensity = Number.isFinite(args.intensity)
    ? Math.max(0, Math.min(1, args.intensity as number))
    : 1;
  const curve = args.curve || "linear";
  const effectiveAlpha = applyIntensityCurve(intensity, curve);
  const outputSize =
    Number.isFinite(args.outputSize) && (args.outputSize as number) > 0
      ? Math.floor(args.outputSize as number)
      : 0;

  if (!args.imageUrl) return { ok: false, error: "image_url required", status: 400 };
  if (!args.lutUrl) return { ok: false, error: "lut_url required", status: 400 };

  const sharp = (await import("sharp")).default;
  const { uploadToStorage, buildUploadPath } = await import("../supabase");

  let imgBuf: Buffer;
  let lutBuf: Buffer;
  try {
    const [iRes, lRes] = await Promise.all([fetch(args.imageUrl), fetch(args.lutUrl)]);
    if (!iRes.ok) throw new Error(`image fetch ${iRes.status}`);
    if (!lRes.ok) throw new Error(`lut fetch ${lRes.status}`);
    imgBuf = Buffer.from(await iRes.arrayBuffer());
    lutBuf = Buffer.from(await lRes.arrayBuffer());
  } catch (err: any) {
    return { ok: false, error: `fetch failed: ${err?.message || err}`, status: 422 };
  }

  let cube: Float32Array;
  try {
    cube = await decodeHaldClut(lutBuf);
  } catch (err: any) {
    return { ok: false, error: `lut decode failed: ${err?.message || err}`, status: 422 };
  }
  if (cube.length !== CUBE_FLOATS) {
    return {
      ok: false,
      error: `lut cube size mismatch: expected ${CUBE_FLOATS} floats, got ${cube.length}`,
      status: 422,
    };
  }

  let srcData: Buffer;
  let width: number;
  let height: number;
  let channels: number;
  try {
    let pipeline = sharp(imgBuf).toColorspace("srgb");
    if (outputSize > 0) {
      const meta = await sharp(imgBuf).metadata();
      const srcMax = Math.max(meta.width || 0, meta.height || 0);
      if (srcMax > outputSize) {
        pipeline = pipeline.resize(outputSize, outputSize, {
          fit: "inside",
          withoutEnlargement: true,
        });
      }
    }
    const out = await pipeline.raw().toBuffer({ resolveWithObject: true });
    srcData = out.data;
    width = out.info.width;
    height = out.info.height;
    channels = out.info.channels;
    if (channels !== 3 && channels !== 4) {
      return {
        ok: false,
        error: `unsupported channel count ${channels}; expected 3 or 4`,
        status: 422,
      };
    }
  } catch (err: any) {
    return { ok: false, error: `image decode failed: ${err?.message || err}`, status: 422 };
  }

  const STEP = LUT_SIZE - 1;
  const SIZE = LUT_SIZE;
  const SS = SIZE * SIZE;
  const out = Buffer.alloc(srcData.length);
  const inv255 = 1 / 255;
  const blendLut = effectiveAlpha;
  const blendSrc = 1 - effectiveAlpha;
  const numPixels = width * height;

  for (let p = 0; p < numPixels; p++) {
    const i = p * channels;
    const sr = srcData[i] * inv255;
    const sg = srcData[i + 1] * inv255;
    const sb = srcData[i + 2] * inv255;

    const fr = sr * STEP;
    const fg = sg * STEP;
    const fb = sb * STEP;

    let r0 = Math.floor(fr); if (r0 < 0) r0 = 0; else if (r0 > STEP) r0 = STEP;
    let g0 = Math.floor(fg); if (g0 < 0) g0 = 0; else if (g0 > STEP) g0 = STEP;
    let b0 = Math.floor(fb); if (b0 < 0) b0 = 0; else if (b0 > STEP) b0 = STEP;
    const r1 = r0 < STEP ? r0 + 1 : STEP;
    const g1 = g0 < STEP ? g0 + 1 : STEP;
    const b1 = b0 < STEP ? b0 + 1 : STEP;

    const dr = fr - r0;
    const dg = fg - g0;
    const db = fb - b0;
    const idr = 1 - dr;
    const idg = 1 - dg;
    const idb = 1 - db;

    const o000 = (b0 * SS + g0 * SIZE + r0) * 3;
    const o100 = (b0 * SS + g0 * SIZE + r1) * 3;
    const o010 = (b0 * SS + g1 * SIZE + r0) * 3;
    const o110 = (b0 * SS + g1 * SIZE + r1) * 3;
    const o001 = (b1 * SS + g0 * SIZE + r0) * 3;
    const o101 = (b1 * SS + g0 * SIZE + r1) * 3;
    const o011 = (b1 * SS + g1 * SIZE + r0) * 3;
    const o111 = (b1 * SS + g1 * SIZE + r1) * 3;

    const w000 = idr * idg * idb;
    const w100 = dr  * idg * idb;
    const w010 = idr * dg  * idb;
    const w110 = dr  * dg  * idb;
    const w001 = idr * idg * db;
    const w101 = dr  * idg * db;
    const w011 = idr * dg  * db;
    const w111 = dr  * dg  * db;

    const lr =
      cube[o000]     * w000 + cube[o100]     * w100 +
      cube[o010]     * w010 + cube[o110]     * w110 +
      cube[o001]     * w001 + cube[o101]     * w101 +
      cube[o011]     * w011 + cube[o111]     * w111;
    const lg =
      cube[o000 + 1] * w000 + cube[o100 + 1] * w100 +
      cube[o010 + 1] * w010 + cube[o110 + 1] * w110 +
      cube[o001 + 1] * w001 + cube[o101 + 1] * w101 +
      cube[o011 + 1] * w011 + cube[o111 + 1] * w111;
    const lb =
      cube[o000 + 2] * w000 + cube[o100 + 2] * w100 +
      cube[o010 + 2] * w010 + cube[o110 + 2] * w110 +
      cube[o001 + 2] * w001 + cube[o101 + 2] * w101 +
      cube[o011 + 2] * w011 + cube[o111 + 2] * w111;

    let or = (sr * blendSrc + lr * blendLut) * 255;
    let og = (sg * blendSrc + lg * blendLut) * 255;
    let ob = (sb * blendSrc + lb * blendLut) * 255;
    if (or < 0) or = 0; else if (or > 255) or = 255;
    if (og < 0) og = 0; else if (og > 255) og = 255;
    if (ob < 0) ob = 0; else if (ob > 255) ob = 255;
    out[i]     = Math.round(or);
    out[i + 1] = Math.round(og);
    out[i + 2] = Math.round(ob);
    if (channels === 4) out[i + 3] = srcData[i + 3];
  }

  let outPng: Buffer;
  try {
    outPng = await sharp(out, {
      raw: { width, height, channels: channels as 3 | 4 },
    })
      .png()
      .toBuffer();
  } catch (err: any) {
    return { ok: false, error: `image encode failed: ${err?.message || err}`, status: 500 };
  }

  let resultUrl: string;
  try {
    const filename = `apply-${Date.now().toString(36)}-${Math.random()
      .toString(16)
      .slice(2, 8)}.png`;
    const path = buildUploadPath("luts-applied", filename, "image/png");
    resultUrl = await uploadToStorage(
      path,
      outPng.buffer.slice(outPng.byteOffset, outPng.byteOffset + outPng.byteLength),
      "image/png"
    );
  } catch (err: any) {
    return { ok: false, error: `upload failed: ${err?.message || err}`, status: 500 };
  }

  return { ok: true, url: resultUrl, effective_alpha: effectiveAlpha };
}

async function handleLutApply(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const imageUrl = String(body.image_url || "");
    const lutUrl = String(body.lut_url || "");
    const rawIntensity = body.intensity === undefined ? 1 : Number(body.intensity);
    const intensity = Number.isFinite(rawIntensity)
      ? Math.max(0, Math.min(1, rawIntensity))
      : 1;
    const rawOutputSize = body.output_size === undefined ? 0 : Number(body.output_size);
    const outputSize = Number.isFinite(rawOutputSize) && rawOutputSize > 0
      ? Math.floor(rawOutputSize)
      : 0;
    // Curve re-shapes how `intensity` blends into the per-pixel mix. Default
    // 'linear' preserves prior behavior exactly.
    const ALLOWED_CURVES = ["linear", "s-curve", "cinematic"] as const;
    type IntensityCurve = (typeof ALLOWED_CURVES)[number];
    const rawCurve = body.curve === undefined ? "linear" : String(body.curve);
    if (!ALLOWED_CURVES.includes(rawCurve as IntensityCurve)) {
      return Response.json(
        {
          error: `invalid curve '${rawCurve}'; expected one of: ${ALLOWED_CURVES.join(", ")}`,
        },
        { status: 400 }
      );
    }
    const curve: IntensityCurve = rawCurve as IntensityCurve;

    const result = await applyLutToImage({
      imageUrl,
      lutUrl,
      intensity,
      curve,
      outputSize,
    });

    if (!result.ok) {
      return Response.json({ error: result.error }, { status: result.status });
    }

    return Response.json({
      ok: true,
      url: result.url,
      applied_lut: lutUrl,
      intensity,
      curve,
      effective_alpha: result.effective_alpha,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message || "lut apply failed" },
      { status: 500 }
    );
  }
}

// /api/lut/export — fetch a Hald-CLUT PNG by URL, decode it, and serialize it
// to a portable .cube (Adobe / DaVinci Resolve) or .xmp (Lightroom Profile)
// file. Returns the file body inline with a Content-Disposition header so the
// browser downloads it.
//
// Query params:
//   format   "cube" | "xmp" (default "cube")
//   lut_url  required — URL to the Hald-CLUT PNG (e.g., from /api/lut/extract)
//   title    optional — profile/LUT name; default "Darkroom Custom"
//
// Errors:
//   400 — bad format / missing lut_url
//   422 — lut_url fetch failed / decode failed
//   500 — unexpected
async function handleLutExport(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const format = (url.searchParams.get("format") || "cube").toLowerCase();
  const lutUrl = url.searchParams.get("lut_url");
  const title = url.searchParams.get("title") || "Darkroom Custom";

  if (format !== "cube" && format !== "xmp") {
    return Response.json(
      { error: "format must be cube or xmp" },
      { status: 400 }
    );
  }
  if (!lutUrl) {
    return Response.json({ error: "lut_url required" }, { status: 400 });
  }

  let png: Buffer;
  try {
    const resp = await fetch(lutUrl);
    if (!resp.ok) {
      return Response.json(
        { error: `lut_url fetch ${resp.status}` },
        { status: 422 }
      );
    }
    png = Buffer.from(await resp.arrayBuffer());
  } catch (err: any) {
    return Response.json(
      { error: `lut_url fetch failed: ${err?.message || err}` },
      { status: 422 }
    );
  }

  let cube: Float32Array;
  try {
    cube = await decodeHaldClut(png);
  } catch (err: any) {
    return Response.json(
      { error: `lut decode failed: ${err?.message || err}` },
      { status: 422 }
    );
  }

  let body: string;
  let contentType: string;
  let ext: string;
  try {
    if (format === "cube") {
      body = cubeToText(cube, title);
      contentType = "text/plain; charset=utf-8";
      ext = "cube";
    } else {
      body = cubeToXmp(cube, title);
      contentType = "application/xml; charset=utf-8";
      ext = "xmp";
    }
  } catch (err: any) {
    return Response.json(
      { error: err?.message || "lut export failed" },
      { status: 500 }
    );
  }

  const safeTitle =
    (title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "darkroom-lut");

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${safeTitle}.${ext}"`,
      "cache-control": "no-store",
    },
  });
}

async function handlePresetsSoftDelete(id: string): Promise<Response> {
  try {
    if (!id) {
      return Response.json({ error: "id required", field: "id" }, { status: 400 });
    }
    if (!SUPABASE_URL) {
      return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
    }

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/presets?id=eq.${encodeFilterValue(id)}`,
      {
        method: "PATCH",
        headers: supaHeaders(),
        body: JSON.stringify({
          archived: true,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      return Response.json(
        { error: "presets_delete_failed", detail: errText },
        { status: 500 }
      );
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return Response.json({ error: "not_found", id }, { status: 404 });
    }
    return Response.json({ ok: true, id });
  } catch (err: any) {
    return Response.json(
      { error: "presets_delete_error", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}

// =============================================================================
// Wardrobe — list / create endpoints over the `wardrobe` table (migration 0043).
//
// Each wardrobe row references an `assets` row via asset_id (FK CASCADE). The
// list endpoint joins back so the client gets source_url / storage_path / dims
// in a single request — the wardrobe grid renders thumbnails from those URLs.
//
// Two-step join (wardrobe rows → unique asset_ids → assets) over PostgREST
// embed because the embedded form requires an explicit FK relationship to be
// declared in the Postgres schema. The two-step version is robust against any
// schema-cache state and degrades gracefully when an asset row has been hard
// deleted (wardrobe row still surfaces, asset field is null).
//
// All routes auth-gated upstream via checkAuth. Reads default to live
// (archived = false) unless ?archived=true|all is set.
// =============================================================================

const WARDROBE_VALID_CATEGORIES = new Set([
  "top",
  "bottom",
  "dress",
  "lingerie",
  "outerwear",
  "swimwear",
  "accessory",
  "footwear",
  "hosiery",
]);

// Angle keys allowed in attributes.angles. 'front' is the canonical view that
// also lives on wardrobe.asset_id. Other entries point at sibling URLs that
// the UI can swap into the garment-ref slot.
const WARDROBE_VALID_ANGLES = new Set([
  "front",
  "back",
  "side",
  "side_left",
  "side_right",
  "detail",
  "three_quarter",
]);

async function handleWardrobeList(url: URL): Promise<Response> {
  try {
    if (!SUPABASE_URL) {
      return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
    }

    const filters: string[] = [];

    const category = url.searchParams.get("category");
    if (category) {
      filters.push(`category=eq.${encodeFilterValue(category)}`);
    }

    const subcategory = url.searchParams.get("subcategory");
    if (subcategory) {
      filters.push(`subcategory=eq.${encodeFilterValue(subcategory)}`);
    }

    const featured = url.searchParams.get("featured");
    if (featured === "true") {
      filters.push("featured=eq.true");
    } else if (featured === "false") {
      filters.push("featured=eq.false");
    }

    // archived defaults to false (live only) unless explicitly set to true/all.
    const archivedParam = url.searchParams.get("archived");
    if (archivedParam === "true") {
      filters.push("archived=eq.true");
    } else if (archivedParam !== "all") {
      filters.push("archived=eq.false");
    }

    filters.push("order=created_at.desc");

    // Cap return size — wardrobe grid is meant to be browsed, not paginated to
    // infinity. Callers can paginate by passing ?offset and ?limit.
    const limitRaw = Number(url.searchParams.get("limit") ?? 200);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(500, Math.floor(limitRaw)))
      : 200;
    filters.push(`limit=${limit}`);
    const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
    if (offset > 0) filters.push(`offset=${offset}`);

    const qs = filters.join("&");

    const res = await fetch(`${SUPABASE_URL}/rest/v1/wardrobe?${qs}`, {
      headers: supaHeaders(),
    });

    if (!res.ok) {
      const errText = await res.text();
      return Response.json(
        { error: "wardrobe_list_failed", detail: errText },
        { status: 500 }
      );
    }

    const items: any[] = await res.json();
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ items: [], count: 0 });
    }

    // Two-step join: collect unique asset_ids, fetch them in one batched call,
    // then merge each asset onto its parent wardrobe row.
    const assetIds = Array.from(
      new Set(items.map((it) => it?.asset_id).filter((v) => typeof v === "string" && v))
    );

    let assetsById: Record<string, any> = {};
    if (assetIds.length > 0) {
      const inList = assetIds.map((id) => encodeFilterValue(id)).join(",");
      const assetsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/assets?id=in.(${inList})&select=id,source_url,storage_path,mime_type,width,height`,
        { headers: supaHeaders() }
      );
      if (assetsRes.ok) {
        const rows: any[] = await assetsRes.json();
        if (Array.isArray(rows)) {
          for (const row of rows) {
            if (row?.id) assetsById[row.id] = row;
          }
        }
      }
      // If assets fetch fails we still return wardrobe rows — clients render a
      // placeholder when asset is null. Failure to enrich != failure of list.
    }

    const enriched = items.map((it) => ({
      ...it,
      asset: it?.asset_id ? assetsById[it.asset_id] || null : null,
    }));

    return Response.json({ items: enriched, count: enriched.length });
  } catch (err: any) {
    return Response.json(
      { error: "wardrobe_list_error", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}

async function handleWardrobeCreate(req: Request): Promise<Response> {
  try {
    if (!SUPABASE_URL) {
      return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
    }

    const body: any = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid_json_body" }, { status: 400 });
    }

    const assetId = typeof body.asset_id === "string" ? body.asset_id.trim() : "";
    const category = typeof body.category === "string" ? body.category.trim() : "";

    if (!assetId) {
      return Response.json({ error: "asset_id required", field: "asset_id" }, { status: 400 });
    }
    if (!category) {
      return Response.json({ error: "category required", field: "category" }, { status: 400 });
    }
    // Soft validation only — the schema stores category as free text on
    // purpose so new categories don't need a migration. We warn on unknowns
    // by rejecting only the obviously empty/whitespace case above.
    // (If you want to enforce, uncomment the guard below.)
    // if (!WARDROBE_VALID_CATEGORIES.has(category)) {
    //   return Response.json({ error: "unknown category", field: "category" }, { status: 400 });
    // }

    const now = new Date().toISOString();
    const row: Record<string, any> = {
      asset_id: assetId,
      category,
      created_at: now,
      updated_at: now,
    };

    if (typeof body.subcategory === "string" && body.subcategory.trim()) {
      row.subcategory = body.subcategory.trim();
    }
    if (typeof body.name === "string" && body.name.trim()) {
      row.name = body.name.trim();
    }
    if (Array.isArray(body.tags)) {
      row.tags = body.tags.filter((t: any) => typeof t === "string");
    }
    if (body.attributes && typeof body.attributes === "object" && !Array.isArray(body.attributes)) {
      row.attributes = body.attributes;
    }
    if (typeof body.featured === "boolean") row.featured = body.featured;

    const res = await fetch(`${SUPABASE_URL}/rest/v1/wardrobe`, {
      method: "POST",
      headers: supaHeaders(),
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const errText = await res.text();
      // FK violation on asset_id → 422 (the asset row doesn't exist).
      if (errText.includes("23503") || /violates foreign key/i.test(errText)) {
        return Response.json(
          { error: "asset_not_found", field: "asset_id", asset_id: assetId, detail: errText },
          { status: 422 }
        );
      }
      return Response.json(
        { error: "wardrobe_create_failed", detail: errText },
        { status: 500 }
      );
    }

    const created = await res.json();
    const out = Array.isArray(created) ? created[0] : created;
    return Response.json(out, { status: 201 });
  } catch (err: any) {
    return Response.json(
      { error: "wardrobe_create_error", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}

// =============================================================================
// Wardrobe Forge — POST /api/wardrobe/forge
//
// Single endpoint that ties bg-strip + asset insert + wardrobe insert into one
// call so the UI doesn't need to chain four requests. Three modes:
//
//   mode='upload'      — caller already pushed bytes via POST /api/uploads and
//                        gives us the resulting public URL. We optionally
//                        bg-strip (FAL BiRefNet via the same path /api/remove-bg
//                        uses), persist as an `assets` row (asset_type='curated'),
//                        and link it from a fresh `wardrobe` row.
//
//   mode='from_image'  — caller picks an existing image (e.g. a version-stack
//                        URL) and optionally a crop region. We crop with sharp,
//                        re-upload, bg-strip the result, then continue exactly
//                        like 'upload'.
//
//   mode='generate'    — DEFERRED. Returns 501. Generating a transparent
//                        garment from a prompt requires a tuned t2i + post-
//                        process chain that v1 does not ship. The client UI
//                        does not expose this mode either; the handler stub
//                        exists for forward-compat only.
//
// Response (success): { ok: true, wardrobe, asset, preview_url }
// Errors return JSON { error, detail? } with appropriate status.
// =============================================================================

const FORGE_VALID_CATEGORIES = WARDROBE_VALID_CATEGORIES;

async function handleWardrobeForge(req: Request): Promise<Response> {
  try {
    if (!SUPABASE_URL) {
      return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
    }

    const { uploadToStorage, buildUploadPath } = await import("../supabase");

    const body: any = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid_json_body" }, { status: 400 });
    }

    const mode = String(body.mode || "").trim();
    if (!mode) {
      return Response.json({ error: "mode required", field: "mode" }, { status: 400 });
    }

    // 'generate' is intentionally not implemented in v1 — see header comment.
    if (mode === "generate") {
      return Response.json(
        {
          error: "generate mode is a future feature; use upload or from_image",
          mode,
        },
        { status: 501 }
      );
    }

    if (mode !== "upload" && mode !== "from_image") {
      return Response.json(
        { error: `unknown mode '${mode}' — valid: upload | from_image | generate`, field: "mode" },
        { status: 400 }
      );
    }

    // Multi-angle support: caller may declare which view this forge call
    // produces. 'front' (default) keeps the legacy behavior — create a new
    // wardrobe row. Any non-front angle requires `wardrobe_id` and instead
    // appends the resulting URL into attributes.angles[angle] on that row.
    // See darkroom.wardrobe.multi-angle.
    const angle = typeof body.angle === "string" && body.angle.trim()
      ? body.angle.trim().toLowerCase()
      : "front";
    if (!WARDROBE_VALID_ANGLES.has(angle)) {
      return Response.json(
        {
          error: `invalid angle '${angle}' — valid: ${[...WARDROBE_VALID_ANGLES].join(" | ")}`,
          field: "angle",
        },
        { status: 400 }
      );
    }
    const targetWardrobeId =
      typeof body.wardrobe_id === "string" ? body.wardrobe_id.trim() : "";
    if (angle !== "front" && !targetWardrobeId) {
      return Response.json(
        { error: "wardrobe_id required when angle is not 'front'", field: "wardrobe_id" },
        { status: 400 }
      );
    }

    // category is required for the front (new-row) path. For an angle append
    // we pull category off the existing wardrobe row instead, so allow blank.
    const category = typeof body.category === "string" ? body.category.trim() : "";
    if (angle === "front" && !category) {
      return Response.json({ error: "category required", field: "category" }, { status: 400 });
    }
    // Soft validation — wardrobe table accepts free-text categories. We only
    // warn through the response.
    const categoryKnown = category ? FORGE_VALID_CATEGORIES.has(category) : true;

    const subcategory = typeof body.subcategory === "string" ? body.subcategory.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const tags: string[] = Array.isArray(body.tags)
      ? body.tags.filter((t: any) => typeof t === "string" && t.trim()).map((t: string) => t.trim())
      : [];

    // Resolve the input URL for bg-strip:
    //   upload     → asset_url (already an uploaded public URL)
    //   from_image → source_url, optionally cropped via sharp first
    let workingUrl = "";
    let sourceLabel = "";

    if (mode === "upload") {
      const assetUrl = typeof body.asset_url === "string" ? body.asset_url.trim() : "";
      if (!assetUrl) {
        return Response.json({ error: "asset_url required for upload mode", field: "asset_url" }, { status: 400 });
      }
      workingUrl = assetUrl;
      sourceLabel = "upload";
    } else {
      // from_image
      const sourceUrl = typeof body.source_url === "string" ? body.source_url.trim() : "";
      if (!sourceUrl) {
        return Response.json({ error: "source_url required for from_image mode", field: "source_url" }, { status: 400 });
      }

      const region = body.region;
      if (region && typeof region === "object" &&
          Number.isFinite(region.x) && Number.isFinite(region.y) &&
          Number.isFinite(region.width) && Number.isFinite(region.height) &&
          region.width > 0 && region.height > 0) {
        // Crop with sharp, re-upload to garments/ as the new working URL.
        try {
          const sharp = (await import("sharp")).default;
          const dl = await fetch(sourceUrl);
          if (!dl.ok) {
            return Response.json(
              { error: "source_fetch_failed", detail: `HTTP ${dl.status}` },
              { status: 400 }
            );
          }
          const sourceBuf = Buffer.from(await dl.arrayBuffer());
          const meta = await sharp(sourceBuf).metadata();
          const W = meta.width || 0;
          const H = meta.height || 0;
          // Clamp the region so we don't ask sharp to extract beyond the bounds.
          const left = Math.max(0, Math.min(W - 1, Math.floor(region.x)));
          const top = Math.max(0, Math.min(H - 1, Math.floor(region.y)));
          const width = Math.max(1, Math.min(W - left, Math.floor(region.width)));
          const height = Math.max(1, Math.min(H - top, Math.floor(region.height)));
          const cropped = await sharp(sourceBuf)
            .extract({ left, top, width, height })
            .png()
            .toBuffer();
          workingUrl = await uploadBufferToStorage(
            cropped,
            "image/png",
            buildUploadPath,
            uploadToStorage,
            "forge-crop"
          );
        } catch (err: any) {
          return Response.json(
            { error: "crop_failed", detail: err?.message || String(err) },
            { status: 500 }
          );
        }
      } else {
        workingUrl = sourceUrl;
      }
      sourceLabel = "from_image";
    }

    // Bg-strip step. Skip if caller asserts the input is already transparent
    // (saves a FAL hit and round-trip). The /api/remove-bg handler also short-
    // circuits when alpha looks real, but for already-transparent uploads the
    // caller can skip cleanly with skip_bg_strip=true.
    let transparentUrl = workingUrl;
    let bgStripped = false;
    let bgStrippedSkipReason: string | null = null;
    const skipBgStrip = body.skip_bg_strip === true;

    if (skipBgStrip) {
      bgStrippedSkipReason = "caller_skipped";
    } else {
      try {
        // Probe alpha first — same logic as handleRemoveBg's short-circuit.
        // If the image already has real transparency, just keep it.
        const sharp = (await import("sharp")).default;
        const probe = await fetch(workingUrl);
        if (probe.ok) {
          const probeBuf = Buffer.from(await probe.arrayBuffer());
          const meta = await sharp(probeBuf).metadata();
          if (meta.hasAlpha) {
            const alphaStats = await sharp(probeBuf).extractChannel("alpha").stats();
            const alphaChannel = alphaStats.channels[0];
            if (alphaChannel && alphaChannel.min < 250) {
              bgStrippedSkipReason = "already_transparent";
            }
          }
        }
      } catch {
        // Probe failure non-fatal — fall through to BiRefNet.
      }

      if (!bgStrippedSkipReason) {
        try {
          const cutoutRes = await fetch("https://fal.run/fal-ai/birefnet/v2", {
            method: "POST",
            headers: {
              Authorization: `Key ${env("FAL_API_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ image_url: workingUrl, output_format: "png" }),
          });
          if (!cutoutRes.ok) {
            const errText = (await cutoutRes.text()).slice(0, 300);
            return Response.json(
              { error: "bg_strip_failed", detail: `Cutout ${cutoutRes.status}: ${errText}` },
              { status: 502 }
            );
          }
          const cutoutData = await cutoutRes.json();
          const remoteUrl = cutoutData.image?.url || cutoutData.images?.[0]?.url;
          if (!remoteUrl) {
            return Response.json(
              { error: "bg_strip_failed", detail: "Cutout returned no image" },
              { status: 502 }
            );
          }
          // Re-host so it doesn't expire and is CORS-friendly for the canvas.
          const dl = await fetch(remoteUrl);
          if (!dl.ok) {
            return Response.json(
              { error: "bg_strip_failed", detail: `download ${dl.status}` },
              { status: 502 }
            );
          }
          const buf = Buffer.from(await dl.arrayBuffer());
          transparentUrl = await uploadBufferToStorage(
            buf,
            "image/png",
            buildUploadPath,
            uploadToStorage,
            "forge-cutout"
          );
          bgStripped = true;
        } catch (err: any) {
          return Response.json(
            { error: "bg_strip_error", detail: err?.message || String(err) },
            { status: 500 }
          );
        }
      }
    }

    // Pull dims off the final transparent PNG so the assets row carries
    // width/height (the wardrobe grid pre-allocates space without re-decoding).
    let finalWidth: number | null = null;
    let finalHeight: number | null = null;
    try {
      const sharp = (await import("sharp")).default;
      const dl = await fetch(transparentUrl);
      if (dl.ok) {
        const buf = Buffer.from(await dl.arrayBuffer());
        const meta = await sharp(buf).metadata();
        finalWidth = meta.width || null;
        finalHeight = meta.height || null;
      }
    } catch {
      // dims are nice-to-have, not blocking.
    }

    // Insert assets row. asset_type='curated' is the wardrobe-library bucket
    // per the migration 0042 comment. Tags get echoed through so search by
    // garment material/color hits the asset table too.
    const nowIso = new Date().toISOString();
    const assetRow: Record<string, any> = {
      asset_type: "curated",
      source_url: transparentUrl,
      mime_type: "image/png",
      tags,
      metadata: {
        forge: {
          mode: sourceLabel,
          original_url: workingUrl,
          bg_stripped: bgStripped,
          bg_strip_skip_reason: bgStrippedSkipReason,
        },
      },
      created_at: nowIso,
      updated_at: nowIso,
    };
    if (finalWidth !== null) assetRow.width = finalWidth;
    if (finalHeight !== null) assetRow.height = finalHeight;

    const assetRes = await fetch(`${SUPABASE_URL}/rest/v1/assets`, {
      method: "POST",
      headers: supaHeaders(),
      body: JSON.stringify(assetRow),
    });
    if (!assetRes.ok) {
      const errText = await assetRes.text();
      return Response.json(
        { error: "asset_create_failed", detail: errText },
        { status: 500 }
      );
    }
    const assetCreated = await assetRes.json();
    const asset = Array.isArray(assetCreated) ? assetCreated[0] : assetCreated;
    if (!asset?.id) {
      return Response.json(
        { error: "asset_create_failed", detail: "asset row missing id" },
        { status: 500 }
      );
    }

    // Two paths from here:
    //   1) angle === 'front'  → insert a brand-new wardrobe row pointing at
    //                            the asset we just created (legacy default).
    //   2) angle !== 'front'  → leave the existing wardrobe row's primary
    //                            asset_id alone. Just merge the new URL into
    //                            attributes.angles[angle] on that row so the
    //                            UI's angle picker can swap it in.
    if (angle !== "front") {
      const merged = await mergeWardrobeAngle(targetWardrobeId, angle, transparentUrl);
      if (!merged.ok) {
        return Response.json(merged.body, { status: merged.status });
      }
      return Response.json(
        {
          ok: true,
          wardrobe: merged.row,
          asset,
          preview_url: transparentUrl,
          angle,
          bg_stripped: bgStripped,
          bg_strip_skip_reason: bgStrippedSkipReason,
        },
        { status: 200 }
      );
    }

    // Insert wardrobe row pointing at the new asset.
    const wardrobeRow: Record<string, any> = {
      asset_id: asset.id,
      category,
      tags,
      attributes: {
        forge: {
          mode: sourceLabel,
          category_known: categoryKnown,
        },
      },
      created_at: nowIso,
      updated_at: nowIso,
    };
    if (subcategory) wardrobeRow.subcategory = subcategory;
    if (name) wardrobeRow.name = name;

    const wardrobeRes = await fetch(`${SUPABASE_URL}/rest/v1/wardrobe`, {
      method: "POST",
      headers: supaHeaders(),
      body: JSON.stringify(wardrobeRow),
    });
    if (!wardrobeRes.ok) {
      const errText = await wardrobeRes.text();
      // FK violation should be impossible (we just created the asset), but
      // surface it explicitly if it ever happens.
      if (errText.includes("23503") || /violates foreign key/i.test(errText)) {
        return Response.json(
          { error: "asset_not_found", asset_id: asset.id, detail: errText },
          { status: 422 }
        );
      }
      return Response.json(
        { error: "wardrobe_create_failed", detail: errText, asset_id: asset.id },
        { status: 500 }
      );
    }
    const wardrobeCreated = await wardrobeRes.json();
    const wardrobe = Array.isArray(wardrobeCreated) ? wardrobeCreated[0] : wardrobeCreated;

    return Response.json(
      {
        ok: true,
        wardrobe,
        asset,
        preview_url: transparentUrl,
        bg_stripped: bgStripped,
        bg_strip_skip_reason: bgStrippedSkipReason,
      },
      { status: 201 }
    );
  } catch (err: any) {
    return Response.json(
      { error: "wardrobe_forge_error", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}

// =============================================================================
// Multi-angle wardrobe variants (darkroom.wardrobe.multi-angle)
//
// A single wardrobe row's primary `asset_id` is the canonical front view. Any
// additional viewpoints (back, side, detail, etc.) live as URL strings under
// attributes.angles[angle]. Storing as URL strings keeps it cheap — no extra
// table, no FK fan-out, no migration. The cost is that the angle URLs are not
// auto-cascaded if the underlying asset row is hard-deleted, but the same
// cascading concern doesn't apply because each angle URL points at object
// storage directly, not at an `assets` row.
//
// API:
//   POST   /api/wardrobe/:id/angles            body { angle, asset_url }
//   DELETE /api/wardrobe/:id/angles/:angle
//
// Both return the updated wardrobe row.
// =============================================================================

// Pull a wardrobe row by id from PostgREST. Returns null on miss, throws on
// other errors so the caller can surface a 5xx.
async function fetchWardrobeRow(id: string): Promise<any | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/wardrobe?id=eq.${encodeFilterValue(id)}&select=*&limit=1`,
    { headers: supaHeaders() }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`wardrobe_lookup_failed: ${errText}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

// Merge a single angle URL into a wardrobe row's attributes.angles bag. PATCHes
// the row and returns the updated row body. Used by both POST /:id/angles and
// the angle path of /api/wardrobe/forge.
async function mergeWardrobeAngle(
  wardrobeId: string,
  angle: string,
  assetUrl: string
): Promise<
  | { ok: true; row: any }
  | { ok: false; status: number; body: any }
> {
  if (!WARDROBE_VALID_ANGLES.has(angle)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `invalid angle '${angle}' — valid: ${[...WARDROBE_VALID_ANGLES].join(" | ")}`,
        field: "angle",
      },
    };
  }
  // 'front' lives on asset_id, not in the angles bag — disallow merging it.
  if (angle === "front") {
    return {
      ok: false,
      status: 400,
      body: {
        error: "front view is stored on wardrobe.asset_id, not attributes.angles. Update the row directly or re-forge to replace.",
        field: "angle",
      },
    };
  }

  let row: any;
  try {
    row = await fetchWardrobeRow(wardrobeId);
  } catch (err: any) {
    return {
      ok: false,
      status: 500,
      body: { error: "wardrobe_lookup_error", detail: err?.message || String(err) },
    };
  }
  if (!row) {
    return {
      ok: false,
      status: 404,
      body: { error: "wardrobe_not_found", id: wardrobeId },
    };
  }

  const existingAttrs =
    row.attributes && typeof row.attributes === "object" && !Array.isArray(row.attributes)
      ? row.attributes
      : {};
  const existingAngles =
    existingAttrs.angles && typeof existingAttrs.angles === "object" && !Array.isArray(existingAttrs.angles)
      ? existingAttrs.angles
      : {};
  const nextAngles = { ...existingAngles, [angle]: assetUrl };
  const nextAttrs = { ...existingAttrs, angles: nextAngles };

  const patchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/wardrobe?id=eq.${encodeFilterValue(wardrobeId)}`,
    {
      method: "PATCH",
      headers: supaHeaders(),
      body: JSON.stringify({
        attributes: nextAttrs,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  if (!patchRes.ok) {
    const errText = await patchRes.text();
    return {
      ok: false,
      status: 500,
      body: { error: "wardrobe_angle_patch_failed", detail: errText },
    };
  }
  const rows = await patchRes.json();
  const updated = Array.isArray(rows) && rows.length > 0 ? rows[0] : { ...row, attributes: nextAttrs };
  return { ok: true, row: updated };
}

// POST /api/wardrobe/:id/angles
// Body: { angle: string, asset_url: string }
async function handleWardrobeAngleAdd(req: Request, wardrobeId: string): Promise<Response> {
  try {
    if (!SUPABASE_URL) {
      return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
    }
    const body: any = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid_json_body" }, { status: 400 });
    }
    const angle = typeof body.angle === "string" ? body.angle.trim().toLowerCase() : "";
    const assetUrl = typeof body.asset_url === "string" ? body.asset_url.trim() : "";
    if (!angle) {
      return Response.json({ error: "angle required", field: "angle" }, { status: 400 });
    }
    if (!assetUrl) {
      return Response.json({ error: "asset_url required", field: "asset_url" }, { status: 400 });
    }
    const merged = await mergeWardrobeAngle(wardrobeId, angle, assetUrl);
    if (!merged.ok) {
      return Response.json(merged.body, { status: merged.status });
    }
    return Response.json({ ok: true, wardrobe: merged.row, angle }, { status: 200 });
  } catch (err: any) {
    return Response.json(
      { error: "wardrobe_angle_add_error", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}

// DELETE /api/wardrobe/:id/angles/:angle
async function handleWardrobeAngleDelete(
  wardrobeId: string,
  angle: string
): Promise<Response> {
  try {
    if (!SUPABASE_URL) {
      return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
    }
    const normalized = angle.trim().toLowerCase();
    if (!WARDROBE_VALID_ANGLES.has(normalized) || normalized === "front") {
      return Response.json(
        { error: `invalid angle '${normalized}'`, field: "angle" },
        { status: 400 }
      );
    }

    let row: any;
    try {
      row = await fetchWardrobeRow(wardrobeId);
    } catch (err: any) {
      return Response.json(
        { error: "wardrobe_lookup_error", detail: err?.message || String(err) },
        { status: 500 }
      );
    }
    if (!row) {
      return Response.json({ error: "wardrobe_not_found", id: wardrobeId }, { status: 404 });
    }

    const existingAttrs =
      row.attributes && typeof row.attributes === "object" && !Array.isArray(row.attributes)
        ? row.attributes
        : {};
    const existingAngles =
      existingAttrs.angles && typeof existingAttrs.angles === "object" && !Array.isArray(existingAttrs.angles)
        ? existingAttrs.angles
        : {};
    if (!(normalized in existingAngles)) {
      // Idempotent — return ok with the row unchanged.
      return Response.json({ ok: true, wardrobe: row, angle: normalized, removed: false }, { status: 200 });
    }
    const { [normalized]: _drop, ...rest } = existingAngles;
    const nextAttrs = { ...existingAttrs, angles: rest };

    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/wardrobe?id=eq.${encodeFilterValue(wardrobeId)}`,
      {
        method: "PATCH",
        headers: supaHeaders(),
        body: JSON.stringify({
          attributes: nextAttrs,
          updated_at: new Date().toISOString(),
        }),
      }
    );
    if (!patchRes.ok) {
      const errText = await patchRes.text();
      return Response.json(
        { error: "wardrobe_angle_patch_failed", detail: errText },
        { status: 500 }
      );
    }
    const rows = await patchRes.json();
    const updated = Array.isArray(rows) && rows.length > 0 ? rows[0] : { ...row, attributes: nextAttrs };
    return Response.json({ ok: true, wardrobe: updated, angle: normalized, removed: true }, { status: 200 });
  } catch (err: any) {
    return Response.json(
      { error: "wardrobe_angle_delete_error", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}

// =============================================================================
// Watch engine — content-aware auto-routing for /api/edit.
//
// Watch is a meta-engine: it never edits an image itself. It inspects the
// source image's content profile (from /api/analyze-image, cached on
// assets.metadata.content_profile when available) plus the user's prompt
// and dispatches to one of the real engines (Lens/Glance/Strip/Brush/Eye).
// Hard refusals (minor_concern / violence) are rejected with 422 even
// before an engine is picked — defense-in-depth in case a profile slips
// past analyze-image's own short-circuit.
//
// Routing rules (priority order):
//   1. Mask present                            → Brush  (Flux Fill Pro)
//   2. explicit_acts || nudity_level=explicit  → Strip  (P-Edit, NSFW-tolerant)
//   3. topless/implied + ref image             → Lens   (Grok img2img Lock+List)
//   4. topless/implied (single image)          → Lens   (identity anchor preserves face)
//   5. SFW + compositional verbs               → Eye    (gpt-image-2 reasons over structure)
//   6. SFW + style/grade verbs                 → Lens   (Grok handles color/grade)
//   7. fallback                                → Glance (Nano Banana — fast, content-tolerant)
// =============================================================================

type WatchProfile = {
  nudity_level: string;
  scene_type: string;
  primary_subject: string;
  explicit_acts: boolean;
  minor_concern: boolean;
  violence: boolean;
  tags: string[];
  [k: string]: any;
};

type WatchDecision = {
  chosen_engine: "lens" | "glance" | "strip" | "brush" | "eye";
  reason: string;
  profile: WatchProfile;
};

// Pure routing-rules function — separated from handleWatchRoute so it can be
// unit-tested against a synthetic profile + prompt without any HTTP setup.
export function pickWatchEngine(
  profile: WatchProfile,
  userPrompt: string,
  hasMask: boolean,
  hasRefImage: boolean
): { chosen_engine: WatchDecision["chosen_engine"]; reason: string } {
  const prompt = String(userPrompt || "");
  const nudity = String(profile?.nudity_level || "none").toLowerCase();

  // 1. Mask → Brush (mask-bound edits regardless of content)
  if (hasMask) {
    return {
      chosen_engine: "brush",
      reason: "mask provided — Brush is mask-based and content-tolerant",
    };
  }

  // 2. Explicit content → Strip (P-Edit, NSFW-permissive)
  if (profile?.explicit_acts || nudity === "explicit") {
    return {
      chosen_engine: "strip",
      reason: "explicit content — Strip is NSFW-tolerant",
    };
  }

  // 3. Topless/implied + ref image → Lens (Lock+List multi-image)
  if ((nudity === "topless" || nudity === "implied") && hasRefImage) {
    return {
      chosen_engine: "lens",
      reason: "topless/implied source + ref image — Lens (Lock+List) handles this",
    };
  }

  // 4. Topless/implied (single image) → Lens with identity anchor
  if (nudity === "topless" || nudity === "implied") {
    return {
      chosen_engine: "lens",
      reason: "topless/implied source — Lens with identity anchor",
    };
  }

  // 5. SFW + compositional change → Eye
  if (nudity === "none" && /\b(change|swap|replace|move|put|add|remove|insert)\b/i.test(prompt)) {
    return {
      chosen_engine: "eye",
      reason: "SFW + compositional change — Eye (gpt-image-2) reasons over structural intent",
    };
  }

  // 6. SFW + style/color change → Lens
  if (nudity === "none" && /\b(style|color|colour|grade|grading|look|tone|warm|cool|cinematic|hue|vibe|mood)\b/i.test(prompt)) {
    return {
      chosen_engine: "lens",
      reason: "SFW + style/grade change — Lens for color/tone",
    };
  }

  // 7. Fallback → Glance
  return {
    chosen_engine: "glance",
    reason: "fallback — Glance (Nano Banana) handles most cases",
  };
}

// Best-effort content profile lookup. Order:
//   1. assets.metadata.content_profile cache (fast — sub-100ms when hit).
//   2. Inline classification via xAI vision (same code path as
//      handleAnalyzeImage). Failures return null so the caller can decide
//      whether to fall back.
async function getOrComputeWatchProfile(imageUrl: string): Promise<WatchProfile | null> {
  // 1. Cache check
  try {
    const hit = await lookupAssetBySourceUrl(imageUrl);
    if (hit && isV2Profile(hit.metadata?.content_profile)) {
      return hit.metadata.content_profile as WatchProfile;
    }
  } catch {
    // ignore — fall through to inline classification
  }

  // 2. Inline classification (mirrors handleAnalyzeImage parsing logic)
  try {
    const visionRes = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("XAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-4-1-fast-non-reasoning",
        messages: [
          { role: "system", content: ANALYZE_IMAGE_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Classify this image. Return ONLY the JSON object." },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        temperature: 0,
      }),
    });
    if (!visionRes.ok) return null;
    const visionData = await visionRes.json();
    const raw = String(visionData?.choices?.[0]?.message?.content || "{}").trim();
    const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return null;
    }

    const nudity = String(parsed.nudity_level || "").toLowerCase();
    const scene = String(parsed.scene_type || "").toLowerCase();
    const primarySubject = String(parsed.primary_subject || "").toLowerCase();
    let tags: string[] = [];
    if (Array.isArray(parsed.tags)) {
      tags = parsed.tags
        .map((t: any) => String(t || "").trim().toLowerCase())
        .filter((t: string) => t.length > 0 && t.length <= 64)
        .slice(0, 8);
    }

    return {
      nudity_level: ANALYZE_NUDITY_VALUES.has(nudity) ? nudity : "none",
      scene_type: ANALYZE_SCENE_VALUES.has(scene) ? scene : "other",
      primary_subject: ANALYZE_PRIMARY_SUBJECT_VALUES.has(primarySubject)
        ? primarySubject
        : "other",
      explicit_acts: Boolean(parsed.explicit_acts),
      minor_concern: Boolean(parsed.minor_concern),
      violence: Boolean(parsed.violence),
      tags,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Free re-routing on content-filter refusal
// =============================================================================
// When an engine refuses an edit on safety/content grounds, transparently fall
// over to the next-best engine for the same content profile (per the
// engine-compatibility verdict map exposed at GET /api/engine-compatibility).
//
// Affected engines: Lens, Glance, Eye, Frame — the SFW-leaning engines that
// tend to refuse anything spicy. Brush, Strip, Lock are mask-based or
// NSFW-tolerant; their refusal is treated as a real error and not retried.
//
// Cost note: the failed engine call already happened, so the caller pays for
// it on the upstream API. The retry is "free" in the sense that we don't
// charge the user twice on our side and don't recurse — exactly ONE re-route
// per request, then fail through with the original error.
// =============================================================================

// Static mirror of the (engine × content_profile) verdict map exposed at
// GET /api/engine-compatibility. Keep these two definitions in sync if you
// ever change one — the API response is the public contract, this map is
// the runtime-routing copy.
type EngineVerdict = "likely" | "may-refuse" | "will-refuse";
const REROUTE_ENGINE_COMPAT: Record<string, Record<string, EngineVerdict>> = {
  lens:   { sfw: "likely", nsfw_topless: "may-refuse" },
  glance: { sfw: "likely", nsfw_topless: "may-refuse" },
  strip:  { sfw: "likely", nsfw_topless: "likely" },
  brush:  { sfw: "likely", nsfw_topless: "likely" },
  eye:    { sfw: "likely", nsfw_topless: "will-refuse" },
  frame:  { sfw: "likely", nsfw_topless: "will-refuse" },
  skin:   { sfw: "likely", nsfw_topless: "may-refuse" },
  blend:  { sfw: "likely", nsfw_topless: "likely" },
  lock:   { sfw: "likely", nsfw_topless: "likely" },
};

// Rank verdicts when picking a fallback. Lower = better.
const VERDICT_RANK: Record<EngineVerdict, number> = {
  "likely": 0,
  "may-refuse": 1,
  "will-refuse": 99, // never pick a will-refuse engine for fallback
};

// Engines whose refusal is non-recoverable (mask-based or NSFW-tolerant).
const REROUTING_FATAL_ENGINES = new Set(["brush", "strip", "lock"]);

// Engines that are wired through dispatchWatchEdit / per-engine call functions
// in this file. Frame (Bria) is in generation.ts only, so it isn't a valid
// fallback target from a safe-edit dispatch.
const REROUTING_AVAILABLE_ENGINES = new Set(["lens", "glance", "strip", "brush", "eye"]);

// Map a WatchProfile to a coarse content_profile key the compat map uses.
// Only two profiles today (sfw / nsfw_topless) — that's the public contract.
function rerouteContentProfileKey(profile: WatchProfile | null | undefined): string {
  if (!profile) return "sfw";
  const nudity = String(profile.nudity_level || "none").toLowerCase();
  if (profile.explicit_acts) return "nsfw_topless"; // best available bucket
  if (nudity === "topless" || nudity === "implied" || nudity === "explicit") return "nsfw_topless";
  return "sfw";
}

// Returns the engines from the compat map ordered by verdict rank for the
// given profile, excluding "will-refuse" entries and any engines not actually
// wired through dispatchWatchEdit.
function enginesForProfile(profile: WatchProfile | null | undefined): string[] {
  const key = rerouteContentProfileKey(profile);
  const candidates: Array<{ name: string; rank: number }> = [];
  for (const [name, verdicts] of Object.entries(REROUTE_ENGINE_COMPAT)) {
    if (!REROUTING_AVAILABLE_ENGINES.has(name)) continue;
    const v = verdicts[key];
    if (!v || v === "will-refuse") continue;
    candidates.push({ name, rank: VERDICT_RANK[v] ?? 50 });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates.map((c) => c.name);
}

// Pick the next-best engine for a profile, skipping the failed one and any
// "will-refuse" engines. Returns null when there's no usable alternative.
function pickNextEngine(
  failedEngine: string,
  profile: WatchProfile | null | undefined
): string | null {
  const ordered = enginesForProfile(profile);
  for (const name of ordered) {
    if (name === failedEngine) continue;
    return name;
  }
  return null;
}

// Heuristic: did this error come from an engine refusing on content grounds?
// Common signatures across the engines we wrap:
//   - OpenAI gpt-image-2: HTTP 400 with "safety", "content_policy", "rejected".
//   - xAI Grok: HTTP 400/422 with "safety", "policy", "moderation", "violates".
//   - fal.ai (nano-banana): HTTP 400/422 with "safety" / "filter".
//   - Replicate p-image-edit: less common — only flags blatant refusals.
// We err on the side of recall: any of these fragments tips us into a retry.
function isContentFilterError(e: unknown): boolean {
  if (!e) return false;
  const msg = String((e as any)?.message || e || "").toLowerCase();
  if (!msg) return false;
  // Status-code shortcuts (engine call functions all embed `${res.status}` in
  // the thrown error message, e.g. "Eye 400: ...", "Lens 422: ...").
  const has400 = / 400:| 400 /.test(msg) || msg.includes("status 400");
  const has422 = / 422:| 422 /.test(msg) || msg.includes("status 422");
  // Phrase-based detection (case-insensitive).
  const KEYWORDS = [
    "safety",
    "content_policy",
    "content policy",
    "policy violation",
    "moderation",
    "moderated",
    "rejected",
    "refused",
    "violates",
    "violation",
    "not allowed",
    "disallowed",
    "filtered",
    "content filter",
    "unsafe",
    "explicit",
    "sexual",
    "nsfw",
  ];
  const hasKeyword = KEYWORDS.some((k) => msg.includes(k));
  // Only return true if we have either a 400/422 status OR a clear keyword.
  // 5xx errors are upstream-failure, not refusal — never reroute on those.
  if (msg.includes(" 5") && /\b5\d\d\b/.test(msg)) return false;
  return hasKeyword || (has400 && hasKeyword) || has422;
}

type DispatchEngineArgs = {
  imageUrl: string;
  prompt: string;
  maskUrl?: string;
  refUrls?: string[];
};

// Inner dispatch — calls one engine, no rerouting logic. Returns the upstream
// URL or throws. dispatchWatchEdit and callWithRerouting both build on this.
async function callEngineByName(
  engineName: string,
  args: DispatchEngineArgs
): Promise<string> {
  switch (engineName) {
    case "lens":
      return await callGrokEdit({ imageUrl: args.imageUrl, prompt: args.prompt });
    case "glance":
      return await callNanoBanana({ imageUrl: args.imageUrl, prompt: args.prompt });
    case "strip":
      return await callPEdit({ imageUrl: args.imageUrl, prompt: args.prompt, refUrls: args.refUrls });
    case "eye":
      return await callGptImage2Edit({
        imageUrl: args.imageUrl,
        maskUrl: args.maskUrl,
        prompt: args.prompt,
        size: GPT_SIZE,
        quality: GPT_QUALITY,
      });
    case "brush": {
      if (!args.maskUrl) {
        throw new Error("Brush requires a mask_url");
      }
      const buf = await callFluxFillPro({
        imageUrl: args.imageUrl,
        maskUrl: args.maskUrl,
        prompt: args.prompt,
      });
      const { uploadToStorage, buildUploadPath } = await import("../supabase");
      return await uploadBufferToStorage(
        buf,
        "image/png",
        buildUploadPath,
        uploadToStorage,
        "watch-brush"
      );
    }
    default:
      throw new Error(`unknown engine "${engineName}"`);
  }
}

// Wrap a primary engine call. On content-filter refusal, fall over to the
// next-best engine for the same content profile. Up to ONE retry total.
// Returns { url, engineUsed, rerouted? } so the caller can attach
// re-route diagnostics to its response.
async function callWithRerouting(
  primaryEngine: string,
  profile: WatchProfile | null | undefined,
  args: DispatchEngineArgs
): Promise<{
  url: string;
  engineUsed: string;
  rerouted?: { from: string; to: string; refusal_reason: string };
}> {
  try {
    const url = await callEngineByName(primaryEngine, args);
    return { url, engineUsed: primaryEngine };
  } catch (e: any) {
    // Brush/Strip/Lock refusals are fatal — no fallover.
    if (REROUTING_FATAL_ENGINES.has(primaryEngine)) throw e;
    if (!isContentFilterError(e)) throw e;
    const next = pickNextEngine(primaryEngine, profile);
    if (!next) throw e;
    // One-and-done — if the fallback also throws, surface it directly.
    const url = await callEngineByName(next, args);
    return {
      url,
      engineUsed: next,
      rerouted: {
        from: primaryEngine,
        to: next,
        refusal_reason: String(e?.message || e).slice(0, 200),
      },
    };
  }
}

// Dispatch a watch-routed edit. Returns the upstream URL plus the engine that
// actually delivered the result and (if a content-filter refusal triggered
// fallover) a `rerouted` diagnostic object. Free re-routing handles
// content-filter refusals on lens/glance/eye; brush mask refusal stays fatal.
async function dispatchWatchEdit(args: {
  chosen_engine: WatchDecision["chosen_engine"];
  imageUrl: string;
  prompt: string;
  maskUrl?: string;
  refUrls?: string[];
  profile?: WatchProfile | null;
}): Promise<{
  url: string;
  engineUsed: string;
  rerouted?: { from: string; to: string; refusal_reason: string };
}> {
  // Single-image edits prepend the identity anchor (matches the existing
  // /api/edit and /api/smart-edit conventions). Mask flows skip the anchor.
  const isSingleImageEdit = !args.maskUrl;
  const anchored = isSingleImageEdit
    ? `${IDENTITY_ANCHOR}. ${args.prompt}`
    : args.prompt;

  // Brush requires a mask up front — surface clearly rather than rerouting.
  if (args.chosen_engine === "brush" && !args.maskUrl) {
    throw new Error("Brush requires a mask_url; watch routing chose Brush without one");
  }

  return await callWithRerouting(args.chosen_engine, args.profile ?? null, {
    imageUrl: args.imageUrl,
    prompt: anchored,
    maskUrl: args.maskUrl,
    refUrls: args.refUrls,
  });
}

async function handleWatchRoute(
  body: any,
  _deps: Pick<RouteDeps, "saveGeneration" | "getCharacter">
): Promise<Response> {
  try {
    // Accept both /api/edit and /api/smart-edit body shapes — callers in
    // the wild use both source_url+edit_prompt and image_url+prompt.
    const imageUrl = String(body.image_url || body.source_url || "").trim();
    const userPrompt = String(body.prompt || body.edit_prompt || "").trim();
    const maskUrl = body.mask_url ? String(body.mask_url) : undefined;
    const refUrls: string[] = Array.isArray(body.ref_urls)
      ? body.ref_urls.filter(Boolean).map(String)
      : body.ref_url
        ? [String(body.ref_url)]
        : [];
    const hasMask = !!maskUrl;
    const hasRefImage = refUrls.length > 0;

    if (!imageUrl) {
      return Response.json(
        { error: "image_url required for watch routing" },
        { status: 400 }
      );
    }
    if (!userPrompt) {
      return Response.json(
        { error: "prompt required for watch routing" },
        { status: 400 }
      );
    }

    // 1. Profile lookup
    const profile = await getOrComputeWatchProfile(imageUrl);

    // 2. Hard refusal: minor_concern or violence → 422 even before engine pick
    if (profile && (profile.minor_concern || profile.violence)) {
      return Response.json(
        {
          error: "content_refused",
          refusal_reason: profile.minor_concern ? "minor_concern" : "violence",
          watch_decision: { profile, refused: true },
        },
        { status: 422 }
      );
    }

    // 3. Pick engine (defensive fallback if profile lookup failed entirely)
    const decision = profile
      ? pickWatchEngine(profile, userPrompt, hasMask, hasRefImage)
      : {
          chosen_engine: "glance" as const,
          reason: "profile-unavailable fallback — Glance handles most cases",
        };

    // 4. Dispatch to the chosen engine (with free re-routing on content
    //    filter refusal — see callWithRerouting / pickNextEngine above).
    let dispatchResult: {
      url: string;
      engineUsed: string;
      rerouted?: { from: string; to: string; refusal_reason: string };
    };
    try {
      dispatchResult = await dispatchWatchEdit({
        chosen_engine: decision.chosen_engine,
        imageUrl,
        prompt: userPrompt,
        maskUrl,
        refUrls,
        profile: profile ?? null,
      });
    } catch (err: any) {
      return Response.json(
        {
          error: "watch_engine_failed",
          engine: decision.chosen_engine,
          detail: String(err?.message || err).slice(0, 400),
          watch_decision: {
            chosen_engine: decision.chosen_engine,
            reason: decision.reason,
            profile: profile ?? null,
          },
        },
        { status: 502 }
      );
    }

    // 5. Return result with watch_decision attached. Fields exposed:
    //    - ok / url / engine: match the existing /api/edit response shape
    //      so callers can swap engine="watch" in without rewriting parsing.
    //      `engine` reflects the engine that ACTUALLY produced the result
    //      (post-rerouting), so downstream callers see the truth.
    //    - watch_decision: chosen_engine (originally picked), reason, profile.
    //    - rerouted: present only when the primary engine refused and we
    //      successfully fell over. { from, to, refusal_reason }.
    //    - reason (top-level): mirrors watch_decision.reason for the
    //      verification check (expects body.reason).
    const respBody: any = {
      ok: true,
      url: dispatchResult.url,
      engine: dispatchResult.engineUsed,
      reason: decision.reason,
      watch_decision: {
        chosen_engine: decision.chosen_engine,
        reason: decision.reason,
        profile: profile ?? null,
      },
    };
    if (dispatchResult.rerouted) {
      respBody.rerouted = dispatchResult.rerouted;
    }
    return Response.json(respBody);
  } catch (err: any) {
    return Response.json(
      { error: err?.message || "watch routing failed" },
      { status: 500 }
    );
  }
}

// =============================================================================
// User-submitted detail brushes
//
// POST /api/details/submit  inserts a row into detail_brush_assets with
// is_hidden=true so an operator must approve before the brush appears in the
// public catalog. The asset_url is stored on the row's params jsonb (under
// `submitted_asset_url`) — detail_brush_assets has no preview_asset_url
// column, but params is jsonb, so this keeps the migration untouched.
//
// GET  /api/details/submissions  returns the rows matching ?is_hidden= so the
// submitting client can poll their own submissions. v1 has no user_id column
// on detail_brush_assets, so this endpoint returns ALL rows matching the
// filter — sufficient for the immediate "did my submission go through" UX.
// Per-user scoping is a future task once detail_brush_assets carries owner.
//
// Rate-limiting / abuse prevention: TODO. There is no per-IP, per-user, or
// per-slug throttle today. The is_hidden gate is the only safety net — an
// abusive submission can fill the table but cannot pollute the public
// catalog without manual approval.
// =============================================================================

const DETAIL_SUBMIT_VALID_CATEGORIES = new Set([
  "anatomical",
  "fabric",
  "lighting",
  "fx",
  "custom",
]);

const DETAIL_SUBMIT_VALID_ENGINES = new Set(["brush", "strip", "lens"]);

const DETAIL_SUBMIT_SLUG_RE = /^[a-z0-9-]+$/;

async function handleDetailSubmit(req: Request): Promise<Response> {
  try {
    if (!SUPABASE_URL) {
      return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
    }

    const body: any = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid_json_body" }, { status: 400 });
    }

    const assetUrl =
      typeof body.asset_url === "string" ? body.asset_url.trim() : "";
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const category =
      typeof body.category === "string" ? body.category.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const negativePrompt =
      typeof body.negative_prompt === "string"
        ? body.negative_prompt.trim()
        : "";
    const engineDefault =
      typeof body.engine_default === "string" && body.engine_default.trim()
        ? body.engine_default.trim()
        : "brush";
    // NSFW defaults to true — these brushes are typically nipple/areola/
    // cameltoe content, hence the "submit detail" flow exists at all.
    const isNsfw = body.is_nsfw === undefined ? true : Boolean(body.is_nsfw);
    const params =
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? (body.params as Record<string, any>)
        : {};

    // Required fields
    if (!assetUrl) {
      return Response.json(
        { error: "asset_url required", field: "asset_url" },
        { status: 400 }
      );
    }
    if (!slug) {
      return Response.json(
        { error: "slug required", field: "slug" },
        { status: 400 }
      );
    }
    if (!label) {
      return Response.json(
        { error: "label required", field: "label" },
        { status: 400 }
      );
    }
    if (!category) {
      return Response.json(
        { error: "category required", field: "category" },
        { status: 400 }
      );
    }
    if (!prompt) {
      return Response.json(
        { error: "prompt required", field: "prompt" },
        { status: 400 }
      );
    }

    // Format / enum validation
    if (!DETAIL_SUBMIT_SLUG_RE.test(slug) || slug.length < 3 || slug.length > 60) {
      return Response.json(
        {
          error:
            "slug must match /^[a-z0-9-]+$/ and be 3-60 characters",
          field: "slug",
        },
        { status: 400 }
      );
    }
    if (!DETAIL_SUBMIT_VALID_CATEGORIES.has(category)) {
      return Response.json(
        {
          error: `invalid category — valid: ${[
            ...DETAIL_SUBMIT_VALID_CATEGORIES,
          ].join(" | ")}`,
          field: "category",
        },
        { status: 400 }
      );
    }
    if (!DETAIL_SUBMIT_VALID_ENGINES.has(engineDefault)) {
      return Response.json(
        {
          error: `invalid engine_default — valid: ${[
            ...DETAIL_SUBMIT_VALID_ENGINES,
          ].join(" | ")}`,
          field: "engine_default",
        },
        { status: 400 }
      );
    }

    // Merge user-supplied params with required fields. The asset_url and
    // submission marker live on params jsonb because detail_brush_assets has
    // no first-class column for either — but params is purpose-built for
    // engine-specific overrides + arbitrary metadata.
    const mergedParams: Record<string, any> = {
      ...params,
      submitted_asset_url: assetUrl,
      is_user_submission: true,
      submitted_at: new Date().toISOString(),
    };

    const nowIso = new Date().toISOString();
    const row: Record<string, any> = {
      slug,
      label,
      category,
      prompt,
      engine_default: engineDefault,
      params: mergedParams,
      // v1 hard-rule: every user submission lands hidden. Operator approval
      // (manual SQL flip) gates public visibility.
      is_hidden: true,
      is_nsfw: isNsfw,
      featured: false,
      // 999 puts new submissions at the end of any per-category ordering
      // until an operator reorders them.
      position: 999,
      created_at: nowIso,
      updated_at: nowIso,
    };
    if (negativePrompt) row.negative_prompt = negativePrompt;

    const res = await fetch(`${SUPABASE_URL}/rest/v1/detail_brush_assets`, {
      method: "POST",
      headers: supaHeaders(),
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const errText = await res.text();
      // PostgREST surfaces unique-violation as 409 with code 23505.
      if (
        res.status === 409 ||
        errText.includes("23505") ||
        /duplicate key/i.test(errText)
      ) {
        return Response.json(
          { error: "slug_already_exists", slug, detail: errText },
          { status: 409 }
        );
      }
      return Response.json(
        { error: "detail_submit_failed", detail: errText },
        { status: 500 }
      );
    }
    const created = await res.json();
    const item = Array.isArray(created) ? created[0] : created;

    return Response.json({ ok: true, item }, { status: 201 });
  } catch (err: any) {
    return Response.json(
      { error: "detail_submit_error", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}

async function handleDetailSubmissions(url: URL): Promise<Response> {
  try {
    if (!SUPABASE_URL) {
      return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
    }

    // ?is_hidden=false explicitly opts into the approved-list view; default
    // is is_hidden=true (pending submissions). Anything else falls back to
    // pending.
    const isHiddenParam = url.searchParams.get("is_hidden");
    const isHidden = isHiddenParam === "false" ? false : true;

    const qs = new URLSearchParams();
    qs.set("is_hidden", `eq.${isHidden}`);
    qs.set("order", "created_at.desc");
    qs.set("limit", "200");

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/detail_brush_assets?${qs.toString()}`,
      {
        // Prefer: count=exact returns the total count in Content-Range so the
        // client knows how many submissions are pending without re-querying.
        headers: { ...supaHeaders(), Prefer: "count=exact" },
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      // Table may be missing on a fresh install — surface gracefully so the
      // UI can show "no submissions yet" instead of an opaque 500.
      if (res.status === 404 || /relation .* does not exist/i.test(errText)) {
        return Response.json({ items: [], count: 0 });
      }
      return Response.json(
        { error: "detail_submissions_failed", detail: errText },
        { status: 500 }
      );
    }

    const items = await res.json();
    // PostgREST returns the count in Content-Range as "0-N/total".
    let count = Array.isArray(items) ? items.length : 0;
    const cr = res.headers.get("Content-Range");
    if (cr) {
      const slash = cr.indexOf("/");
      if (slash >= 0) {
        const totalStr = cr.slice(slash + 1).trim();
        const total = parseInt(totalStr, 10);
        if (Number.isFinite(total)) count = total;
      }
    }

    return Response.json({
      items: Array.isArray(items) ? items : [],
      count,
      is_hidden: isHidden,
    });
  } catch (err: any) {
    return Response.json(
      { error: "detail_submissions_error", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}

// =============================================================================
// Async job-spawn pattern — spawnJob() helper + GET / DELETE /api/jobs surface.
//
// Long-running engine work in Darkroom (Topaz upscales = 30-60s, Magnific
// reveals, video gen, multi-pass chains) blocks the request thread for the
// duration of the vendor call. spawnJob() flips the model: write a row into
// the `jobs` table (created in migration 0050), kick the actual work off as a
// fire-and-forget promise, and return { job_id } synchronously. The UI polls
// GET /api/jobs/:id for status + progress.
//
// Lifecycle inside the worker promise:
//   queued  → INSERT (synchronous before return)
//   running → first PATCH (synchronous before return)
//             worker callback runs; calls updateProgress() to push fractions
//   completed | failed | cancelled → final PATCH from inside the worker
//
// Cancellation (DELETE /api/jobs/:id) is BEST-EFFORT in v1: we have no signal
// handle on the in-flight promise, so the vendor work keeps running. The
// final-state PATCH guards against overwriting a 'cancelled' row — if a user
// cancelled mid-flight, the result is dropped on the floor when it lands.
//
// Errors NEVER propagate out of the worker promise — they're caught,
// classified into params.error_class (defaulting to 'service'), and stored
// alongside .error_detail. The fire-and-forget `.catch(...)` chain at the
// spawn site is a belt-and-suspenders safety net for bugs in the worker
// wrapper itself.
// =============================================================================

/**
 * Soft-cancellation signal. Thrown by updateProgress() when it detects that
 * the job row has been flipped to status='cancelled' (typically by a user
 * hitting DELETE /api/jobs/:id mid-flight). Workers can let this bubble up;
 * the spawnJob wrapper distinguishes it from real failures and skips the
 * usual final-state PATCH so the cancelled flag survives.
 *
 * In v1 we don't have signal handles for in-flight vendor calls, so a
 * cancellation that lands in the middle of a long fetch() will only take
 * effect at the next progress-update boundary. Workers should call
 * updateProgress() between each expensive step (face-detect, vendor call,
 * post-processing) so the check runs frequently enough to be useful.
 */
export class CancellationError extends Error {
  constructor() {
    super("Job cancelled by user");
    this.name = "CancellationError";
  }
}

export interface SpawnJobParams {
  /** Which Darkroom engine owns this job ('develop', 'reveal', 'lock', etc.). */
  engine: string;
  /** Job-type label ('upscale', 'face-swap', 'video-gen', 'chain-run', ...). */
  job_type: string;
  /** Optional source asset uuid — flows into jobs.input_asset_id for audit. */
  input_asset_id?: string | null;
  /** Optional ownership tag — flows into jobs.user_id. */
  user_id?: string | null;
  /** Engine-specific request bag (model, lora, etc.). Stored as jsonb. */
  params: Record<string, any>;
  /**
   * The actual work. Receives the job_id (so it can fan out to vendor APIs
   * with our id stamped on it) and an updateProgress callback (closure over
   * the row so it patches the right one). Returns the success/failure shape
   * that spawnJob unpacks into the final PATCH.
   *
   * The worker should NEVER throw — catch internally and return
   * { error, error_class }. spawnJob's outer .catch() exists only to swallow
   * bugs in the worker wrapper itself; well-behaved workers route their
   * failures through the return-value channel for cleaner classification.
   */
  worker: (
    jobId: string,
    updateProgress: (frac: number, msg?: string) => Promise<void>,
  ) => Promise<{
    output_url?: string;
    output_asset_id?: string;
    error?: string;
    error_class?: string;
  }>;
}

/**
 * Spawn an async engine job. Inserts a row in `jobs`, transitions it to
 * 'running', then fires the worker as a detached promise. Returns the
 * job_id immediately — callers (typically a route handler) Response.json()
 * the id back to the client without awaiting the worker.
 *
 * The deps bag is passed through unchanged from the calling route handler.
 * spawnJob doesn't currently read anything from deps directly — it talks
 * to PostgREST via supaHeaders() — but the param is here so engine workers
 * can reach saveAsset/lookupAssetIdByUrl without re-importing.
 */
export async function spawnJob(
  _deps: any,
  params: SpawnJobParams,
): Promise<{ job_id: string }> {
  if (!SUPABASE_URL) {
    // No DB → no async tracking is possible. Surface as a synthetic error
    // so the caller can fall back to the synchronous path. Throwing keeps
    // the contract honest: a missing DB is a deployment misconfig, not a
    // user-facing fault.
    throw new Error("spawnJob: SUPABASE_URL not configured");
  }

  // 1. Insert the queued row, get the id back via Prefer: return=representation.
  const insertPayload = {
    status: "queued" as const,
    engine: params.engine,
    job_type: params.job_type,
    input_asset_id: params.input_asset_id ?? null,
    user_id: params.user_id ?? null,
    params: params.params || {},
    progress: 0,
  };
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/jobs`, {
    method: "POST",
    headers: { ...supaHeaders(), Prefer: "return=representation" },
    body: JSON.stringify(insertPayload),
  });
  if (!insertRes.ok) {
    const t = await insertRes.text();
    throw new Error(`spawnJob: insert failed ${insertRes.status}: ${t.slice(0, 200)}`);
  }
  const insertData = await insertRes.json();
  const jobId = insertData?.[0]?.id as string | undefined;
  if (!jobId) {
    throw new Error("spawnJob: insert returned no id");
  }

  // 2. Flip to 'running' synchronously so the UI sees the transition before
  //    we hand control back to the request thread. started_at lands here.
  await patchJob(jobId, {
    status: "running",
    started_at: new Date().toISOString(),
    attempts: 1,
  });

  // 3. updateProgress closure — wraps PATCH in try/catch so a transient
  //    network blip on a progress write doesn't kill the actual work.
  //
  //    Soft-cancellation check: BEFORE writing progress, peek at the job's
  //    current status. If a DELETE /api/jobs/:id has flipped it to
  //    'cancelled', throw CancellationError so the worker abandons before
  //    spending any more compute. Vendor calls already in flight will
  //    finish, but their results are dropped on the floor by the wrapper's
  //    catch (no final completed-state PATCH gets written). A status read
  //    fail (network blip) is treated as "not cancelled" — we'd rather
  //    finish a real job than abort one because of a transient hiccup.
  const updateProgress = async (frac: number, msg?: string) => {
    const cancelled = await readJobStatus(jobId).catch(() => null);
    if (cancelled === "cancelled") {
      throw new CancellationError();
    }
    const clamped = Math.max(0, Math.min(1, Number(frac) || 0));
    try {
      await patchJob(jobId, {
        progress: clamped,
        ...(msg !== undefined ? { progress_message: msg } : {}),
      });
    } catch (e) {
      console.error(`[spawnJob:${jobId}] progress patch failed (non-fatal):`, e);
    }
  };

  // 4. Fire and forget. Promise lives on its own; outer .catch() is a
  //    safety net for the worker-wrapper itself, not the worker body
  //    (which is expected to handle its own errors and return { error }).
  void (async () => {
    let result: Awaited<ReturnType<typeof params.worker>>;
    try {
      result = await params.worker(jobId, updateProgress);
    } catch (e: any) {
      // Soft-cancel path: updateProgress threw CancellationError because
      // someone DELETEd /api/jobs/:id mid-flight. The cancelled row is
      // already correct; don't write a 'failed' status over it.
      if (e instanceof CancellationError) {
        console.log(`[spawnJob:${jobId}] cancelled mid-flight`);
        return;
      }
      // Worker threw despite the contract. Classify as 'service' and store.
      result = {
        error: String(e?.message || e),
        error_class: "service",
      };
    }

    // Re-read status before final write so a DELETE /api/jobs/:id
    // (cancellation) that landed AFTER the worker finished isn't clobbered
    // by a late-arriving completed PATCH.
    const current = await readJobStatus(jobId);
    if (current === "cancelled") {
      // Cancelled mid-flight — drop the result on the floor. The row already
      // says cancelled; nothing to update.
      return;
    }

    if (result.error) {
      await patchJob(jobId, {
        status: "failed",
        error_class: result.error_class || "service",
        error_detail: result.error,
        completed_at: new Date().toISOString(),
      }).catch((e) => {
        console.error(`[spawnJob:${jobId}] final-failed PATCH failed:`, e);
      });
      return;
    }

    await patchJob(jobId, {
      status: "completed",
      progress: 1,
      output_asset_id: result.output_asset_id ?? null,
      completed_at: new Date().toISOString(),
    }).catch((e) => {
      console.error(`[spawnJob:${jobId}] final-completed PATCH failed:`, e);
    });
  })().catch((e) => {
    // Should be unreachable — the IIFE above catches its own throws — but
    // the chain catch keeps the process alive if the wrapper itself blows.
    console.error(`[spawnJob:${jobId}] worker wrapper crashed:`, e);
  });

  return { job_id: jobId };
}

// PATCH a single jobs row by id. Caller passes whatever subset of columns
// they want to update; we wrap the network round-trip and surface non-2xx
// as a thrown Error so the spawnJob caller can decide whether to retry.
async function patchJob(id: string, fields: Record<string, any>): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/jobs?id=eq.${encodeFilterValue(id)}`,
    {
      method: "PATCH",
      headers: supaHeaders(),
      body: JSON.stringify(fields),
    },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`patchJob ${id} ${res.status}: ${t.slice(0, 200)}`);
  }
}

// Read just the status column for cancellation-check before the final
// PATCH. Returns null if the row doesn't exist (deleted out from under us)
// or on any error — caller treats null as "proceed with the final write."
async function readJobStatus(id: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/jobs?id=eq.${encodeFilterValue(id)}&select=status&limit=1`,
      { headers: supaHeaders() },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.status ?? null;
  } catch {
    return null;
  }
}

// GET /api/jobs/:id — return the row, 404 if missing.
async function handleJobsGet(jobId: string): Promise<Response> {
  if (!SUPABASE_URL) {
    return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/jobs?id=eq.${encodeFilterValue(jobId)}&limit=1`,
      { headers: supaHeaders() },
    );
    if (!res.ok) {
      const t = await res.text();
      return Response.json(
        { error: "jobs_get_failed", detail: t.slice(0, 300) },
        { status: 500 },
      );
    }
    const rows = await res.json();
    const job = Array.isArray(rows) ? rows[0] : null;
    if (!job) {
      return Response.json({ error: "not_found", job_id: jobId }, { status: 404 });
    }
    return Response.json({ ok: true, job });
  } catch (e: any) {
    return Response.json(
      { error: "jobs_get_error", detail: e?.message || String(e) },
      { status: 500 },
    );
  }
}

// GET /api/jobs?status=&user_id=&limit= — paginated list of jobs.
//
// Both filters optional. status filter is passed through verbatim to
// PostgREST as eq.<value>; PostgREST will reject anything not in the
// CHECK list with 400, which is fine — we don't bother re-validating.
// limit defaults to 50 and is capped at 200 to prevent runaway scans.
async function handleJobsList(url: URL): Promise<Response> {
  if (!SUPABASE_URL) {
    return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  try {
    const status = url.searchParams.get("status");
    const userId = url.searchParams.get("user_id");
    const limitRaw = parseInt(url.searchParams.get("limit") || "50", 10);
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));

    const qs = new URLSearchParams();
    qs.set("order", "created_at.desc");
    qs.set("limit", String(limit));
    if (status) qs.set("status", `eq.${status}`);
    if (userId) qs.set("user_id", `eq.${userId}`);

    const res = await fetch(`${SUPABASE_URL}/rest/v1/jobs?${qs.toString()}`, {
      headers: { ...supaHeaders(), Prefer: "count=exact" },
    });
    if (!res.ok) {
      const t = await res.text();
      return Response.json(
        { error: "jobs_list_failed", detail: t.slice(0, 300) },
        { status: 500 },
      );
    }
    const items = await res.json();
    let count = Array.isArray(items) ? items.length : 0;
    const cr = res.headers.get("Content-Range");
    if (cr) {
      const slash = cr.indexOf("/");
      if (slash >= 0) {
        const totalStr = cr.slice(slash + 1).trim();
        const total = parseInt(totalStr, 10);
        if (Number.isFinite(total)) count = total;
      }
    }
    return Response.json({ items: Array.isArray(items) ? items : [], count });
  } catch (e: any) {
    return Response.json(
      { error: "jobs_list_error", detail: e?.message || String(e) },
      { status: 500 },
    );
  }
}

// DELETE /api/jobs/:id — flip status='cancelled'. The in-flight worker
// can't be killed (no signal handles in v1), so when its result lands the
// final-state PATCH will see status='cancelled' via readJobStatus() and
// skip the overwrite. Effectively: the user's cancellation wins, the
// vendor work runs to completion in the background and is dropped.
//
// Returns 404 if the row doesn't exist, 200 with the updated row otherwise.
async function handleJobsCancel(jobId: string): Promise<Response> {
  if (!SUPABASE_URL) {
    return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/jobs?id=eq.${encodeFilterValue(jobId)}`,
      {
        method: "PATCH",
        headers: { ...supaHeaders(), Prefer: "return=representation" },
        body: JSON.stringify({
          status: "cancelled",
          completed_at: new Date().toISOString(),
        }),
      },
    );
    if (!res.ok) {
      const t = await res.text();
      return Response.json(
        { error: "jobs_cancel_failed", detail: t.slice(0, 300) },
        { status: 500 },
      );
    }
    const rows = await res.json();
    const job = Array.isArray(rows) ? rows[0] : null;
    if (!job) {
      return Response.json({ error: "not_found", job_id: jobId }, { status: 404 });
    }
    return Response.json({ ok: true, job });
  } catch (e: any) {
    return Response.json(
      { error: "jobs_cancel_error", detail: e?.message || String(e) },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Enhancor webhook handler — POST /api/enhancor/webhook
//
// Purpose:   Receive job-completion callbacks from Enhancor and update the
//            matching jobs row.
// Inputs:    JSON body { request_id: string, result: string, status: string,
//                        cost?: number }
// Outputs:   200 { ok: true } on success or idempotent no-op
//            404 { error: "not_found" } when no matching job row exists
//            400 { error: "invalid_body" } when request_id is absent
//            500 on PostgREST errors
// Side effects: PATCHes jobs row: status='completed', webhook_received_at=now(),
//              result_url=result, cost_credits=cost (when present)
// Failure behavior: non-2xx PostgREST → 500 with detail; JSON parse error → 400
//
// Idempotency: the handler checks webhook_received_at before writing. If the
// column is already set this request_id was previously processed — return 200
// immediately without re-patching. This is safe with Enhancor's at-least-once
// delivery model: a second delivery of the same callback is a no-op, not a 409.
// ---------------------------------------------------------------------------
async function handleEnhancorWebhook(req: Request): Promise<Response> {
  if (!SUPABASE_URL) {
    return Response.json({ error: "supabase_unconfigured" }, { status: 500 });
  }

  // Parse body — must be valid JSON with a request_id field.
  let body: { request_id?: string; result?: string; status?: string; cost?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_body", detail: "expected JSON" }, { status: 400 });
  }

  const { request_id, result, cost } = body;
  if (!request_id || typeof request_id !== "string") {
    return Response.json(
      { error: "invalid_body", detail: "request_id is required" },
      { status: 400 },
    );
  }

  // Fetch the matching job row — vendor='enhancor' AND vendor_request_id=request_id.
  // PostgREST filter string uses eq.<value> for equality.
  let existingRow: { id: string; webhook_received_at: string | null } | null = null;
  try {
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jobs?vendor=eq.enhancor&vendor_request_id=eq.${encodeFilterValue(request_id)}&select=id,webhook_received_at&limit=1`,
      { headers: supaHeaders() },
    );
    if (!fetchRes.ok) {
      const t = await fetchRes.text();
      console.error(`[enhancor-webhook] lookup failed ${fetchRes.status}: ${t.slice(0, 200)}`);
      return Response.json(
        { error: "lookup_failed", detail: t.slice(0, 200) },
        { status: 500 },
      );
    }
    const rows = await fetchRes.json();
    existingRow = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch (e: any) {
    return Response.json(
      { error: "lookup_error", detail: e?.message || String(e) },
      { status: 500 },
    );
  }

  // 404 when no matching job row — log and surface so Enhancor can alert.
  if (!existingRow) {
    console.warn(
      `[enhancor-webhook] no job row found for vendor_request_id=${request_id}`,
    );
    return Response.json(
      { error: "not_found", request_id },
      { status: 404 },
    );
  }

  // Idempotency guard: if webhook_received_at is already set, this delivery is
  // a duplicate. Return 200 (correct — not 409) so Enhancor stops retrying.
  if (existingRow.webhook_received_at !== null) {
    console.log(
      `[enhancor-webhook] duplicate delivery for request_id=${request_id} (job=${existingRow.id}) — no-op`,
    );
    return Response.json({ ok: true, idempotent: true, job_id: existingRow.id });
  }

  // Build the PATCH body. cost_credits is only written when present in payload.
  const patch: Record<string, unknown> = {
    status: "completed",
    webhook_received_at: new Date().toISOString(),
    result_url: result ?? null,
  };
  if (typeof cost === "number") {
    patch.cost_credits = cost;
  }

  // PATCH via PostgREST — filter by id (already resolved above) for precision.
  try {
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jobs?id=eq.${encodeFilterValue(existingRow.id)}`,
      {
        method: "PATCH",
        headers: { ...supaHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify(patch),
      },
    );
    if (!patchRes.ok) {
      const t = await patchRes.text();
      console.error(
        `[enhancor-webhook] patch failed ${patchRes.status} (job=${existingRow.id}): ${t.slice(0, 200)}`,
      );
      return Response.json(
        { error: "patch_failed", detail: t.slice(0, 200) },
        { status: 500 },
      );
    }
  } catch (e: any) {
    return Response.json(
      { error: "patch_error", detail: e?.message || String(e) },
      { status: 500 },
    );
  }

  console.log(
    `[enhancor-webhook] processed request_id=${request_id} → job=${existingRow.id} status=completed`,
  );
  return Response.json({ ok: true, job_id: existingRow.id });
}

// ---------------------------------------------------------------------------
// Shared helper — insert a jobs row for a queued Enhancor job and return
// { request_id, job_id }.
//
// Purpose:   After submitting to the Enhancor API, record the job in
//            PostgREST so the webhook handler can correlate the callback.
// Inputs:    requestId from the Enhancor API, engine id for metadata.
// Outputs:   JSON { request_id, job_id } with HTTP 200.
// Side effects: POST to rest/v1/jobs (single row insert).
// Failure behavior: non-2xx PostgREST → 500 with detail message.
// ---------------------------------------------------------------------------
async function insertEnhancorJobRow(
  requestId: string,
  engineId: string,
): Promise<{ jobId: string }> {
  if (!SUPABASE_URL) {
    throw new Error("SUPABASE_URL not configured");
  }
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/jobs`, {
    method: "POST",
    headers: { ...supaHeaders(), Prefer: "return=representation" },
    body: JSON.stringify({
      vendor: "enhancor",
      vendor_request_id: requestId,
      status: "pending",
      engine: engineId,
      job_type: "enhancor",
      params: {},
      progress: 0,
    }),
  });
  if (!insertRes.ok) {
    const t = await insertRes.text();
    throw new Error(`jobs insert failed ${insertRes.status}: ${t.slice(0, 200)}`);
  }
  const rows = await insertRes.json();
  const jobId: string | undefined = rows?.[0]?.id;
  if (!jobId) {
    throw new Error("jobs insert returned no id");
  }
  return { jobId };
}

/** Build the enhancor webhook URL from the incoming request's host. */
function enhancorWebhookUrl(req: Request): string {
  const reqUrl = new URL(req.url);
  const proto = reqUrl.protocol; // 'http:' or 'https:'
  const host = reqUrl.host;
  return `${proto}//${host}/api/enhancor/webhook`;
}

// ---------------------------------------------------------------------------
// POST /api/enhancor/skin
//
// Purpose:   Submit a realistic-skin enhancement job (queue pattern).
// Inputs:    JSON body: img_url (required), model_version, skin_realism_Level,
//            skin_refinement_level, portrait_depth, output_resolution (v3),
//            mask_image_url (v3), mask_expand (v3), plus 19 area-lock booleans.
// Outputs:   { request_id, job_id }
// Side effects: Enhancor API call + jobs row insert.
// Failure behavior: missing img_url → 400; vendor/DB error → 500.
// ---------------------------------------------------------------------------
async function handleEnhancorSkin(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const img_url = body.img_url as string | undefined;
  if (!img_url || typeof img_url !== "string") {
    return Response.json({ error: "img_url is required" }, { status: 400 });
  }

  try {
    const webhookUrl = enhancorWebhookUrl(req);
    const { requestId } = await skin({ ...(body as any), img_url, webhookUrl });
    const { jobId } = await insertEnhancorJobRow(requestId, "skin-pro");
    return Response.json({ request_id: requestId, job_id: jobId });
  } catch (e: any) {
    console.error("[enhancor/skin] error:", e?.message || e);
    return Response.json(
      { error: e?.message || "enhancor/skin failed" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/enhancor/lens
//
// Purpose:   Submit a Kora Pro (lens) generation job (queue pattern).
// Inputs:    JSON body: prompt (required), img_url?, image_size?,
//            generation_mode?, is_uncensored?, is_hyper_real?.
// Outputs:   { request_id, job_id }
// Side effects: Enhancor API call + jobs row insert.
// Failure behavior: missing prompt → 400; vendor/DB error → 500.
// ---------------------------------------------------------------------------
async function handleEnhancorLens(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const prompt = body.prompt as string | undefined;
  if (!prompt || typeof prompt !== "string") {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  try {
    const webhookUrl = enhancorWebhookUrl(req);
    const { requestId } = await lens({ ...(body as any), prompt, webhookUrl });
    const { jobId } = await insertEnhancorJobRow(requestId, "lens-pro");
    return Response.json({ request_id: requestId, job_id: jobId });
  } catch (e: any) {
    console.error("[enhancor/lens] error:", e?.message || e);
    return Response.json(
      { error: e?.message || "enhancor/lens failed" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/enhancor/lens-cinema
//
// Purpose:   Submit a Kora Pro Cinema generation job (queue pattern).
// Inputs:    Same payload as /api/enhancor/lens; model is injected as
//            kora_pro_cinema internally.
// Outputs:   { request_id, job_id }
// Side effects: Enhancor API call + jobs row insert.
// Failure behavior: missing prompt → 400; vendor/DB error → 500.
// ---------------------------------------------------------------------------
async function handleEnhancorLensCinema(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const prompt = body.prompt as string | undefined;
  if (!prompt || typeof prompt !== "string") {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  try {
    const webhookUrl = enhancorWebhookUrl(req);
    const { requestId } = await lensCinema({ ...(body as any), prompt, webhookUrl });
    const { jobId } = await insertEnhancorJobRow(requestId, "lens-cinema");
    return Response.json({ request_id: requestId, job_id: jobId });
  } catch (e: any) {
    console.error("[enhancor/lens-cinema] error:", e?.message || e);
    return Response.json(
      { error: e?.message || "enhancor/lens-cinema failed" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/enhancor/lens-reality
//
// Purpose:   Submit a Kora Reality generation job (queue pattern).
// Inputs:    JSON body: prompt (required), image_size?, generation_mode?.
// Outputs:   { request_id, job_id }
// Side effects: Enhancor API call + jobs row insert.
// Failure behavior: missing prompt → 400; vendor/DB error → 500.
// ---------------------------------------------------------------------------
async function handleEnhancorLensReality(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const prompt = body.prompt as string | undefined;
  if (!prompt || typeof prompt !== "string") {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  try {
    const webhookUrl = enhancorWebhookUrl(req);
    const { requestId } = await lensReality({ ...(body as any), prompt, webhookUrl });
    const { jobId } = await insertEnhancorJobRow(requestId, "lens-reality");
    return Response.json({ request_id: requestId, job_id: jobId });
  } catch (e: any) {
    console.error("[enhancor/lens-reality] error:", e?.message || e);
    return Response.json(
      { error: e?.message || "enhancor/lens-reality failed" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/enhancor/develop
//
// Purpose:   Submit a detailed-enhancement (develop) job (queue pattern).
// Inputs:    JSON body: img_url (required).
// Outputs:   { request_id, job_id }
// Side effects: Enhancor API call + jobs row insert.
// Failure behavior: missing img_url → 400; vendor/DB error → 500.
// ---------------------------------------------------------------------------
async function handleEnhancorDevelop(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const img_url = body.img_url as string | undefined;
  if (!img_url || typeof img_url !== "string") {
    return Response.json({ error: "img_url is required" }, { status: 400 });
  }

  try {
    const webhookUrl = enhancorWebhookUrl(req);
    const { requestId } = await develop({ img_url, webhookUrl });
    const { jobId } = await insertEnhancorJobRow(requestId, "develop");
    return Response.json({ request_id: requestId, job_id: jobId });
  } catch (e: any) {
    console.error("[enhancor/develop] error:", e?.message || e);
    return Response.json(
      { error: e?.message || "enhancor/develop failed" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/enhancor/sharpen-portrait
//
// Purpose:   Submit a portrait-upscaler job (queue pattern).
// Inputs:    JSON body: img_url (required), mode ('fast' | 'professional').
// Outputs:   { request_id, job_id }
// Side effects: Enhancor API call + jobs row insert.
// Failure behavior: missing img_url or invalid mode → 400; vendor/DB error → 500.
// ---------------------------------------------------------------------------
async function handleEnhancorSharpenPortrait(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const img_url = body.img_url as string | undefined;
  if (!img_url || typeof img_url !== "string") {
    return Response.json({ error: "img_url is required" }, { status: 400 });
  }

  const mode = (body.mode as string | undefined) ?? "fast";
  if (mode !== "fast" && mode !== "professional") {
    return Response.json(
      { error: "mode must be 'fast' or 'professional'" },
      { status: 400 },
    );
  }

  try {
    const webhookUrl = enhancorWebhookUrl(req);
    const { requestId } = await sharpenPortrait({ img_url, mode, webhookUrl });
    const { jobId } = await insertEnhancorJobRow(requestId, "sharpen-portrait");
    return Response.json({ request_id: requestId, job_id: jobId });
  } catch (e: any) {
    console.error("[enhancor/sharpen-portrait] error:", e?.message || e);
    return Response.json(
      { error: e?.message || "enhancor/sharpen-portrait failed" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/enhancor/sharpen
//
// Purpose:   Submit a general image-upscaler job (queue pattern).
// Inputs:    JSON body: img_url (required).
// Outputs:   { request_id, job_id }
// Side effects: Enhancor API call + jobs row insert.
// Failure behavior: missing img_url → 400; vendor/DB error → 500.
// ---------------------------------------------------------------------------
async function handleEnhancorSharpen(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const img_url = body.img_url as string | undefined;
  if (!img_url || typeof img_url !== "string") {
    return Response.json({ error: "img_url is required" }, { status: 400 });
  }

  try {
    const webhookUrl = enhancorWebhookUrl(req);
    const { requestId } = await sharpen({ img_url, webhookUrl });
    const { jobId } = await insertEnhancorJobRow(requestId, "sharpen");
    return Response.json({ request_id: requestId, job_id: jobId });
  } catch (e: any) {
    console.error("[enhancor/sharpen] error:", e?.message || e);
    return Response.json(
      { error: e?.message || "enhancor/sharpen failed" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// GET /api/enhancor/health
//
// Purpose:   Ping each Enhancor endpoint with a dry status call using a
//            known-invalid request_id to determine reachability. Returns a
//            per-model status object showing ok, latency_ms, and any error.
// Inputs:    (none)
// Outputs:   { [model]: { ok: boolean, latency_ms: number, error?: string } }
// Side effects: one getStatus call per model slug (each is a POST to Enhancor
//               /api/<slug>/v1/status). Expected to return a non-2xx or a
//               "not found" body — we treat a network response of any kind as
//               "reachable" and a thrown network error as "unreachable".
// Failure behavior: individual slugs can fail independently; all 6 results
//                   are always returned, with ok=false + error set on failures.
// ---------------------------------------------------------------------------
async function handleEnhancorHealth(): Promise<Response> {
  const slugs = [
    "realistic-skin",
    "kora",
    "kora-reality",
    "detailed",
    "upscaler",
    "image-upscaler",
  ] as const;

  const PROBE_ID = "health-check-probe-00000000";

  const results = await Promise.all(
    slugs.map(async (slug) => {
      const t0 = Date.now();
      try {
        // A status call with a synthetic id will fail at the vendor level
        // (unknown request_id) but that's fine — a response of any kind
        // means the endpoint is reachable. We catch here and mark ok=true
        // as long as the call doesn't throw a network error.
        await enhancorGetStatus(slug, PROBE_ID);
        return { slug, ok: true, latency_ms: Date.now() - t0 };
      } catch (e: any) {
        const msg: string = e?.message || String(e);
        // Distinguish a network failure (unreachable) from an API-level
        // error (reachable but rejected). API errors contain "HTTP" in
        // our error format from apiPost(); network failures do not.
        const reachable = msg.includes("HTTP");
        return {
          slug,
          ok: reachable,
          latency_ms: Date.now() - t0,
          error: msg,
        };
      }
    }),
  );

  const output: Record<string, { ok: boolean; latency_ms: number; error?: string }> = {};
  for (const r of results) {
    const { slug, ...rest } = r;
    output[slug] = rest;
  }

  return Response.json(output);
}

// =============================================================================
// /api/replay-chain helpers — build the edit sequence + execute it on a new
// source. Wired by the route handler near /api/asset-chain above; kept down
// here so the route handler reads top-down without dragging the whole
// implementation inline.
//
// Algorithm (matches the spec for darkroom.catalog.replay-edit-chain):
//   1. buildEditSequenceFromChain — fetch the chain's nodes via PostgREST
//      (same shape as /api/asset-chain), pick the root → most-recent-leaf
//      path, return that as a flat list of (engine, prompt, params, action)
//      steps with the root excluded (the root is the SOURCE, not an edit).
//   2. executeEditSequence — start from the new source URL, apply each
//      step in order via callEngineByName(), rehosting intermediate
//      results so URLs survive vendor expiry. Unknown / non-trivial
//      engines (replay, topaz, magnific, p-image-edit, preset:*, etc.)
//      are skipped with a console warning so a partial/best-effort replay
//      still produces something the user can review.
// =============================================================================

type ReplayEditStep = {
  engine: string;
  prompt: string;
  params: Record<string, any>;
  edit_action: string | null;
  asset_type: string | null;
  source_url: string | null;
  node_id: string | null;
};

async function buildEditSequenceFromChain(
  chainRootId: string,
): Promise<ReplayEditStep[]> {
  if (!SUPABASE_URL) throw new Error("supabase not configured");
  const headers = supaHeaders();

  // 1. Fetch the root row (= the seed of the chain to replay).
  const rootResp = await fetch(
    `${SUPABASE_URL}/rest/v1/assets?id=eq.${encodeFilterValue(chainRootId)}&select=*&limit=1`,
    { headers },
  );
  if (!rootResp.ok) throw new Error(`chain root lookup ${rootResp.status}`);
  const rootRows = await rootResp.json();
  const root = Array.isArray(rootRows) ? rootRows[0] : null;
  if (!root) throw new Error("chain root not found");

  // 2. BFS down through parent_id links to collect every descendant. Bound
  //    the depth (10) and per-frontier fanout (200) so a degenerate chain
  //    can't sink the request thread.
  const allNodes: any[] = [root];
  const seen = new Set<string>([root.id]);
  let frontier: string[] = [root.id];
  let depth = 0;
  while (frontier.length && depth < 10) {
    const inList = frontier.map((x) => `"${x}"`).join(",");
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/assets?parent_id=in.(${encodeURIComponent(inList)})&select=*&limit=200`,
      { headers },
    );
    if (!r.ok) break;
    const rows = await r.json();
    const fresh = (Array.isArray(rows) ? rows : []).filter(
      (n: any) => n && n.id && !seen.has(n.id),
    );
    if (!fresh.length) break;
    for (const n of fresh) {
      allNodes.push(n);
      seen.add(n.id);
    }
    frontier = fresh.map((n: any) => n.id);
    depth++;
  }

  // 3. Pick the canonical replay path: ROOT → most-recent leaf (highest
  //    created_at among nodes with no children in the collected set).
  //    For a non-branched chain this is just the linear sequence root → tip.
  const childIdsByParent = new Map<string, string[]>();
  for (const n of allNodes) {
    if (n.parent_id) {
      const arr = childIdsByParent.get(n.parent_id) || [];
      arr.push(n.id);
      childIdsByParent.set(n.parent_id, arr);
    }
  }
  const leaves = allNodes.filter((n) => !childIdsByParent.has(n.id));
  if (!leaves.length) return []; // root is the only node — nothing to replay
  leaves.sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || "")),
  );
  const leaf = leaves[0];

  // 4. Walk leaf → root via parent_id, then reverse to get root → leaf.
  const byId = new Map<string, any>(allNodes.map((n) => [n.id, n]));
  const path: any[] = [leaf];
  let cur: any = leaf;
  let walkGuard = 0;
  while (cur?.parent_id && byId.has(cur.parent_id) && walkGuard < 64) {
    cur = byId.get(cur.parent_id);
    path.unshift(cur);
    if (cur.id === root.id) break;
    walkGuard++;
  }

  // 5. Convert nodes → edit steps. Skip the first element (the root —
  //    that's the SOURCE for the original chain, not an edit step). Pull
  //    engine-specific params out of metadata.params if present, falling
  //    back to {} so callEngineByName never trips on undefined.
  return path.slice(1).map((n) => {
    const md = (n && n.metadata && typeof n.metadata === "object") ? n.metadata : {};
    const params = (md.params && typeof md.params === "object") ? md.params : {};
    return {
      engine: String(n.engine || "lens"),
      prompt: String(n.prompt || ""),
      params,
      edit_action: n.edit_action ?? null,
      asset_type: n.asset_type ?? null,
      source_url: n.source_url ?? null,
      node_id: n.id ?? null,
    } as ReplayEditStep;
  });
}

async function executeEditSequence(
  initialUrl: string,
  sequence: ReplayEditStep[],
  updateProgress: (frac: number, msg?: string) => Promise<void>,
): Promise<{
  final_url: string;
  intermediate_urls: string[];
  steps_applied: number;
  steps_skipped: number;
}> {
  const { uploadToStorage, buildUploadPath } = await import("../supabase");
  // Local rehost helper — mirrors the one in generation.ts but inlined here
  // so we don't widen this file's import surface. Falls back to the vendor
  // URL on any failure so a flaky storage hop doesn't kill the chain.
  const rehost = async (vendorUrl: string): Promise<string> => {
    if (!vendorUrl) return vendorUrl;
    try {
      const resp = await fetch(vendorUrl);
      if (!resp.ok) return vendorUrl;
      const buf = Buffer.from(await resp.arrayBuffer());
      const ct = resp.headers.get("content-type") || "image/png";
      return await uploadBufferToStorage(
        buf,
        ct,
        buildUploadPath,
        uploadToStorage,
        "replay-chain",
      );
    } catch (e) {
      console.error("[replay-chain] rehost failed, using vendor URL:", e);
      return vendorUrl;
    }
  };

  let currentUrl = initialUrl;
  const intermediates: string[] = [];
  let stepsApplied = 0;
  let stepsSkipped = 0;

  for (let i = 0; i < sequence.length; i++) {
    const step = sequence[i];
    const frac = sequence.length === 0 ? 1 : i / sequence.length;
    await updateProgress(
      frac,
      `Step ${i + 1}/${sequence.length}: ${step.engine}${step.edit_action ? ` (${step.edit_action})` : ""}`,
    );

    // Engine dispatch. callEngineByName covers lens / glance / strip / eye
    // — the four "free-form prompt + image" engines we have inner helpers
    // for. Anything else (replay, topaz, magnific, p-image-edit, preset:*,
    // brush without a mask, etc.) is skipped with a console warning so
    // partial replays still produce something usable. Brush specifically
    // requires a mask we don't have on the new source, so it stays skipped
    // until we can resolve the mask question.
    const engineKey = String(step.engine || "").toLowerCase().trim();
    const replayable = engineKey === "lens"
      || engineKey === "grok"
      || engineKey === "glance"
      || engineKey === "nano"
      || engineKey === "strip"
      || engineKey === "pedit"
      || engineKey === "p-edit"
      || engineKey === "eye"
      || engineKey === "gpt-image-2";
    if (!replayable) {
      console.warn(
        `[replay-chain] skipping step ${i + 1} with non-replayable engine: ${step.engine}`,
      );
      stepsSkipped++;
      continue;
    }

    // Normalize aliases callEngineByName doesn't know about.
    const dispatchEngine =
      engineKey === "grok" ? "lens"
      : engineKey === "nano" ? "glance"
      : engineKey === "pedit" || engineKey === "p-edit" ? "strip"
      : engineKey === "gpt-image-2" ? "eye"
      : engineKey;

    if (!step.prompt) {
      // Some preset/template flows leave prompt empty — without the prompt
      // the replay step has nothing to drive it, so skip it the same way
      // we skip an unknown engine.
      console.warn(
        `[replay-chain] skipping step ${i + 1} (${step.engine}): no prompt`,
      );
      stepsSkipped++;
      continue;
    }

    let resultUrl: string;
    try {
      resultUrl = await callEngineByName(dispatchEngine, {
        imageUrl: currentUrl,
        prompt: step.prompt,
      });
    } catch (e: any) {
      throw new Error(
        `Step ${i + 1}/${sequence.length} (${step.engine}) failed: ${String(e?.message || e).slice(0, 200)}`,
      );
    }
    if (!resultUrl) {
      throw new Error(`Step ${i + 1}/${sequence.length} (${step.engine}) returned no URL`);
    }

    // Rehost so the replayed chain's intermediates survive vendor expiry.
    const stable = await rehost(resultUrl);
    intermediates.push(stable);
    currentUrl = stable;
    stepsApplied++;
  }

  await updateProgress(1, `Replay complete: ${stepsApplied} applied, ${stepsSkipped} skipped`);

  return {
    final_url: currentUrl,
    intermediate_urls: intermediates,
    steps_applied: stepsApplied,
    steps_skipped: stepsSkipped,
  };
}

// =============================================================================
// /api/chains/run helpers — load a saved chain by slug + dispatch the run.
//
// Saved chains live in the `presets` table with preset_type='chain'. The
// `chain_definition` jsonb column accepts either { steps: [...] } or a bare
// array of steps. Each step has { engine, prompt, params? }. handleChainsRun
// validates the shape, builds a ReplayEditStep[]-compatible sequence, and
// dispatches a spawnJob() that pipes the steps through executeEditSequence.
//
// Why reuse executeEditSequence: same engine dispatch logic, same rehost +
// intermediate tracking, same skip-non-replayable behavior. Forward-declared
// chains and replayed-asset chains both flatten down to "list of edit steps
// applied to a starting URL" — once the sequence is built, the rest is
// identical.
// =============================================================================

async function loadChainBySlug(
  slug: string,
): Promise<{ definition: any[]; name: string } | null> {
  if (!SUPABASE_URL) return null;
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/presets?slug=eq.${encodeFilterValue(slug)}&preset_type=eq.chain&select=id,name,chain_definition&limit=1`,
    { headers: supaHeaders() },
  );
  if (!r.ok) return null;
  const rows = await r.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  // chain_definition can be either { steps: [...] } or a bare array.
  const def = row.chain_definition;
  const steps = Array.isArray(def)
    ? def
    : Array.isArray(def?.steps)
      ? def.steps
      : [];
  return { definition: steps, name: row.name || slug };
}

async function handleChainsRun(req: Request, deps: any): Promise<Response> {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json_body" }, { status: 400 });
    }
    const sourceUrl = String(body.source_url || "").trim();
    if (!sourceUrl) {
      return Response.json({ error: "source_url required" }, { status: 400 });
    }

    // Resolve the chain steps — either inline (Mode A) or by slug (Mode B).
    let chainSteps: any[] = [];
    let chainName = "inline-chain";
    let chainSlug: string | null = null;
    if (body.chain_definition !== undefined && body.chain_definition !== null) {
      const def = body.chain_definition;
      chainSteps = Array.isArray(def)
        ? def
        : Array.isArray(def?.steps)
          ? def.steps
          : [];
    } else if (body.chain_id) {
      chainSlug = String(body.chain_id);
      const loaded = await loadChainBySlug(chainSlug);
      if (!loaded) {
        return Response.json({ error: "chain not found", chain_id: chainSlug }, { status: 404 });
      }
      chainSteps = loaded.definition;
      chainName = loaded.name;
    } else {
      return Response.json(
        { error: "chain_definition or chain_id required" },
        { status: 400 },
      );
    }

    if (!Array.isArray(chainSteps) || !chainSteps.length) {
      return Response.json({ error: "chain has no steps" }, { status: 400 });
    }

    // Validate step shape up-front so a malformed chain fails synchronously
    // (4xx) instead of getting buried in a job-row failure the user has to
    // poll for.
    for (let i = 0; i < chainSteps.length; i++) {
      const s = chainSteps[i];
      if (!s || typeof s !== "object" || !s.engine || !s.prompt) {
        return Response.json(
          { error: `step ${i + 1} missing engine or prompt`, step_index: i },
          { status: 400 },
        );
      }
    }

    // Build a ReplayEditStep[]-compatible sequence. executeEditSequence reads
    // engine / prompt / edit_action; node_id + source_url are unused at run
    // time but kept on the type for future telemetry. params_overrides on the
    // request body shallow-merges over the saved-chain step.params (Mode B
    // only — inline chains already carry their own params).
    const overrides =
      body.params_overrides && typeof body.params_overrides === "object"
        ? body.params_overrides
        : null;
    const sequence = chainSteps.map((s: any) => {
      const baseParams = s.params && typeof s.params === "object" ? s.params : {};
      const mergedParams =
        chainSlug && overrides ? { ...baseParams, ...overrides } : baseParams;
      return {
        engine: String(s.engine),
        prompt: String(s.prompt),
        params: mergedParams,
        edit_action: s.edit_action ?? null,
        asset_type: s.asset_type ?? "edit",
        source_url: null,
        node_id: null,
      };
    });

    const stepCount = sequence.length;

    const { job_id } = await spawnJob(deps, {
      engine: "chain",
      job_type: "chain-run",
      user_id: body.user_id ?? null,
      params: {
        chain_name: chainName,
        chain_id: chainSlug,
        source_url: sourceUrl,
        step_count: stepCount,
      },
      worker: async (jobId, updateProgress) => {
        try {
          const result = await executeEditSequence(sourceUrl, sequence, updateProgress);

          // Catalog the final asset. parent_id chains back to whatever asset
          // was at source_url (so the chain renders as a branch off the
          // source in the history graph). saveAsset failure is non-fatal —
          // the job still completed.
          let outputAssetId: string | null = null;
          try {
            const parentId = await (deps as any).lookupAssetIdByUrl?.(sourceUrl);
            outputAssetId = await (deps as any).saveAsset?.({
              asset_type: "edit",
              source_url: result.final_url,
              engine: "chain",
              edit_action: "chain-run",
              prompt: `Chain: ${chainName} (${stepCount} steps)`,
              parent_id: parentId || null,
              metadata: {
                chain_name: chainName,
                chain_id: chainSlug,
                chain_step_count: stepCount,
                steps_applied: result.steps_applied,
                steps_skipped: result.steps_skipped,
                intermediates: result.intermediate_urls,
                steps: sequence.map((s) => ({
                  engine: s.engine,
                  prompt: s.prompt,
                  params: s.params,
                })),
                source_url: sourceUrl,
                job_id: jobId,
              },
              tags: ["chain"],
            });
          } catch (e) {
            console.error("[chains/run] saveAsset failed (non-fatal):", e);
          }

          return {
            output_url: result.final_url,
            output_asset_id: outputAssetId || undefined,
          };
        } catch (e: any) {
          if (e instanceof CancellationError) throw e;
          return {
            error: String(e?.message || e),
            error_class: "service",
          };
        }
      },
    });

    return Response.json({
      ok: true,
      job_id,
      step_count: stepCount,
      chain_name: chainName,
    });
  } catch (e: any) {
    return Response.json(
      { error: e?.message || "chains/run failed" },
      { status: 500 },
    );
  }
}

// =============================================================================
// Reveal (Magnific) — async route + preset registry + preset route.
//
// The Reveal engine wraps Freepik's image-upscaler endpoint (the same one the
// synchronous /api/upscale handler in media.ts calls). The preset registry
// gives every recurring use case a curated prompt + creativity/hdr/resemblance
// envelope. The async variant flips the call from blocking to spawnJob — the
// 30-90s vendor poll runs as a detached promise and the UI's Active Jobs
// panel (wave 28) picks the job up via GET /api/jobs/:id.
//
// Why a registry: Reveal-by-prompt is sensitive — small wording shifts move
// the result from "preserves identity" to "plastic skin." The registry locks
// proven prompts behind slugs so callers don't have to reinvent them.
//
// Note on the creativity / hdr / resemblance numbers: Freepik's upscaler
// endpoint accepts { image, prompt, scale_factor }, NOT the older Magnific
// triplet of (creativity, hdr, resemblance). We still record the curated
// numbers in the saved asset's metadata so a future engine swap (true
// Magnific / Visual Electric / etc.) can read them back, and so the UI can
// display the preset's intent. The active levers in v1 are the prompt and
// the scale.
// =============================================================================

interface RevealPreset {
  slug: string;
  name: string;
  description: string;
  prompt: string;
  /** Curated Magnific-style envelope. Recorded in metadata; not all are
   *  consumed by the current upscaler endpoint. */
  creativity: number;
  hdr: number;
  resemblance: number;
}

const REVEAL_PRESETS: Record<string, RevealPreset> = {
  "portrait-fidelity": {
    slug: "portrait-fidelity",
    name: "Portrait Fidelity",
    description: "Identity-locked portrait upscale. Preserves eye color, pore micro-texture, lashes.",
    prompt:
      "ultra high fidelity portrait upscale, preserve eye color and pupil detail, render skin pore micro-texture, eyelash separation, sharpen iris pattern, photorealistic, no plastic skin, preserve identity exactly",
    creativity: 0.3,
    hdr: 5,
    resemblance: 60,
  },
  "skin-luxury": {
    slug: "skin-luxury",
    name: "Skin Luxury",
    description: "Beauty editorial: render fine pore detail, preserve makeup and freckles.",
    prompt:
      "luxury beauty editorial upscale, render fine pore detail, preserve makeup texture exactly, subtle natural skin sheen, no over-smoothing, no plastic look, preserve all freckles and skin asymmetry",
    creativity: 0.35,
    hdr: 6,
    resemblance: 70,
  },
  "fabric-weave": {
    slug: "fabric-weave",
    name: "Fabric Weave",
    description: "Render thread weave + fold geometry. Photorealistic fabric micro-detail.",
    prompt:
      "high fidelity fabric texture upscale, render thread weave, preserve fold geometry exactly, micro-detail in pattern and weave, photorealistic",
    creativity: 0.4,
    hdr: 5,
    resemblance: 60,
  },
  "editorial-print": {
    slug: "editorial-print",
    name: "Editorial Print",
    description: "Magazine-grade sharpening. Deep blacks, gallery detail, no over-sharpen halos.",
    prompt:
      "magazine editorial upscale, sharp render, deep blacks, gallery-quality detail, no over-sharpening halos, preserve composition exactly",
    creativity: 0.3,
    hdr: 5,
    resemblance: 65,
  },
  "landscape-wide": {
    slug: "landscape-wide",
    name: "Landscape Wide",
    description: "Foliage detail and atmospheric depth without fake-HDR clipping.",
    prompt:
      "natural landscape upscale, render foliage detail, atmospheric depth, preserve sky and color grading exactly, photorealistic, no fake HDR clipping",
    creativity: 0.45,
    hdr: 4,
    resemblance: 55,
  },
  "product-glow": {
    slug: "product-glow",
    name: "Product Glow",
    description: "Studio product upscale. Reflective surface micro-detail, sharp edges.",
    prompt:
      "studio product upscale, render reflective surface micro-detail, preserve lighting exactly, sharp edges, photorealistic",
    creativity: 0.35,
    hdr: 5,
    resemblance: 65,
  },
};

/**
 * Result of a single Magnific (Freepik image-upscaler) call. Always returns a
 * Supabase-rehosted URL — vendor URLs are short-lived and would 404 by the
 * time the async job's row is read.
 */
interface MagnificCallResult {
  url: string;
  scale: number;
  mode: "creative" | "faithful";
  prompt: string;
}

/**
 * Submit an image to Freepik's upscaler endpoint, poll for completion, and
 * rehost the result to Supabase storage. Throws on failure — callers wrap
 * this in spawnJob's worker so the throw surfaces as a job-row failure.
 *
 * mode='creative' → image-upscaler endpoint (accepts a prompt; better detail
 * generation, slight identity drift risk).
 * mode='faithful' → image-upscaler-precision endpoint (no prompt; identity-safe).
 */
async function callMagnific(args: {
  imageUrl: string;
  scale: number;
  mode: "creative" | "faithful";
  prompt: string;
  onPoll?: () => Promise<void>;
}): Promise<MagnificCallResult> {
  const { imageUrl, scale, mode, prompt, onPoll } = args;
  const freepikHeaders = {
    "x-freepik-api-key": env("FREEPIK_API_KEY"),
    "Content-Type": "application/json",
  };

  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) {
    throw new Error(`reveal: source fetch ${imgResp.status}`);
  }
  const imgBuf = await imgResp.arrayBuffer();
  const b64 = Buffer.from(imgBuf).toString("base64");
  const b64Data = `data:image/jpeg;base64,${b64}`;

  let endpoint: string;
  let payload: Record<string, any>;
  if (mode === "creative") {
    endpoint = "image-upscaler";
    payload = {
      image: b64Data,
      prompt,
      scale_factor: `${scale}x`,
    };
  } else {
    endpoint = "image-upscaler-precision";
    payload = {
      image: b64Data,
      scale_factor: `${scale}x`,
    };
  }

  const submitRes = await fetch(`https://api.freepik.com/v1/ai/${endpoint}`, {
    method: "POST",
    headers: freepikHeaders,
    body: JSON.stringify(payload),
  });

  if (!submitRes.ok) {
    const err = await submitRes.text();
    throw new Error(`Magnific submit ${submitRes.status}: ${err.slice(0, 200)}`);
  }

  const submitData = await submitRes.json();
  let resultUrl = "";

  if (submitData.data?.status === "COMPLETED" && submitData.data?.generated?.length > 0) {
    const gen = submitData.data.generated[0];
    resultUrl = typeof gen === "string" ? gen : gen?.url || "";
  } else if (submitData.data?.task_id) {
    const taskId = submitData.data.task_id;
    const pollUrl = `https://api.freepik.com/v1/ai/${endpoint}/${taskId}`;
    const maxWait = 120_000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      // Soft-cancel hook — the worker's updateProgress closure throws a
      // CancellationError if the job row got DELETEd mid-flight. Calling
      // it here lets the caller bail before another vendor poll.
      if (onPoll) await onPoll();
      const pollRes = await fetch(pollUrl, { headers: freepikHeaders });
      if (!pollRes.ok) continue;
      const pollData = await pollRes.json();
      const status = pollData.data?.status;

      if (status === "COMPLETED" && pollData.data?.generated?.length > 0) {
        const gen = pollData.data.generated[0];
        resultUrl = typeof gen === "string" ? gen : gen?.url || "";
        break;
      }
      if (status === "FAILED") {
        throw new Error("Magnific task failed");
      }
    }

    if (!resultUrl) throw new Error("Magnific timeout (120s)");
  } else {
    throw new Error(`Magnific unexpected response: ${JSON.stringify(submitData).slice(0, 200)}`);
  }

  // Rehost to Supabase. Vendor URLs are short-lived; rehosting is what
  // makes the asset durable in our catalog.
  const dl = await fetch(resultUrl);
  if (!dl.ok) {
    throw new Error(`reveal: vendor result fetch ${dl.status}`);
  }
  const buf = Buffer.from(await dl.arrayBuffer());
  const { uploadToStorage, buildUploadPath } = await import("../supabase");
  const finalUrl = await uploadBufferToStorage(
    buf,
    "image/png",
    buildUploadPath,
    uploadToStorage,
    "reveal",
  );

  return { url: finalUrl, scale, mode, prompt };
}

// POST /api/reveal/async — async wrapper around callMagnific.
// Body: { image_url, scale? = 2, mode? = 'creative'|'faithful' (default
// 'creative'), prompt?, character?, user_id? }
// Returns: { ok, job_id }
async function handleRevealAsync(
  req: Request,
  deps: any,
): Promise<Response> {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json_body" }, { status: 400 });
  }

  const imageUrl = String(body.image_url || "").trim();
  if (!imageUrl) {
    return Response.json({ error: "image_url required" }, { status: 400 });
  }

  const scale = Number(body.scale) || 2;
  const modeRaw = String(body.mode || "creative");
  const mode = (modeRaw === "faithful" ? "faithful" : "creative") as
    | "creative"
    | "faithful";
  const defaultPrompt =
    "(photorealistic:1.3), (natural skin texture with visible pores:1.3), (8k detail:1.1), natural lighting, 35mm film grain";
  const prompt = String(body.prompt || defaultPrompt);
  const charName = body.character ? String(body.character) : null;

  try {
    const inputAssetId = await (deps as any)
      .lookupAssetIdByUrl?.(imageUrl)
      .catch(() => null);

    const { job_id } = await spawnJob(deps, {
      engine: "reveal",
      job_type: "upscale",
      input_asset_id: inputAssetId || null,
      user_id: body.user_id ?? null,
      params: {
        image_url: imageUrl,
        scale,
        mode,
        prompt,
        character_name: charName,
      },
      worker: async (jobId, updateProgress) => {
        try {
          await updateProgress(0.1, "submitting to Magnific");
          const result = await callMagnific({
            imageUrl,
            scale,
            mode,
            prompt,
            onPoll: async () => {
              // Cheap poll-ping — keeps progress fresh while the vendor
              // task is queued AND lets updateProgress's cancellation
              // peek at the jobs row.
              await updateProgress(0.4, "waiting on Magnific");
            },
          });

          await updateProgress(0.9, "saving asset");
          let outputAssetId: string | null = null;
          try {
            const parentId =
              (await (deps as any).lookupAssetIdByUrl?.(imageUrl)) || null;
            outputAssetId = await (deps as any).saveAsset?.({
              asset_type: "edit",
              source_url: result.url,
              engine: "reveal",
              edit_action: "upscale",
              prompt,
              parent_id: parentId,
              metadata: {
                character_name: charName,
                scale,
                mode,
                source_url: imageUrl,
                job_id: jobId,
              },
              tags: ["reveal", "upscale", mode],
            });
          } catch (e) {
            console.error("[reveal/async] saveAsset failed (non-fatal):", e);
          }

          // Pre-warm content profile cache for downstream watch routing.
          queueBackgroundReanalysis(result.url);

          return {
            output_url: result.url,
            output_asset_id: outputAssetId || undefined,
          };
        } catch (e: any) {
          if (e instanceof CancellationError) throw e;
          return {
            error: String(e?.message || e),
            error_class: "service",
          };
        }
      },
    });

    return Response.json({ ok: true, job_id });
  } catch (e: any) {
    return Response.json(
      { error: e?.message || "reveal/async failed" },
      { status: 500 },
    );
  }
}

// POST /api/reveal/preset/:slug — apply a curated REVEAL preset to image_url.
// Body: { image_url, intensity?, scale? = 2, user_id? }
// Returns: { ok, job_id, slug, name }
//
// intensity is accepted but currently maps onto a logged metadata field —
// the active levers (prompt + scale) come from the registry. The
// creativity/hdr/resemblance triplet is recorded in metadata so a future
// engine swap can consume it.
async function handleRevealPreset(
  req: Request,
  slug: string,
  deps: any,
): Promise<Response> {
  const preset = REVEAL_PRESETS[slug];
  if (!preset) {
    return Response.json(
      { error: `unknown reveal preset: ${slug}` },
      { status: 404 },
    );
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — preset has its own defaults.
    body = {};
  }

  const imageUrl = String(body.image_url || "").trim();
  if (!imageUrl) {
    return Response.json({ error: "image_url required" }, { status: 400 });
  }

  const scale = Number(body.scale) || 2;
  const intensityRaw = String(body.intensity || "medium");
  const intensity = (["low", "medium", "high"].includes(intensityRaw)
    ? intensityRaw
    : "medium") as "low" | "medium" | "high";
  const charName = body.character ? String(body.character) : null;

  try {
    const inputAssetId = await (deps as any)
      .lookupAssetIdByUrl?.(imageUrl)
      .catch(() => null);

    const { job_id } = await spawnJob(deps, {
      engine: `reveal:${slug}`,
      job_type: "upscale-preset",
      input_asset_id: inputAssetId || null,
      user_id: body.user_id ?? null,
      params: {
        image_url: imageUrl,
        preset_slug: slug,
        preset_name: preset.name,
        scale,
        intensity,
        creativity: preset.creativity,
        hdr: preset.hdr,
        resemblance: preset.resemblance,
        character_name: charName,
      },
      worker: async (jobId, updateProgress) => {
        try {
          await updateProgress(0.1, `submitting to Magnific (${preset.name})`);
          const result = await callMagnific({
            imageUrl,
            scale,
            mode: "creative",
            prompt: preset.prompt,
            onPoll: async () => {
              await updateProgress(0.4, "waiting on Magnific");
            },
          });

          await updateProgress(0.9, "saving asset");
          let outputAssetId: string | null = null;
          try {
            const parentId =
              (await (deps as any).lookupAssetIdByUrl?.(imageUrl)) || null;
            outputAssetId = await (deps as any).saveAsset?.({
              asset_type: "edit",
              source_url: result.url,
              engine: `reveal:${slug}`,
              edit_action: "upscale",
              prompt: preset.prompt,
              parent_id: parentId,
              metadata: {
                preset_slug: slug,
                preset_name: preset.name,
                intensity,
                scale,
                creativity: preset.creativity,
                hdr: preset.hdr,
                resemblance: preset.resemblance,
                character_name: charName,
                source_url: imageUrl,
                job_id: jobId,
              },
              tags: ["reveal", "preset", slug],
            });
          } catch (e) {
            console.error(
              `[reveal/preset:${slug}] saveAsset failed (non-fatal):`,
              e,
            );
          }

          queueBackgroundReanalysis(result.url);

          return {
            output_url: result.url,
            output_asset_id: outputAssetId || undefined,
          };
        } catch (e: any) {
          if (e instanceof CancellationError) throw e;
          return {
            error: String(e?.message || e),
            error_class: "service",
          };
        }
      },
    });

    return Response.json({
      ok: true,
      job_id,
      slug,
      name: preset.name,
    });
  } catch (e: any) {
    return Response.json(
      { error: e?.message || "reveal/preset failed" },
      { status: 500 },
    );
  }
}
