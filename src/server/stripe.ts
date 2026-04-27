// =============================================================================
// src/server/stripe.ts
//
// Stripe glue for Darkroom — webhook signature verification + Checkout Session
// creation. Built on the bare REST API + built-in `crypto.subtle` HMAC so we
// don't have to take a dependency on the Stripe SDK. The dependency surface
// stays at zero.
//
// Public surface:
//
//   * STRIPE_WEBHOOK_SECRET / STRIPE_SECRET_KEY — eagerly read at module load.
//                                                 Empty string when unset; the
//                                                 caller checks isStripeConfigured
//                                                 (or the individual constants)
//                                                 to gate behavior.
//   * isStripeConfigured()                       — true iff both secrets are set.
//   * verifyStripeSignature(rawBody, sigHeader)  — verify a Stripe webhook per
//                                                 Stripe's spec (HMAC-SHA256
//                                                 over `${t}.${rawBody}`).
//                                                 Returns { ok: true, eventId }
//                                                 on success, { ok: false,
//                                                 reason } on failure.
//   * createCheckoutSession(args)                — POST /v1/checkout/sessions.
//                                                 Throws when STRIPE_SECRET_KEY
//                                                 is unset or Stripe rejects.
//
// Notes:
//   * The Stripe-Signature header format is:
//       t=<unix-timestamp>,v1=<signature>[,v0=<old-signature>]
//     Signed payload = `${timestamp}.${rawBody}`. We HMAC-SHA256 that with
//     STRIPE_WEBHOOK_SECRET and constant-time-compare against v1.
//   * 5-minute tolerance window matches Stripe's recommendation; outside the
//     window we reject as "timestamp_outside_tolerance" so replays are rare.
//   * Checkout Session creation uses `application/x-www-form-urlencoded` which
//     is what the Stripe REST API expects (NOT JSON — Stripe is unusual here).
// =============================================================================

import { env } from "./config";

export const STRIPE_WEBHOOK_SECRET = (() => {
  try {
    return env("STRIPE_WEBHOOK_SECRET");
  } catch {
    return "";
  }
})();

export const STRIPE_SECRET_KEY = (() => {
  try {
    return env("STRIPE_SECRET_KEY");
  } catch {
    return "";
  }
})();

export const STRIPE_API = "https://api.stripe.com/v1";

export function isStripeConfigured(): boolean {
  return !!(STRIPE_WEBHOOK_SECRET && STRIPE_SECRET_KEY);
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------
// Verify the Stripe-Signature header per Stripe's spec:
//   t=<timestamp>,v1=<signature>[,v0=<old>]
// signed payload = `${timestamp}.${rawBody}`, HMAC-SHA256 with STRIPE_WEBHOOK_SECRET.
// Constant-time comparison on the hex string to avoid timing leaks.
export async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | null,
  toleranceSeconds = 300,
): Promise<{ ok: true; eventId: string } | { ok: false; reason: string }> {
  if (!STRIPE_WEBHOOK_SECRET) return { ok: false, reason: "webhook_secret_unset" };
  if (!sigHeader) return { ok: false, reason: "missing_signature_header" };

  // Parse "t=...,v1=..." into a flat object. Stripe also sends v0 (legacy);
  // we ignore it — only v1 is required to be valid for the request to be
  // accepted.
  const parts: Record<string, string> = {};
  for (const seg of sigHeader.split(",")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).trim();
    if (k && v) parts[k] = v;
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: "malformed_signature_header" };

  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid_timestamp" };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) {
    return { ok: false, reason: "timestamp_outside_tolerance" };
  }

  // HMAC-SHA256 over `${t}.${rawBody}` using STRIPE_WEBHOOK_SECRET.
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`));
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison (length first, then char-by-char XOR fold).
  if (computed.length !== v1.length) return { ok: false, reason: "signature_mismatch" };
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ v1.charCodeAt(i);
  }
  if (diff !== 0) return { ok: false, reason: "signature_mismatch" };

  // Pull the event id out of the body for idempotency-key use by callers.
  // We do this AFTER verifying the signature so the body is trusted.
  let eventId = "";
  try {
    const parsed = JSON.parse(rawBody);
    eventId = String(parsed?.id || "");
  } catch {
    // Caller will catch the JSON parse separately when it tries to handle the
    // event; here we just return ok=true with empty eventId so the caller can
    // make its own choice about how to log/report.
  }
  return { ok: true, eventId };
}

// ---------------------------------------------------------------------------
// Checkout Session creation
// ---------------------------------------------------------------------------
// POST /v1/checkout/sessions — Stripe-hosted checkout. Returns the URL to
// redirect the user to. mode=subscription means Stripe will create a
// subscription on success and the resulting customer.subscription.created
// webhook will hit our /api/billing/stripe-webhook endpoint.
export async function createCheckoutSession(args: {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
}): Promise<{ url: string; id: string }> {
  if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY not set");

  // Stripe REST expects application/x-www-form-urlencoded for everything,
  // including nested fields like line_items[0][price]. URLSearchParams handles
  // this cleanly.
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("line_items[0][price]", args.priceId);
  params.set("line_items[0][quantity]", "1");
  params.set("success_url", args.successUrl);
  params.set("cancel_url", args.cancelUrl);
  if (args.customerEmail) params.set("customer_email", args.customerEmail);
  for (const [k, v] of Object.entries(args.metadata || {})) {
    params.set(`metadata[${k}]`, v);
  }

  const resp = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-10-28",
    },
    body: params,
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Stripe checkout/sessions ${resp.status}: ${txt.slice(0, 400)}`);
  }
  const data = (await resp.json()) as { url: string; id: string };
  return { url: data.url, id: data.id };
}
