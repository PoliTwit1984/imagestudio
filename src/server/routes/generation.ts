import { checkAuth } from "../auth";
import { env } from "../config";
import { buildUploadPath, uploadToStorage } from "../supabase";
import { spawnJob } from "./safe-edit";
import type { RouteDeps } from "./types";

// Identity anchor: prepended server-side to single-image edit prompts so the
// engine preserves the subject's identity. NOT shown to the user; NOT applied
// to multi-image (Lock+List), face-swap, brush/inpaint, or sandwich flows —
// those have their own identity-preservation logic.
const IDENTITY_ANCHOR = "keep her face, hair, body shape, pose unchanged";

// Rehost a vendor-returned image URL (xAI / Replicate / fal / etc.) into
// Supabase storage so saved generations don't break when the vendor URL
// expires. Falls back to the original vendor URL if any step fails — never
// breaks the user-facing flow on storage hiccups.
async function rehostToStorage(
  vendorUrl: string,
  opts: { contentType?: string; filename_prefix?: string } = {},
): Promise<string> {
  if (!vendorUrl) return vendorUrl;
  try {
    const resp = await fetch(vendorUrl);
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const ct = opts.contentType || resp.headers.get("content-type") || "image/png";
    const prefix = opts.filename_prefix || "gen";
    const filename = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`;
    const path = buildUploadPath("uploads", filename, ct);
    const url = await uploadToStorage(
      path,
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      ct,
    );
    return url || vendorUrl;
  } catch (e) {
    console.error("[rehost] failed, using vendor URL:", e);
    return vendorUrl;
  }
}

export async function handleGenerationRoutes(
  req: Request,
  url: URL,
  deps: Pick<
    RouteDeps,
    | "CHAT_SYSTEM_DEFAULT"
    | "REALISM_DIRECTIVE_DEFAULT"
    | "REALISM_TAGS"
    | "analyzeImage"
    | "enhancePrompt"
    | "generateImage"
    | "generateMagnificPrompt"
    | "getCharacter"
    | "getGenerations"
    | "getLoraByName"
    | "getSetting"
    | "saveGeneration"
  >
): Promise<Response | null> {
  if (url.pathname === "/api/chat" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const messages = body.messages || [];
      const charName = body.character || "luna";

      const character = await deps.getCharacter(charName);
      const charContext = character?.description
        ? `Current character: ${character.display_name} (${character.description}).`
        : "";

      const chatPrompt = await deps.getSetting("chat_system", deps.CHAT_SYSTEM_DEFAULT);
      const realism = await deps.getSetting("realism_directive", deps.REALISM_DIRECTIVE_DEFAULT);
      const apiMessages: any[] = [
        { role: "system", content: `${chatPrompt}\n\n${realism}\n\n${charContext}` },
      ];

      for (const msg of messages) {
        if (msg.role === "user" && msg.image) {
          let safeImageUrl = msg.image;
          if (msg.image.includes("imgen.x.ai") || msg.image.includes("fal.media")) {
            try {
              const imgResp = await fetch(msg.image);
              if (imgResp.ok) {
                const imgBuf = await imgResp.arrayBuffer();
                const path = buildUploadPath("uploads", "chat-image.jpeg", "image/jpeg");
                safeImageUrl = await uploadToStorage(path, imgBuf, "image/jpeg");
              }
            } catch {
              // Keep original temp URL if persistence fails.
            }
          }

          apiMessages.push({
            role: "user",
            content: [
              { type: "image_url", image_url: { url: safeImageUrl } },
              { type: "text", text: msg.content },
            ],
          });
        } else {
          apiMessages.push({ role: msg.role, content: msg.content });
        }
      }

      const res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env("XAI_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "grok-4.20-0309-reasoning",
          messages: apiMessages,
          temperature: 0.8,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Chat failed: ${err}`);
      }

      const data = await res.json();
      const reply = data.choices[0].message.content;
      return Response.json({ ok: true, reply });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/analyze" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const imageUrl = body.image_url || "";
      if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });

      const suggestions = await deps.analyzeImage(imageUrl);
      return Response.json({ ok: true, suggestions });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/enhance" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const scene = body.scene || "";
      const charName = body.character || "luna";
      if (!scene) return Response.json({ error: "scene required" }, { status: 400 });

      const mode = body.mode || "generate";
      const character = await deps.getCharacter(charName);
      const enhanced = await deps.enhancePrompt(scene, character || { description: "" }, mode);
      return Response.json({ ok: true, enhanced });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/edit" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();

      // Watch engine: pre-flight content classification + auto-route into a
      // concrete engine, handled in safe-edit.ts. We re-dispatch through the
      // safe-edit handler with the body we already parsed.
      if (body?.engine === "watch" && !body?._watch) {
        const { handleSafeEditRoutes } = await import("./safe-edit");
        const proxyReq = new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: JSON.stringify(body),
        });
        const watchResp = await handleSafeEditRoutes(proxyReq, url, deps);
        if (watchResp) return watchResp;
        // Fall-through if safe-edit didn't claim it (shouldn't happen)
      }

      const sourceUrl = body.source_url || "";
      const editPrompt = body.edit_prompt || "";
      const engine = body.engine || "grok";
      const charName = body.character || "luna";
      if (!sourceUrl || !editPrompt) {
        return Response.json({ error: "source_url and edit_prompt required" }, { status: 400 });
      }

      let resultUrl: string;
      let revisedPrompt = "";

      // Single-image edit: prepend identity anchor server-side. /api/edit
      // always operates on exactly one source image regardless of engine, so
      // every engine path below receives the anchored prompt.
      const anchoredEditPrompt = `${IDENTITY_ANCHOR}. ${editPrompt}`;

      if (engine === "fal") {
        const falRes = await fetch("https://fal.run/bria/fibo-edit/edit", {
          method: "POST",
          headers: {
            Authorization: `Key ${env("FAL_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            image_url: sourceUrl,
            instruction: anchoredEditPrompt,
            steps_num: 30,
          }),
        });

        if (!falRes.ok) {
          const err = await falRes.text();
          throw new Error(`fal.ai Bria Edit ${falRes.status}: ${err}`);
        }

        const falData = await falRes.json();
        const vendorUrl = falData.images?.[0]?.url || falData.image?.url || "";
        resultUrl = await rehostToStorage(vendorUrl, { filename_prefix: "edit-fal" });
      } else if (engine === "pedit") {
        const repRes = await fetch("https://api.replicate.com/v1/models/prunaai/p-image-edit/predictions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env("REPLICATE_API_TOKEN")}`,
            "Content-Type": "application/json",
            Prefer: "wait",
          },
          body: JSON.stringify({
            input: {
              images: [sourceUrl],
              prompt: anchoredEditPrompt,
              disable_safety_checker: true,
              turbo: false,
              aspect_ratio: "match_input_image",
            },
          }),
        });

        if (!repRes.ok) {
          const err = await repRes.text();
          throw new Error(`P-Edit ${repRes.status}: ${err}`);
        }

        const repData = await repRes.json();
        if (repData.status === "failed") {
          throw new Error(`P-Edit failed: ${repData.error || "unknown error"}`);
        }

        const output = repData.output;
        const vendorUrl = Array.isArray(output) ? output[0] : output || "";
        resultUrl = await rehostToStorage(vendorUrl, { filename_prefix: "edit-pedit" });
      } else {
        const grokRes = await fetch("https://api.x.ai/v1/images/edits", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env("XAI_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "grok-imagine-image-pro",
            prompt: [
              IDENTITY_ANCHOR,
              `same person same scene but ${editPrompt}`,
              deps.REALISM_TAGS,
              "no smiling, lips parted",
            ]
              .filter((s) => s && s.trim())
              .join(", "),
            image: { url: sourceUrl, type: "image_url" },
            n: 1,
          }),
        });

        if (!grokRes.ok) {
          const err = await grokRes.text();
          throw new Error(`Grok API ${grokRes.status}: ${err}`);
        }

        const grokData = await grokRes.json();
        const vendorUrl = grokData.data[0].url;
        revisedPrompt = grokData.data[0].revised_prompt || "";
        resultUrl = await rehostToStorage(vendorUrl, { filename_prefix: "edit-grok" });
      }

      const character = await deps.getCharacter(charName);
      await deps.saveGeneration({
        character_id: character?.id,
        character_name: charName,
        scene: `[edit] ${editPrompt}`,
        model: `${engine}/pro`,
        image_url: resultUrl,
        revised_prompt: revisedPrompt,
      });
      // Dual-write: this is an edit; resolve parent_id from sourceUrl so the
      // edit chain traces back to the original asset.
      try {
        const parentId = await (deps as any).lookupAssetIdByUrl?.(sourceUrl);
        await (deps as any).saveAsset?.({
          asset_type: "edit",
          source_url: resultUrl,
          engine,
          edit_action: "edit",
          prompt: editPrompt,
          parent_id: parentId || null,
          metadata: {
            character_name: charName,
            character_id: character?.id || null,
            source_url: sourceUrl,
            revised_prompt: revisedPrompt,
            model: `${engine}/pro`,
          },
          tags: ["edit", engine],
        });
      } catch (e) {
        console.error("[generation:/api/edit] saveAsset failed (non-fatal):", e);
      }

      return Response.json({ ok: true, url: resultUrl, revisedPrompt, engine });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/generate" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const charName = body.character || "luna";
      const scene = body.scene || "";
      // Lens uses grok-imagine-image-pro only — BASIC tier removed (Darkroom v1
      // cleanup): PRO is more permissive for editing despite the surface
      // contradiction.
      const model = "pro";
      const engine = body.engine || "grok";
      if (!scene) return Response.json({ error: "scene required" }, { status: 400 });

      const character = await deps.getCharacter(charName);
      if (!character) return Response.json({ error: "character not found" }, { status: 404 });

      let loraOverride;
      if (engine === "fal" && body.lora) {
        const lora = await deps.getLoraByName(body.lora);
        if (lora) {
          loraOverride = { url: lora.url, trigger: lora.trigger_word, scale: lora.scale };
        }
      }

      // Engine functions in index.ts (generateGrok / generateFal /
      // generateGpt) self-rehost their vendor URLs into Supabase storage
      // before returning, so result.url is already the durable URL.
      const result = await deps.generateImage(character, scene, model, engine, loraOverride);

      await deps.saveGeneration({
        character_id: character.id,
        character_name: charName,
        scene,
        model: `${engine}/${model}`,
        image_url: result.url,
        revised_prompt: result.revisedPrompt,
      });
      // Dual-write: fresh generation = root of an edit chain (no parent).
      try {
        await (deps as any).saveAsset?.({
          asset_type: "generation",
          source_url: result.url,
          engine,
          prompt: scene,
          parent_id: null,
          metadata: {
            character_name: charName,
            character_id: character?.id || null,
            scene,
            revised_prompt: result.revisedPrompt,
            model: `${engine}/${model}`,
            lora_name: body.lora || null,
          },
          tags: ["generation", engine],
        });
      } catch (e) {
        console.error("[generation:/api/generate] saveAsset failed (non-fatal):", e);
      }

      return Response.json({ ok: true, ...result, character: charName });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/generations" && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const gens = await deps.getGenerations(limit);
    return Response.json(gens);
  }

  if (url.pathname === "/api/analyze-pose" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const poseUrl = body.pose_image_url || "";
      if (!poseUrl) return Response.json({ error: "pose_image_url required" }, { status: 400 });

      // Proxy the image as base64 to avoid Grok's fetcher getting 429'd by CDNs
      let imageContent: any;
      try {
        const imgRes = await fetch(poseUrl, {
          headers: { "User-Agent": "StudioBot/1.0" },
        });
        if (!imgRes.ok) throw new Error(`Image fetch ${imgRes.status}`);
        const buf = await imgRes.arrayBuffer();
        const b64 = Buffer.from(buf).toString("base64");
        const contentType = imgRes.headers.get("content-type") || "image/jpeg";
        imageContent = {
          type: "image_url",
          image_url: { url: `data:${contentType};base64,${b64}` },
        };
      } catch (fetchErr: any) {
        console.log(`[analyze-pose] Image proxy failed (${fetchErr.message}), falling back to URL`);
        imageContent = { type: "image_url", image_url: { url: poseUrl } };
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
              content: `You are a pose description expert for AI image generation. Your job is to look at a reference image and describe ONLY the body pose, position, and arrangement in precise detail.

RULES:
- Describe the exact pose: body orientation, limb positions, head tilt, hand placement, leg position
- Describe the camera angle and framing (overhead, eye-level, low angle, etc.)
- Mention if the subject is clothed or nude — if nude, describe what's visible/exposed
- Do NOT describe the person's face, hair, identity, or who they are
- Do NOT describe the environment, lighting, or mood — ONLY the physical pose
- Keep it under 80 words
- Output ONLY the pose description, no explanation
- Be explicit and specific about body positioning — this will be used as a prompt for image generation`,
            },
            {
              role: "user",
              content: [
                imageContent,
                { type: "text", text: "Describe the exact body pose, position, and camera angle in this image. Be specific about limb placement, body orientation, and what's visible. Output ONLY the description." },
              ],
            },
          ],
          temperature: 0.4,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Pose analysis failed: ${err}`);
      }

      const data = await res.json();
      const poseDescription = data.choices[0].message.content.trim();
      return Response.json({ ok: true, poseDescription });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/pose-generate" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const poseUrl = body.pose_image_url || "";
      const scene = body.scene || "";
      const loraName = body.lora || "";
      const strength = body.strength || 0.65;
      const charName = body.character || "luna";
      if (!poseUrl) return Response.json({ error: "pose_image_url required" }, { status: 400 });

      let loraUrl = "";
      let trigger = "";
      if (loraName) {
        const lora = await deps.getLoraByName(loraName);
        if (lora) {
          loraUrl = lora.url;
          trigger = lora.trigger_word;
        }
      }
      if (!loraUrl) {
        const character = await deps.getCharacter(charName);
        loraUrl = character?.lora_url || "";
        trigger = character?.lora_trigger || "";
      }

      const prompt = [`${trigger} ${scene}`, deps.REALISM_TAGS, "no smiling, serious sultry expression, lips parted"]
        .filter((s) => s && s.trim())
        .join(", ");

      const falBody: any = {
        prompt,
        image_url: poseUrl,
        strength,
        num_inference_steps: 28,
        guidance_scale: 7.5,
        enable_safety_checker: false,
      };
      if (loraUrl) {
        falBody.loras = [{ path: loraUrl, scale: 0.9 }];
      }

      const res = await fetch("https://fal.run/fal-ai/flux-lora/image-to-image", {
        method: "POST",
        headers: {
          Authorization: `Key ${env("FAL_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(falBody),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Pose generate ${res.status}: ${err}`);
      }

      const data = await res.json();
      const vendorUrl = data.images[0].url;
      const resultUrl = await rehostToStorage(vendorUrl, { filename_prefix: "pose-fal" });

      const character = await deps.getCharacter(charName);
      await deps.saveGeneration({
        character_id: character?.id,
        character_name: charName,
        scene: `[pose-ref] ${scene}`,
        model: "fal-pose-lora",
        image_url: resultUrl,
        revised_prompt: "",
      });
      // Dual-write: pose-ref generates from a pose source — treat the pose
      // image as the parent so the chain can trace it back if it's catalogued.
      try {
        const parentId = await (deps as any).lookupAssetIdByUrl?.(poseUrl);
        await (deps as any).saveAsset?.({
          asset_type: "generation",
          source_url: resultUrl,
          engine: "fal",
          edit_action: "pose-ref",
          prompt: scene,
          parent_id: parentId || null,
          metadata: {
            character_name: charName,
            character_id: character?.id || null,
            pose_url: poseUrl,
            strength,
            model: "fal-pose-lora",
            lora_url: loraUrl || null,
          },
          tags: ["generation", "pose-ref", "fal"],
        });
      } catch (e) {
        console.error("[generation:/api/pose-generate] saveAsset failed (non-fatal):", e);
      }

      return Response.json({ ok: true, url: resultUrl });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/magnific-prompt" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const imageUrl = body.image_url || "";
      if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });
      const prompt = await deps.generateMagnificPrompt(imageUrl);
      return Response.json({ ok: true, prompt });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // ---------------------------------------------------------------------------
  // /api/develop/async — POC for spawnJob() pattern. Wraps the Topaz Bloom
  // Realism upscale (the existing sync /api/topaz takes 30-60s) into a
  // fire-and-forget job that returns { job_id } immediately.
  //
  // Body: { image_url, model?, user_id?, input_asset_id? }
  //   - model defaults to "Bloom Realism" (the standard Develop preset).
  //   - input_asset_id (optional) wires the job row to its source asset.
  //
  // Response: { ok: true, job_id }. Client polls GET /api/jobs/:id until
  // status === 'completed' (then output_asset_id points at the new asset)
  // or 'failed' (error_class + error_detail explain).
  //
  // Worker pattern: every long-running engine route should follow this
  // shape — call updateProgress() between vendor stages, return
  // { output_url, output_asset_id } on success or { error, error_class }
  // on failure. NEVER throw out of the worker; the spawnJob outer-catch
  // is a safety net, not the primary error path.
  // ---------------------------------------------------------------------------
  if (url.pathname === "/api/develop/async" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const imageUrl = String(body.image_url || "");
      if (!imageUrl) {
        return Response.json({ error: "image_url required" }, { status: 400 });
      }
      const topazModel = String(body.model || "Bloom Realism");
      const userId = body.user_id ?? null;
      const inputAssetId = body.input_asset_id ?? null;

      const { job_id } = await spawnJob(deps, {
        engine: "develop",
        job_type: "upscale",
        input_asset_id: inputAssetId,
        user_id: userId,
        params: { image_url: imageUrl, model: topazModel },
        worker: async (jobId, updateProgress) => {
          try {
            await updateProgress(0.05, "fetching source");
            const imgResp = await fetch(imageUrl);
            if (!imgResp.ok) {
              return {
                error: `source fetch ${imgResp.status}`,
                error_class: "invalid_input",
              };
            }
            const imgBuf = Buffer.from(await imgResp.arrayBuffer());

            // Topaz routes "Bloom"/"Wonder"/"Redefine" through enhance-gen,
            // everything else through enhance — same logic as /api/topaz.
            const isGenerative =
              topazModel.startsWith("Bloom") ||
              topazModel === "Redefine" ||
              topazModel.startsWith("Wonder");
            const endpoint = isGenerative ? "enhance-gen" : "enhance";

            const formData = new FormData();
            formData.append("model", topazModel);
            formData.append(
              "image",
              new Blob([imgBuf], { type: "image/jpeg" }),
              "input.jpg",
            );
            formData.append("output_width", "1536");
            formData.append("output_height", "2048");
            if (isGenerative) {
              formData.append("creativity", "2");
              formData.append("texture", "3");
              formData.append("autoprompt", "true");
            }

            await updateProgress(0.15, "submitting to Topaz");
            const submitRes = await fetch(
              `https://api.topazlabs.com/image/v1/${endpoint}/async`,
              {
                method: "POST",
                headers: { "X-API-Key": env("TOPAZ_API_KEY") },
                body: formData,
              },
            );
            if (!submitRes.ok) {
              const errText = await submitRes.text();
              const klass =
                submitRes.status === 401 || submitRes.status === 403
                  ? "auth"
                  : submitRes.status === 429
                  ? "rate_limit"
                  : "service";
              return {
                error: `Topaz submit ${submitRes.status}: ${errText.slice(0, 200)}`,
                error_class: klass,
              };
            }
            const submitData = await submitRes.json();
            const processId = submitData.process_id;

            // Poll Topaz. Max 120s wall clock = 24 polls at 5s. Update
            // progress between polls so the UI moves between 0.15 and 0.80.
            const pollStart = Date.now();
            const maxWait = 120_000;
            let resultUrl: string | null = null;
            let pollCount = 0;
            while (Date.now() - pollStart < maxWait) {
              await new Promise((r) => setTimeout(r, 5000));
              pollCount += 1;
              const statusRes = await fetch(
                `https://api.topazlabs.com/image/v1/status/${processId}`,
                { headers: { "X-API-Key": env("TOPAZ_API_KEY") } },
              );
              const statusData = await statusRes.json();
              if (statusData.status === "Completed") {
                const dlRes = await fetch(
                  `https://api.topazlabs.com/image/v1/download/${processId}`,
                  { headers: { "X-API-Key": env("TOPAZ_API_KEY") } },
                );
                const dlData = await dlRes.json();
                resultUrl = dlData.download_url || null;
                break;
              }
              if (statusData.status === "Failed") {
                return {
                  error: "Topaz reported Failed",
                  error_class: "service",
                };
              }
              // Glide progress from 0.15 → 0.75 across polls.
              const ramp = Math.min(0.75, 0.15 + pollCount * 0.05);
              await updateProgress(ramp, `polling Topaz (attempt ${pollCount})`);
            }
            if (!resultUrl) {
              return {
                error: "Topaz timed out after 120s",
                error_class: "timeout",
              };
            }

            await updateProgress(0.85, "rehosting to Supabase");
            const rehosted = await rehostToStorage(resultUrl, {
              filename_prefix: "develop-async",
            });

            await updateProgress(0.95, "saving asset row");
            // saveAsset is wired into the deps bag in index.ts — reach via
            // the loose-typed `as any` pattern shared by the rest of the
            // codebase. parent_id resolves from the source URL when the
            // dual-write catalog has a row for it.
            let outputAssetId: string | null = null;
            try {
              const parentId = await (deps as any).lookupAssetIdByUrl?.(imageUrl);
              outputAssetId = await (deps as any).saveAsset?.({
                asset_type: "edit",
                source_url: rehosted,
                engine: "topaz",
                edit_action: "upscale",
                prompt: "[topaz-bloom-realism]",
                parent_id: parentId || null,
                metadata: {
                  topaz_model: topazModel,
                  job_id: jobId,
                  source_url: imageUrl,
                },
                tags: ["topaz", "develop", "async"],
                user_id: userId,
              });
            } catch (e) {
              // saveAsset failure is non-fatal — the job still completed,
              // we just couldn't catalog it. Surface the URL anyway.
              console.error(
                `[develop/async] saveAsset failed (non-fatal):`,
                e,
              );
            }

            return {
              output_url: rehosted,
              output_asset_id: outputAssetId || undefined,
            };
          } catch (e: any) {
            // Anything we didn't classify above falls into 'service'.
            return {
              error: String(e?.message || e),
              error_class: "service",
            };
          }
        },
      });

      return Response.json({ ok: true, job_id });
    } catch (err: any) {
      return Response.json({ error: err?.message || String(err) }, { status: 500 });
    }
  }

  return null;
}
