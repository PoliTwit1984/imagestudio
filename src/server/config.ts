export const PORT = Number(env("PORT", "3000"));
export const SUPABASE_URL = "https://ykbazffnruyitblyxyog.supabase.co";

export function env(key: string, fallback = ""): string {
  return process.env[key] || Bun.env[key] || fallback;
}
