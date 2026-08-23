# ADR-0007 — Hosting: Railway (one platform for everything)

**Decision.** Railway hosts `apps/server`, `apps/web` (static build), Postgres, and Redis as managed services on private networking.

**Why.**

- Long-lived SSE + BullMQ workers + cron jobs need always-on processes; serverless (Vercel/Cloudflare Workers) doesn't fit.
- Railway's managed Postgres + Redis with auto-injected `DATABASE_URL` / `REDIS_URL` is one-dashboard ops for a solo dev.
- Predictable flat-ish pricing (~$10–20/mo total at personal scale).
- GitHub-push deploys, multi-environment branches if needed, private networking between services.
- Already familiar from milkpod.

**Alternatives.**

- Single VPS (rejected — burns time on Postgres backups, Redis persistence, TLS, OS updates).
- Fly.io (rejected — Railway has flatter ergonomics for solo dev).
- Home server / Tailscale (rejected — home-internet flakiness, missed scheduled briefings if machine sleeps).
- Vercel + separate server (rejected — no upside for an authenticated SPA, more dashboards to babysit).
