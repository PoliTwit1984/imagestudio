import { checkAuth } from "../auth";
import { SUPABASE_URL } from "../config";
import {
  characterRefPath,
  deleteStorageObject,
  encodeFilterValue,
  publicStorageUrl,
  supaHeaders,
  uploadToStorage,
} from "../supabase";
import type { RouteDeps } from "./types";

export async function handleCharacterRoutes(
  req: Request,
  url: URL,
  deps: Pick<RouteDeps, "getCharacter">
): Promise<Response | null> {
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

      const fileName = characterRefPath(charName);
      const bytes = await file.arrayBuffer();
      const refUrl = await uploadToStorage(fileName, bytes, file.type || "image/jpeg");

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

  if (url.pathname === "/api/characters/update" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const formData = await req.formData();
      const charName = formData.get("name") as string;
      if (!charName) return Response.json({ error: "name required" }, { status: 400 });

      const updates: any = { updated_at: new Date().toISOString() };
      const displayName = formData.get("display_name") as string;
      const description = formData.get("description") as string;
      const promptPrefix = formData.get("prompt_prefix") as string;
      if (displayName) updates.display_name = displayName;
      if (description !== null && description !== undefined) updates.description = description;
      if (promptPrefix) updates.prompt_prefix = promptPrefix;

      const file = formData.get("file") as File | null;
      if (file && file.size > 0) {
        const fileName = characterRefPath(charName);
        const bytes = await file.arrayBuffer();
        await uploadToStorage(fileName, bytes, file.type || "image/jpeg");
        updates.ref_image_path = fileName;
        updates.ref_image_url = publicStorageUrl(fileName);
      }

      await fetch(`${SUPABASE_URL}/rest/v1/characters?name=eq.${encodeFilterValue(charName)}`, {
        method: "PATCH",
        headers: supaHeaders(),
        body: JSON.stringify(updates),
      });

      return Response.json({ ok: true, name: charName });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/characters/delete" && req.method === "POST") {
    if (!checkAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const body = await req.json();
      const charName = body.name;
      if (!charName) return Response.json({ error: "name required" }, { status: 400 });

      const character = await deps.getCharacter(charName);

      await fetch(`${SUPABASE_URL}/rest/v1/characters?name=eq.${encodeFilterValue(charName)}`, {
        method: "DELETE",
        headers: supaHeaders(),
      });

      const refPath = character?.ref_image_path || characterRefPath(charName);
      await deleteStorageObject(refPath);

      return Response.json({ ok: true, deleted: charName });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  return null;
}
