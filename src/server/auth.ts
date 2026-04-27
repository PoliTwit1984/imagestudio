import { env } from "./config";

export function bearerToken(): string {
  return env("BEARER_TOKEN").trim();
}

export function isAuthConfigured(): boolean {
  if (env("DISABLE_AUTH") === "1") return false;
  return bearerToken().length > 0;
}

export function checkAuth(req: Request): boolean {
  // Local dev escape hatch — set DISABLE_AUTH=1 to bypass the bearer check
  if (env("DISABLE_AUTH") === "1") return true;

  const token = bearerToken();
  if (!token) return false;

  const auth = req.headers.get("Authorization");
  return auth === `Bearer ${token}`;
}
