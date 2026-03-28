// Image Studio — Luna & Holly image generation web app
// Bun server with Supabase backend (storage + db)

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = "https://ykbazffnruyitblyxyog.supabase.co";

function env(key: string, fallback?: string): string {
  return process.env[key] || Bun.env[key] || fallback || "";
}

const REALISM_TAGS =
  "raw unfiltered amateur iPhone photo, realistic skin texture with visible pores, candid r/gonewild energy, no filters";

function checkAuth(req: Request): boolean {
  const auth = req.headers.get("Authorization");
  return auth === `Bearer ${env("BEARER_TOKEN", "studio-2026")}`;
}

function supaHeaders() {
  return {
    apikey: env("SUPABASE_ANON_KEY"),
    Authorization: `Bearer ${env("SUPABASE_ANON_KEY")}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

// --- Supabase helpers ---

async function getCharacters() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/characters?order=created_at`, {
    headers: supaHeaders(),
  });
  return res.json();
}

async function getCharacter(name: string) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/characters?name=eq.${name}&limit=1`,
    { headers: supaHeaders() }
  );
  const rows = await res.json();
  return rows[0] || null;
}

async function saveGeneration(gen: any) {
  await fetch(`${SUPABASE_URL}/rest/v1/generations`, {
    method: "POST",
    headers: supaHeaders(),
    body: JSON.stringify(gen),
  });
}

async function getGenerations(limit = 50) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/generations?order=created_at.desc&limit=${limit}`,
    { headers: supaHeaders() }
  );
  return res.json();
}

async function updateGeneration(id: string, fields: any) {
  await fetch(`${SUPABASE_URL}/rest/v1/generations?id=eq.${id}`, {
    method: "PATCH",
    headers: supaHeaders(),
    body: JSON.stringify(fields),
  });
}

// --- Image generation ---

