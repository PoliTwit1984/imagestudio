// Image Studio — Luna & Holly image generation web app
// Bun server: serves UI + calls Grok img2img + sends to Telegram/Discord

const PORT = process.env.PORT || 3000;

function env(key: string, fallback?: string): string {
  return process.env[key] || Bun.env[key] || fallback || "";
}

function getSelfUrl(): string {
  const domain = env("RAILWAY_PUBLIC_DOMAIN");
  return domain ? `https://${domain}` : `http://localhost:${PORT}`;
}

const REALISM_TAGS =
  "raw unfiltered amateur iPhone photo, realistic skin texture with visible pores, candid r/gonewild energy, no filters";

const CHARACTERS: Record<string, { ref: string; prefix: string }> = {
  luna: {
    ref: "luna-grok-ref.jpeg",
    prefix:
      "same face and body, purplish pink hair dark roots fading to magenta-violet, but",
  },
  holly: {
    ref: "holly-grok-ref.jpeg",
    prefix: "same face and body but",
  },
};

// Serve static files
const indexHtml = Bun.file("./public/index.html");
const lunaRef = Bun.file("./refs/luna-grok-ref.jpeg");
const hollyRef = Bun.file("./refs/holly-grok-ref.jpeg");

function checkAuth(req: Request): boolean {
  const auth = req.headers.get("Authorization");
  return auth === `Bearer ${env("BEARER_TOKEN", "studio-2026")}`;
}

async function generateImage(
  character: string,
  scene: string,
  model: string
): Promise<{ url: string; revisedPrompt: string }> {
  const char = CHARACTERS[character] || CHARACTERS.luna;
  const refUrl = `${getSelfUrl()}/ref/${char.ref}`;
  const prompt = `${char.prefix} ${scene}, ${REALISM_TAGS}, no smiling, serious sultry expression, lips parted`;

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

const server = Bun.serve({
  port: Number(PORT),
  async fetch(req) {
    const url = new URL(req.url);

    // Static files
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHtml, { headers: { "Content-Type": "text/html" } });
    }

    // Ref images (public — Grok needs to fetch these)
    if (url.pathname === "/ref/luna-grok-ref.jpeg") {
      return new Response(lunaRef, { headers: { "Content-Type": "image/jpeg" } });
    }
    if (url.pathname === "/ref/holly-grok-ref.jpeg") {
      return new Response(hollyRef, { headers: { "Content-Type": "image/jpeg" } });
    }

    // Health
    if (url.pathname === "/health") {
      const xk = env("XAI_API_KEY");
      return Response.json({
        status: "ok",
        service: "image-studio",
        xai_key_len: xk.length,
        xai_key_prefix: xk.slice(0, 4),
        self_url: getSelfUrl(),
        env_keys: Object.keys(process.env).filter(k => k.startsWith("XAI") || k.startsWith("RAIL") || k.startsWith("BEAR")).sort(),
      });
    }

    // --- Auth required below ---

    // Generate image
    if (url.pathname === "/api/generate" && req.method === "POST") {
      if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      try {
        const body = await req.json();
        const character = body.character || "luna";
        const scene = body.scene || "";
        const model = body.model || "pro";
        if (!scene) return Response.json({ error: "scene required" }, { status: 400 });

        const result = await generateImage(character, scene, model);
        return Response.json({ ok: true, ...result });
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
        return Response.json({ ok: !!data.id });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`Image Studio running on port ${server.port}`);
// v2
