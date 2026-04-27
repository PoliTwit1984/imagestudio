import { env, SUPABASE_URL } from "./config";

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function supaHeaders() {
  const key = env("SUPABASE_ANON_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

export function encodeFilterValue(value: string): string {
  return encodeURIComponent(value);
}

export function toStorageSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

export function characterRefPath(name: string): string {
  return `refs/${toStorageSlug(name)}-ref.jpeg`;
}

export function publicStorageUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/image-studio/${path}`;
}

export function objectStorageUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/image-studio/${path}`;
}

function fileExtension(filename: string, contentType: string): string {
  const match = filename.match(/\.([a-z0-9]+)$/i);
  if (match) return match[1].toLowerCase();
  return EXT_BY_CONTENT_TYPE[contentType] || "bin";
}

export function buildUploadPath(folder: string, filename: string, contentType: string): string {
  const stem = toStorageSlug(filename.replace(/\.[^.]+$/, "")) || "upload";
  const ext = fileExtension(filename, contentType);
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${folder}/${stem}-${Date.now()}-${suffix}.${ext}`;
}

export async function uploadToStorage(
  path: string,
  body: BodyInit,
  contentType: string,
  upsert = true
): Promise<string> {
  // Storage requires a JWT-style key; prefer service-role when present so the
  // newer sb_publishable_* anon tokens (PostgREST-only) don't break uploads.
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_ANON_KEY");
  if (!key) throw new Error("Supabase storage key missing (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY)");

  const res = await fetch(objectStorageUrl(path), {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": contentType,
      "x-upsert": upsert ? "true" : "false",
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Storage upload failed: ${err}`);
  }

  return publicStorageUrl(path);
}

export async function deleteStorageObject(path: string): Promise<void> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_ANON_KEY");
  if (!key) throw new Error("Supabase storage key missing");

  const res = await fetch(objectStorageUrl(path), {
    method: "DELETE",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });

  if (!res.ok && res.status !== 404) {
    const err = await res.text();
    throw new Error(`Storage delete failed: ${err}`);
  }
}
