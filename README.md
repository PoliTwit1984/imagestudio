# Darkroom

> Multi-engine NSFW-permissive image editor with chain-builder ambitions.

Multi-engine creative photo editor: Lens (Grok img2img), Glance (Nano Banana), Strip (P-Edit), Brush (Flux Fill Pro), Eye (gpt-image-2), Frame (Bria), Skin (Enhancor), Lock (face-swap), Develop (Topaz), Reveal (Magnific), Cutout, Sharpen, Restore, Watch (auto-routing).

Built on Bun + Supabase + Railway.

## Quick start

```bash
bun install
bun run dev
```

Required env vars (place in `.env` at repo root): `XAI_API_KEY`, `FAL_API_KEY`, `OPENAI_API_KEY`, `REPLICATE_API_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AUTH_TOKEN`. Optional: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (gates billing).

Apply migrations from `migrations/` against your Supabase DB (numbered 0042 onward).

## Repo

`PoliTwit1984/darkroom` (formerly `PoliTwit1984/imagestudio`). GitHub honors redirect.

## Plan

See `PLAN.md` for the live build plan and `agentic-plan.yaml` for the orchestrator-friendly task graph.
