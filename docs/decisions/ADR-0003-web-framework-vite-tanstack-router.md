# ADR-0003 — Web framework: Vite + TanStack Router


**Decision.** Pure SPA with Vite + TanStack Router for `apps/web`.

**Why.** App Router has real dev-compile pain on medium codebases; Pages Router still pays SSR-and-bundling costs the SPA shape doesn't benefit from. Personal assistant is a single authenticated app behind a login — no SEO, no static pre-rendering, no RSC payoff. Vite's HMR is dramatically faster than either Next router; TanStack Router gives typesafe routes; OAuth/integration callbacks belong on `apps/server` (Elysia) anyway, removing Next's last advantage.

**Alternatives.** Next.js Pages Router (rejected — still does SSR, in maintenance mode). Next.js App Router (rejected — dev compile pain, no RSC need).
