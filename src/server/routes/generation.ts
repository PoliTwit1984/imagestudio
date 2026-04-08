import { checkAuth } from "../auth";
import { env } from "../config";
import { buildUploadPath, uploadToStorage } from "../supabase";
import type { RouteDeps } from "./types";

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
      const sourceUrl = body.source_url || "";
      const editPrompt = body.edit_prompt || "";
      const model = body.model || "pro";
      const engine = body.engine || "grok";
      const charName = body.character || "luna";
      if (!sourceUrl || !editPrompt) {
        return Response.json({ error: "source_url and edit_prompt required" }, { status: 400 });
      }

      let resultUrl: string;
      let revisedPrompt = "";

      if (engine === "fal") {
        const falRes = await fetch("https://fal.run/bria/fibo-edit/edit", {
          method: "POST",
          headers: {
            Authorization: `Key ${env("FAL_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            image_url: sourceUrl,
            instruction: editPrompt,
            steps_num: 30,
          }),
        });

        if (!falRes.ok) {
          const err = await falRes.text();
          throw new Error(`fal.ai Bria Edit ${falRes.status}: ${err}`);
        }

        const falData = await falRes.json();
        resultUrl = falData.images?.[0]?.url || falData.image?.url || "";
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
              prompt: editPrompt,
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
        resultUrl = Array.isArray(output) ? output[0] : output || "";
      } else {
        const grokRes = await fetch("https://api.x.ai/v1/images/edits", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env("XAI_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model === "basic" ? "grok-imagine-image" : "grok-imagine-image-pro",
            prompt: `same person same scene but ${editPrompt}, ${deps.REALISM_TAGS}, no smiling, lips parted`,
            image: { url: sourceUrl, type: "image_url" },
            n: 1,
          }),
        });

        if (!grokRes.ok) {
          const err = await grokRes.text();
          throw new Error(`Grok API ${grokRes.status}: ${err}`);
        }

        const grokData = await grokRes.json();
        resultUrl = grokData.data[0].url;
        revisedPrompt = grokData.data[0].revised_prompt || "";
      }

      const character = await deps.getCharacter(charName);
      await deps.saveGeneration({
        character_id: character?.id,
        character_name: charName,
        scene: `[edit] ${editPrompt}`,
        model: `${engine}/${model}`,
        image_url: resultUrl,
        revised_prompt: revisedPrompt,
      });

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
      const model = body.model || "pro";
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

      const result = await deps.generateImage(character, scene, model, engine, loraOverride);

      await deps.saveGeneration({
        character_id: character.id,
        character_name: charName,
        scene,
        model: `${engine}/${model}`,
        image_url: result.url,
        revised_prompt: result.revisedPrompt,
      });

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

      const prompt = `${trigger} ${scene}, ${deps.REALISM_TAGS}, no smiling, serious sultry expression, lips parted`;

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
      const resultUrl = data.images[0].url;

      const character = await deps.getCharacter(charName);
      await deps.saveGeneration({
        character_id: character?.id,
        character_name: charName,
        scene: `[pose-ref] ${scene}`,
        model: "fal-pose-lora",
        image_url: resultUrl,
        revised_prompt: "",
      });

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

  return null;
}
