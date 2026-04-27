import { checkAuth } from "../auth";
import { env } from "../config";
import { buildUploadPath, uploadToStorage } from "../supabase";
import type { RouteDeps } from "./types";

export async function handleMediaRoutes(
  req: Request,
  url: URL,
  deps: Pick<RouteDeps, "ALLOWED_UPLOAD_FOLDERS" | "getCharacter" | "saveGeneration">
): Promise<Response | null> {
  if (url.pathname === "/api/uploads" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const formData = await req.formData();
      const file = formData.get("file");
      const folder = String(formData.get("folder") || "uploads");
      const requestedName = String(formData.get("filename") || "");

      if (!(file instanceof File)) {
        return Response.json({ error: "file required" }, { status: 400 });
      }

      if (!deps.ALLOWED_UPLOAD_FOLDERS.has(folder)) {
        return Response.json({ error: "invalid upload folder" }, { status: 400 });
      }

      const bytes = await file.arrayBuffer();
      const filename = requestedName || file.name || `${folder}-upload`;
      const path = buildUploadPath(folder, filename, file.type || "application/octet-stream");
      const publicUrl = await uploadToStorage(path, bytes, file.type || "application/octet-stream");

      // For image uploads to the main canvas, also log them in the catalog
      // (generations table) so they appear in History alongside generated/edited
      // images and carry full lifecycle metadata.
      const isImage = (file.type || "").startsWith("image/");
      const isCatalogFolder = folder === "uploads" || folder === "garments" || folder === "poses" || folder === "faces";
      if (isImage && isCatalogFolder) {
        try {
          await deps.saveGeneration({
            scene: `[${folder}]`,
            model: "user-upload",
            image_url: publicUrl,
            revised_prompt: filename,
          } as any);
        } catch {}
      }

      return Response.json({ ok: true, folder, path, url: publicUrl });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/face-swap" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const baseUrl = body.base_image_url || "";
      const faceUrl = body.face_image_url || "";
      const charName = body.character || "unknown";
      const engine = (body.engine || "fal") as "fal" | "nano" | "gpt";
      if (!baseUrl || !faceUrl) {
        return Response.json({ error: "base_image_url and face_image_url required" }, { status: 400 });
      }

      let resultUrl = "";
      let modelUsed = "";

      if (engine === "nano") {
        const r = await fetch("https://fal.run/fal-ai/nano-banana/edit", {
          method: "POST",
          headers: {
            Authorization: `Key ${env("FAL_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            image_urls: [baseUrl, faceUrl],
            prompt: "Replace the face on the woman in the first image with the face from the second image. Keep her body, pose, outfit, hair, lighting, and the entire background of the first image identical. Only the face changes. Photorealistic, seamless skin blend at the jawline.",
            num_images: 1,
            output_format: "png",
          }),
        });
        if (!r.ok) throw new Error(`Nano face-swap ${r.status}: ${(await r.text()).slice(0, 300)}`);
        const d = await r.json();
        resultUrl = d.images?.[0]?.url || d.image?.url || "";
        modelUsed = "nano-banana";
      } else if (engine === "gpt") {
        // gpt-image-2 with multipart edit (person + face source)
        const [baseDl, faceDl] = await Promise.all([fetch(baseUrl), fetch(faceUrl)]);
        if (!baseDl.ok) throw new Error(`base fetch ${baseDl.status}`);
        if (!faceDl.ok) throw new Error(`face fetch ${faceDl.status}`);
        const baseBuf = Buffer.from(await baseDl.arrayBuffer());
        const faceBuf = Buffer.from(await faceDl.arrayBuffer());
        const form = new FormData();
        form.append("model", "gpt-image-2");
        form.append("image[]", new Blob([baseBuf], { type: "image/png" }), "base.png");
        form.append("image[]", new Blob([faceBuf], { type: "image/png" }), "face.png");
        form.append("prompt", "Replace the face on the woman in the first image with the face from the second image. Keep her body, pose, outfit, hair, lighting, and the entire background of the first image identical. Only the face changes.");
        form.append("size", "1024x1024");
        form.append("quality", "high");
        const r = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
          body: form as any,
        });
        if (!r.ok) throw new Error(`GPT face-swap ${r.status}: ${(await r.text()).slice(0, 300)}`);
        const d = await r.json();
        const b64 = d.data?.[0]?.b64_json;
        const remoteUrl = d.data?.[0]?.url;
        if (b64) {
          const bytes = Buffer.from(b64, "base64");
          const { uploadToStorage, buildUploadPath } = await import("../supabase");
          const path = buildUploadPath("uploads", `gpt-faceswap-${Date.now()}.png`, "image/png");
          resultUrl = await uploadToStorage(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "image/png");
        } else if (remoteUrl) {
          resultUrl = remoteUrl;
        }
        modelUsed = "gpt-image-2";
      } else {
        const res = await fetch("https://fal.run/fal-ai/face-swap", {
          method: "POST",
          headers: {
            Authorization: `Key ${env("FAL_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            base_image_url: baseUrl,
            swap_image_url: faceUrl,
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Face swap ${res.status}: ${err}`);
        }
        const data = await res.json();
        resultUrl = data.image?.url || "";
        modelUsed = "fal-face-swap";
      }

      if (!resultUrl) throw new Error("face-swap returned no image");

      const character = await deps.getCharacter(charName);
      await deps.saveGeneration({
        character_id: character?.id,
        character_name: charName,
        scene: `[face-swap:${engine}]`,
        model: modelUsed,
        image_url: resultUrl,
        revised_prompt: "",
      });

      return Response.json({ ok: true, url: resultUrl, engine, model: modelUsed });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/topaz" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const imageUrl = body.image_url || "";
      const charName = body.character || "luna";
      const creativity = body.creativity ?? 2;
      const texture = body.texture ?? 3;
      const sharpen = body.sharpen ?? 0.4;
      const denoise = body.denoise ?? 0;
      const faceStrength = body.face_strength ?? 0.5;
      const faceCreativity = body.face_creativity ?? 0.3;
      if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });

      const imgResp = await fetch(imageUrl);
      const imgBuf = Buffer.from(await imgResp.arrayBuffer());

      const topazModel = body.model || "Bloom Realism";
      const isGenerative =
        topazModel.startsWith("Bloom") ||
        topazModel === "Redefine" ||
        topazModel.startsWith("Wonder");
      const endpoint = isGenerative ? "enhance-gen" : "enhance";

      const formData = new FormData();
      formData.append("model", topazModel);
      formData.append("image", new Blob([imgBuf], { type: "image/jpeg" }), "input.jpg");
      formData.append("output_width", "1536");
      formData.append("output_height", "2048");

      if (isGenerative) {
        formData.append("creativity", String(creativity));
        formData.append("texture", String(texture));
        formData.append("autoprompt", "true");
      }
      if (sharpen > 0) formData.append("sharpen", String(sharpen));
      if (denoise > 0) formData.append("denoise", String(denoise));
      if (faceStrength > 0) {
        formData.append("face_enhancement", "true");
        formData.append("face_enhancement_strength", String(faceStrength));
        formData.append("face_enhancement_creativity", String(faceCreativity));
      }

      const submitRes = await fetch(`https://api.topazlabs.com/image/v1/${endpoint}/async`, {
        method: "POST",
        headers: { "X-API-Key": env("TOPAZ_API_KEY") },
        body: formData,
      });

      if (!submitRes.ok) {
        const err = await submitRes.text();
        throw new Error(`Topaz submit ${submitRes.status}: ${err}`);
      }

      const submitData = await submitRes.json();
      const processId = submitData.process_id;
      const maxWait = 120_000;
      const start = Date.now();

      while (Date.now() - start < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const statusRes = await fetch(`https://api.topazlabs.com/image/v1/status/${processId}`, {
          headers: { "X-API-Key": env("TOPAZ_API_KEY") },
        });
        const statusData = await statusRes.json();

        if (statusData.status === "Completed") {
          const dlRes = await fetch(`https://api.topazlabs.com/image/v1/download/${processId}`, {
            headers: { "X-API-Key": env("TOPAZ_API_KEY") },
          });
          const dlData = await dlRes.json();
          const resultUrl = dlData.download_url;

          const character = await deps.getCharacter(charName);
          await deps.saveGeneration({
            character_id: character?.id,
            character_name: charName,
            scene: "[topaz-bloom-realism]",
            model: "topaz-bloom-realism",
            image_url: resultUrl,
            revised_prompt: "",
          });

          return Response.json({ ok: true, url: resultUrl });
        }

        if (statusData.status === "Failed") {
          throw new Error("Topaz processing failed");
        }
      }

      throw new Error("Topaz timeout (120s)");
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/enhancor" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const imageUrl = body.image_url || "";
      const charName = body.character || "luna";
      const enhancementType = body.enhancement_type || "body";
      const refinementLevel = body.refinement_level ?? 65;
      const realismLevel = body.realism_level ?? 1.5;
      const portraitDepth = body.portrait_depth ?? 0.3;
      const outputResolution = body.output_resolution ?? 2048;
      if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });

      const submitRes = await fetch("https://apireq.enhancor.ai/api/realistic-skin/v1/queue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env("ENHANCOR_API_KEY"),
        },
        body: JSON.stringify({
          img_url: imageUrl,
          webhookUrl: "https://webhook.site/placeholder",
          model_version: "enhancorv3",
          enhancementType,
          skin_refinement_level: refinementLevel,
          skin_realism_Level: realismLevel,
          portrait_depth: portraitDepth,
          output_resolution: outputResolution,
          r_eye: true,
          l_eye: true,
          mouth: true,
          u_lip: true,
          l_lip: true,
          hair: false,
        }),
      });

      if (!submitRes.ok) {
        const err = await submitRes.text();
        throw new Error(`Enhancor submit ${submitRes.status}: ${err}`);
      }

      const submitData = await submitRes.json();
      const requestId = submitData.requestId;
      if (!requestId) throw new Error("Enhancor did not return requestId");

      const maxWait = 180_000;
      const start = Date.now();

      while (Date.now() - start < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const statusRes = await fetch("https://apireq.enhancor.ai/api/realistic-skin/v1/status", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env("ENHANCOR_API_KEY"),
          },
          body: JSON.stringify({ request_id: requestId }),
        });
        const statusData = await statusRes.json();

        if (statusData.status === "COMPLETED" && statusData.result) {
          const character = await deps.getCharacter(charName);
          await deps.saveGeneration({
            character_id: character?.id,
            character_name: charName,
            scene: `[enhancor-v3-${enhancementType}]`,
            model: "enhancor-v3",
            image_url: statusData.result,
            revised_prompt: "",
          });
          return Response.json({ ok: true, url: statusData.result, cost: statusData.cost });
        }

        if (statusData.status === "FAILED") {
          throw new Error("Enhancor processing failed");
        }
      }

      throw new Error("Enhancor timeout (180s)");
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/tts" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const text = body.text || "";
      const voiceId = body.voice_id || "LEnmbrrxYsUYS7vsRRwD";
      if (!text) return Response.json({ error: "text required" }, { status: 400 });

      const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": env("ELEVENLABS_API_KEY"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_flash_v2_5",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.5,
            use_speaker_boost: true,
          },
        }),
      });

      if (!ttsRes.ok) {
        const err = await ttsRes.text();
        throw new Error(`ElevenLabs ${ttsRes.status}: ${err}`);
      }

      const audioBuf = await ttsRes.arrayBuffer();
      const audioPath = buildUploadPath("audio", "tts.mp3", "audio/mpeg");
      const audioUrl = await uploadToStorage(audioPath, audioBuf, "audio/mpeg");
      return Response.json({ ok: true, url: audioUrl });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/upscale" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const imageUrl = body.image_url || "";
      const scale = body.scale || 2;
      const charName = body.character || "luna";
      if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });

      const mode = body.mode || "faithful";
      const freepikHeaders = {
        "x-freepik-api-key": env("FREEPIK_API_KEY"),
        "Content-Type": "application/json",
      };

      const imgResp = await fetch(imageUrl);
      const imgBuf = await imgResp.arrayBuffer();
      const b64 = Buffer.from(imgBuf).toString("base64");
      const b64Data = `data:image/jpeg;base64,${b64}`;

      let endpoint: string;
      let payload: any;
      let magnificPrompt = "";
      if (mode === "creative") {
        magnificPrompt =
          body.prompt ||
          "(photorealistic:1.3), (natural skin texture with visible pores:1.3), (8k detail:1.1), natural lighting, 35mm film grain";
        endpoint = "image-upscaler";
        payload = {
          image: b64Data,
          prompt: magnificPrompt,
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
        throw new Error(`Magnific submit ${submitRes.status}: ${err}`);
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
        throw new Error(`Unexpected response: ${JSON.stringify(submitData)}`);
      }

      const character = await deps.getCharacter(charName);
      await deps.saveGeneration({
        character_id: character?.id,
        character_name: charName,
        scene: `[upscale ${scale}x]`,
        model: "creative-upscaler",
        image_url: resultUrl,
        revised_prompt: "",
      });

      return Response.json({ ok: true, url: resultUrl, scale, magnificPrompt });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  return null;
}
