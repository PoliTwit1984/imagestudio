import { checkAuth } from "../auth";
import { env, SUPABASE_URL } from "../config";
import { supaHeaders } from "../supabase";
import type { RouteDeps } from "./types";

export async function handlePublicRoutes(
  req: Request,
  url: URL,
  deps: Pick<RouteDeps, "getCharacters">
): Promise<Response | null> {
  if (url.pathname === "/api/favorites" && req.method === "GET") {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/favorite_poses?order=created_at.desc&limit=100`,
      { headers: supaHeaders() }
    );
    return Response.json(await res.json());
  }

  if (url.pathname === "/api/favorites" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      await fetch(`${SUPABASE_URL}/rest/v1/favorite_poses`, {
        method: "POST",
        headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          image_url: body.image_url,
          thumbnail_url: body.thumbnail_url || body.image_url,
          title: body.title || "",
          source: body.source || "freepik",
          source_id: body.source_id || "",
          width: body.width || 0,
          height: body.height || 0,
          tags: body.tags || [],
        }),
      });
      return Response.json({ ok: true });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/favorites" && req.method === "DELETE") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      await fetch(
        `${SUPABASE_URL}/rest/v1/favorite_poses?image_url=eq.${encodeURIComponent(body.image_url)}`,
        { method: "DELETE", headers: supaHeaders() }
      );
      return Response.json({ ok: true });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/pose-search" && req.method === "GET") {
    try {
      const query = url.searchParams.get("q") || "boudoir pose";
      const page = url.searchParams.get("page") || "1";

      const fpRes = await fetch(
        `https://api.freepik.com/v1/resources?locale=en&page=${page}&limit=24&order=relevance&term=${encodeURIComponent(query)}&filters%5Bcontent_type%5D%5Bphoto%5D=1`,
        { headers: { "x-freepik-api-key": env("FREEPIK_API_KEY") } }
      );

      if (!fpRes.ok) {
        return Response.json({ images: [], message: "Search failed" });
      }

      const fpData = await fpRes.json();
      const toFreepikCdn = (imageUrl: string) => {
        return imageUrl
          .replace(/^http:\/\//, "https://")
          .replace("img.b2bpic.net", "img.freepik.com");
      };
      const images = (fpData.data || []).map((item: any) => {
        const rawUrl = item.image?.source?.url || "";
        const cdnUrl = toFreepikCdn(rawUrl);
        return {
          id: String(item.id),
          title: item.title || "",
          thumbnail: cdnUrl ? `${cdnUrl}?w=400` : "",
          image: cdnUrl || "",
          width: 0,
          height: 0,
        };
      });

      const totalPages = fpData.meta?.last_page || fpData.meta?.pagination?.total_pages || 1;
      const total = fpData.meta?.total || 0;

      return Response.json({ images, page: Number(page), totalPages, total });
    } catch (err: any) {
      return Response.json({ images: [], message: err.message });
    }
  }

  if (url.pathname === "/api/characters" && req.method === "GET") {
    const chars = await deps.getCharacters();
    return Response.json(chars);
  }

  if (url.pathname === "/api/loras" && req.method === "GET") {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/loras?order=name`, {
      headers: supaHeaders(),
    });
    return Response.json(await res.json());
  }

  return null;
}
