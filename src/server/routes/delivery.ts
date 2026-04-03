import { checkAuth } from "../auth";
import { env } from "../config";
import type { RouteDeps } from "./types";

export async function handleDeliveryRoutes(
  req: Request,
  url: URL,
  deps: Pick<RouteDeps, "updateGeneration">
): Promise<Response | null> {
  if (url.pathname === "/api/send/telegram" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const res = await fetch(`https://api.telegram.org/bot${env("TELEGRAM_LUNAS_BOT_TOKEN")}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env("TELEGRAM_CHAT_ID", "-1003866791406"),
          photo: body.url,
          caption: (body.caption || "").slice(0, 1024),
        }),
      });
      const data = await res.json();
      if (body.generation_id) await deps.updateGeneration(body.generation_id, { sent_telegram: true });
      return Response.json({ ok: data.ok });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

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
      if (body.generation_id) await deps.updateGeneration(body.generation_id, { sent_discord: true });
      return Response.json({ ok: !!data.id });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  return null;
}