async function generateImage(
  character: any,
  scene: string,
  model: string
): Promise<{ url: string; revisedPrompt: string }> {
  const refUrl = character.ref_image_url;
  const prefix = character.prompt_prefix || "same face and body but";
  const suffix = character.prompt_suffix || "";
  const prompt = `${prefix} ${scene}${suffix ? ", " + suffix : ""}, ${REALISM_TAGS}, no smiling, serious sultry expression, lips parted`;

  const res = await fetch("https://api.x.ai/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("XAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model === "basic" ? "grok-imagine-image" : "grok-imagine-image-pro",
      prompt,
      image: { url: refUrl, type: "image_url" },
      n: 1,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Grok API ${res.status}: ${err}`);
  }

  const data = await res.json();
  return {
    url: data.data[0].url,
    revisedPrompt: data.data[0].revised_prompt || "",
  };
}

// --- AI Prompt Enhancer (Grok reasoning) ---

const ENHANCE_SYSTEM = `You are an expert prompt engineer for the Grok image generation model (grok-imagine-image). Your job is to take a simple scene description and enhance it into a photorealistic prompt.

RULES:
- This is for an img2img pipeline — a reference image provides the face/body. Do NOT describe the person's face, hair color, body type, or identity. Only describe the SCENE, POSE, CLOTHING, LIGHTING, and MOOD.
- Keep it under 150 words.
- Make it look like a real amateur photo, not a professional studio shot.
- Output ONLY the enhanced prompt text. No explanation, no quotes, no preamble.

TECHNIQUES TO USE:
- Specify natural lighting with time-of-day context (golden hour, overcast, warm lamplight, morning window light)
- Add subtle environmental interaction (hair catching light, skin sheen, fabric draping naturally)
- Include camera/lens cues (shot on iPhone 14 Pro, shallow depth of field, slight motion blur)
- Add real-photo imperfections (slight grain, natural skin texture with visible pores, matte finish)
- Use film stock references when appropriate (Kodak Portra 400 tones, Fuji superia warmth)
- Mention composition (rule of thirds, off-center framing, eye-level angle)
- Add tactile texture details on clothing and environment (worn cotton, rumpled sheets, rough wood)
- NEVER include: smiling, perfect symmetry, vibrant colors, studio lighting, or "beautiful/gorgeous/stunning"
- Always end with: "no smiling, lips slightly parted, direct eye contact"`;

const ENHANCE_EDIT_SYSTEM = `You are an expert prompt engineer for the Grok image editing model. Your job is to take a simple edit instruction and enhance it into a detailed, photorealistic edit prompt.

RULES:
- This is for img2img EDITING — the source image already exists. You are describing what should CHANGE, not the whole scene.
- Keep it under 80 words.
- Preserve the original composition and subject — only change what's requested.
- Output ONLY the enhanced edit prompt. No explanation, no quotes, no preamble.

TECHNIQUES:
- Be specific about lighting changes (not "darker" but "deeper shadows with warm undertones, single key light from the left")
- For color grading, reference specific film stocks or LUTs
- For cropping/angle changes, describe camera movement precisely
- For clothing changes, describe fabric texture and how it drapes
- For mood changes, describe the specific quality of light and shadow that creates that mood
- Always maintain: "no smiling, lips slightly parted"`;

async function enhancePrompt(scene: string, character: any, mode: string = "generate"): Promise<string> {
  const isEdit = mode === "edit";
  const systemPrompt = isEdit ? ENHANCE_EDIT_SYSTEM : ENHANCE_SYSTEM;
  const charContext = character?.description ? `The subject is: ${character.description}.` : "";

  const userMsg = isEdit
    ? `Edit instruction: "${scene}"\nEnhance this into a detailed photorealistic edit prompt. Only describe what should change.`
    : `Scene: "${scene}"\n${charContext}\nEnhance this into a photorealistic img2img prompt. Remember: do NOT describe the person's face/hair/body — only the scene, pose, clothing, lighting, and mood.`;

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("XAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-3",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      temperature: 0.8,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Grok enhance failed: ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// --- Vision Analysis (Grok looks at the image and suggests edits) ---

const VISION_SYSTEM = `You are a photography director and image editor reviewing a generated photo. Your job is to look at the image and suggest specific edits that would make it more photorealistic, more compelling, or more intimate.

OUTPUT FORMAT — return a JSON array of 6-8 suggestions. Each suggestion has:
- "label": short button label (2-4 words)
- "prompt": the detailed edit prompt to feed back into img2img

Focus on:
1. Lighting improvements (shadows too flat? highlights blown? add rim light?)
2. Color grading (would a film stock look help? warmer? cooler? desaturated?)
3. Composition tweaks (tighter crop? different angle?)
4. Texture/realism (skin looks too smooth? add grain? more environmental detail?)
5. Mood shifts (make it moodier? more intimate? more raw?)
6. Creative variations (b&w version? different clothing? wet look?)

Be specific in the prompts — not "make it better" but "add warm rim light from the right side, deepen shadows in the background, Kodak Portra 400 color shift."

RULES:
- Never suggest smiling or teeth showing
- Keep each prompt under 40 words
- Make suggestions that are meaningfully different from each other
- Output ONLY valid JSON array, no explanation`;

async function analyzeImage(imageUrl: string): Promise<any[]> {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("XAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-4-1-fast-non-reasoning",
      messages: [
        { role: "system", content: VISION_SYSTEM },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: "Analyze this generated photo and suggest 6-8 specific edits. Return ONLY a JSON array." },
          ],
        },
      ],
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vision analysis failed: ${err}`);
  }

  const data = await res.json();
  const content = data.choices[0].message.content.trim();
  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("No JSON array in response");
  return JSON.parse(jsonMatch[0]);
}

// --- Static files ---
const indexHtml = Bun.file("./public/index.html");

const server = Bun.serve({
  port: Number(PORT),
  async fetch(req) {
    const url = new URL(req.url);

    // Static
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHtml, { headers: { "Content-Type": "text/html" } });
    }

    // Health
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "image-studio" });
    }

    // --- Public API: get characters (for UI) ---
    if (url.pathname === "/api/characters" && req.method === "GET") {
      const chars = await getCharacters();
      return Response.json(chars);
    }

    // --- Auth required below ---

    // Enhance prompt via Grok reasoning
    // Vision analysis — Grok looks at the image and suggests edits
    if (url.pathname === "/api/analyze" && req.method === "POST") {
      if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      try {
        const body = await req.json();
        const imageUrl = body.image_url || "";
        if (!imageUrl) return Response.json({ error: "image_url required" }, { status: 400 });

        const suggestions = await analyzeImage(imageUrl);
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
        const character = await getCharacter(charName);
        const enhanced = await enhancePrompt(scene, character || { description: "" }, mode);
        return Response.json({ ok: true, enhanced });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // Edit existing image (img2img with generated result as new ref)
    if (url.pathname === "/api/edit" && req.method === "POST") {
      if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      try {
        const body = await req.json();
        const sourceUrl = body.source_url || "";
        const editPrompt = body.edit_prompt || "";
        const model = body.model || "pro";
        const charName = body.character || "luna";
        if (!sourceUrl || !editPrompt) {
          return Response.json({ error: "source_url and edit_prompt required" }, { status: 400 });
        }

        const res = await fetch("https://api.x.ai/v1/images/edits", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env("XAI_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model === "basic" ? "grok-imagine-image" : "grok-imagine-image-pro",
            prompt: `same person same scene but ${editPrompt}, ${REALISM_TAGS}, no smiling, lips parted`,
            image: { url: sourceUrl, type: "image_url" },
            n: 1,
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Grok API ${res.status}: ${err}`);
        }

        const data = await res.json();
        const resultUrl = data.data[0].url;
        const revisedPrompt = data.data[0].revised_prompt || "";

        // Save as new generation
        const character = await getCharacter(charName);
        await saveGeneration({
          character_id: character?.id,
          character_name: charName,
          scene: `[edit] ${editPrompt}`,
          model,
          image_url: resultUrl,
          revised_prompt: revisedPrompt,
        });

        return Response.json({ ok: true, url: resultUrl, revisedPrompt });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // Generate image
    if (url.pathname === "/api/generate" && req.method === "POST") {
      if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      try {
        const body = await req.json();
        const charName = body.character || "luna";
        const scene = body.scene || "";
        const model = body.model || "pro";
        if (!scene) return Response.json({ error: "scene required" }, { status: 400 });

        const character = await getCharacter(charName);
        if (!character) return Response.json({ error: "character not found" }, { status: 404 });

        const result = await generateImage(character, scene, model);

        // Save to generations table
        await saveGeneration({
          character_id: character.id,
          character_name: charName,
          scene,
          model,
          image_url: result.url,
          revised_prompt: result.revisedPrompt,
        });

        return Response.json({ ok: true, ...result, character: charName });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // Get generation history
    if (url.pathname === "/api/generations" && req.method === "GET") {
      if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const gens = await getGenerations(limit);
      return Response.json(gens);
    }

    // Upload new ref image
    if (url.pathname === "/api/characters/upload-ref" && req.method === "POST") {
      if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      try {
        const formData = await req.formData();
        const file = formData.get("file") as File;
        const charName = formData.get("name") as string;
        const displayName = formData.get("display_name") as string || charName;
        const promptPrefix = formData.get("prompt_prefix") as string || "same face and body but";
        const description = formData.get("description") as string || "";

        if (!file || !charName) {
          return Response.json({ error: "file and name required" }, { status: 400 });
        }

        const fileName = `refs/${charName}-ref.jpeg`;
        const bytes = await file.arrayBuffer();

        // Upload to Supabase Storage
        const uploadRes = await fetch(
          `${SUPABASE_URL}/storage/v1/object/image-studio/${fileName}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env("SUPABASE_ANON_KEY")}`,
              "Content-Type": file.type || "image/jpeg",
              "x-upsert": "true",
            },
            body: bytes,
          }
        );

        if (!uploadRes.ok) {
          const err = await uploadRes.text();
          throw new Error(`Storage upload failed: ${err}`);
        }

        const refUrl = `${SUPABASE_URL}/storage/v1/object/public/image-studio/${fileName}`;

        // Upsert character
        await fetch(`${SUPABASE_URL}/rest/v1/characters`, {
          method: "POST",
          headers: {
            ...supaHeaders(),
            Prefer: "resolution=merge-duplicates",
          },
          body: JSON.stringify({
            name: charName,
            display_name: displayName,
            description,
            ref_image_path: fileName,
            ref_image_url: refUrl,
            prompt_prefix: promptPrefix,
            updated_at: new Date().toISOString(),
          }),
        });

        return Response.json({ ok: true, name: charName, ref_url: refUrl });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // Send to Telegram
    if (url.pathname === "/api/send/telegram" && req.method === "POST") {
      if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      try {
        const body = await req.json();
        const res = await fetch(
          `https://api.telegram.org/bot${env("TELEGRAM_LUNAS_BOT_TOKEN")}/sendPhoto`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: env("TELEGRAM_CHAT_ID", "-1003866791406"),
              photo: body.url,
              caption: (body.caption || "").slice(0, 1024),
            }),
          }
        );
        const data = await res.json();
        if (body.generation_id) await updateGeneration(body.generation_id, { sent_telegram: true });
        return Response.json({ ok: data.ok });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // Send to Discord
    if (url.pathname === "/api/send/discord" && req.method === "POST") {
      if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      try {
        const body = await req.json();
        const res = await fetch(
          `https://discord.com/api/v10/channels/${env("DISCORD_CHANNEL_ID", "1476094105745494161")}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bot ${env("DISCORD_BOT_TOKEN")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              content: body.caption || "",
              embeds: [{ image: { url: body.url } }],
            }),
          }
        );
        const data = await res.json();
        if (body.generation_id) await updateGeneration(body.generation_id, { sent_discord: true });
        return Response.json({ ok: !!data.id });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`Image Studio running on port ${server.port}`);
