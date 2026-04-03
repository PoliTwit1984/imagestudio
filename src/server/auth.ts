import { env } from "./config";

export function bearerToken(): string {
  return env("BEARER_TOKEN").trim();
}

export function isAuthConfigured(): boolean {
  return bearerToken().length > 0;
}

export function checkAuth(req: Request): boolean {
  const token = bearerToken();
  if (!token) return false;

  const auth = req.headers.get("Authorization");
  return auth === `Bearer ${token}`;
}
