import { checkAuth } from "../auth";
import type { RouteDeps } from "./types";

export async function handleSettingsRoutes(
  req: Request,
  url: URL,
  deps: Pick<RouteDeps, "clearSettingsCache" | "getAllSettings" | "updateSetting">
): Promise<Response | null> {
  if (url.pathname === "/api/settings" && req.method === "GET") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const settings = await deps.getAllSettings();
    return Response.json(settings);
  }

  if (url.pathname === "/api/settings/reload" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    deps.clearSettingsCache();
    return Response.json({ ok: true, message: "Cache cleared" });
  }

  if (url.pathname === "/api/settings" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const key = body.key;
      const value = body.value;
      if (!key || value === undefined) {
        return Response.json({ error: "key and value required" }, { status: 400 });
      }
      await deps.updateSetting(key, value);
      return Response.json({ ok: true, key });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  return null;
}
