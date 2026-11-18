# Alchemy × Railway deployment probe — 2026-11-18

Evidence for [ADR-0128](../decisions/ADR-0128-railway-deployment-config-is-an-alchemy-program.md). One end-to-end probe of Alchemy (`alchemy` + `@alchemy.run/railway`, Infrastructure-as-Effects) declaring Railway infrastructure as a typed TypeScript program: scratch project created, deployed, verified live, re-deployed, and destroyed. The working probe (scaffold, docs research, run logs) lives in `references/scratch/alchemy-railway-probe/` (gitignored); this doc records the durable findings.

## What ran

- `bun alchemy plan --stage probe` → 6 creates + 3 bindings, computed in ~0.9 s.
- `bun alchemy deploy --stage probe --yes` → **6/6 succeeded in 2m02s**: Project, Effect-native Service, private Postgres, Redis, Volume, RPC token. The Service is bundled by Alchemy, uploaded as a tar build context ("the same way `railway up` does"), and built by Railway — **no local Docker daemon, no registry, no git integration**.
- Live verification over the service's public URL: `/health` → `{"ok":true}`; `/redis` → `{"value":"hello"}` (Redis write + read); PUT→GET file → the written string (volume persists); `/pg` → the private `*.railway.internal:5432` connection string, **redacted by Alchemy as a secret in the response**.
- Idempotency: second `deploy` → **`Plan: no changes` in 7 ms**.
- `bun alchemy destroy --stage probe --yes` → **6/6 deleted in 22.7s** in reverse dependency order; `railway list` afterwards shows only the real `alfred` project — nothing left billing.

## Version pin (the docs are stale)

The Alchemy Railway docs say `effect@rc`. That breaks the CLI at boot: `alchemy@2.0.0-beta.87` peers on **`effect@^4.1.4` stable** (`@effect/platform-bun@^4.1.4`, `@effect/platform-node@^4.1.4`); with `effect@4.0.0-rc.118` the CLI dies with `Cannot find module .../effect/dist/SemVer.js` — `SemVer` no longer exists in the rc. Pin `alchemy` + `@alchemy.run/railway` + `effect` together.

## Code fixes over the docs' example (all caught by `tsc --noEmit`)

1. `HttpServerResponse.json(...)` returns an Effect in Effect 4 — the fetch handler must `yield*` it, not return it raw.
2. `Effect.catchAll` was renamed — Effect 4 uses `Effect.catch`.
3. Infra errors (Redis `CommandError`, runtime faults) leak into the fetch handler's error channel, which only allows `HttpBodyError | HttpServerError` — the handler needs a catch into a 500 response.

The type checker caught all three before anything deployed.

## Setup friction

- The one-time OAuth setup (`alchemy profile edit --add Railway`) is **interactive-only**: `--method` accepts `stored`/`env` only; OAuth cannot be passed flags. The TUI force-disables itself for coding agents — `isNonInteractive()` (`alchemy/src/Util/interactive.ts`) detects the `OPENCODE` env var, and `ALCHEMY_TUI=1` overrides the detection but a spawned pty in agent *background* shells received no keyboard input at all (arrow keys never moved the highlight). The pairing had to be completed in a real terminal.
- The automatable auth path is a token: create an account/workspace token (a *project* token cannot create projects), then `alchemy profile edit --add Railway --method stored --set token=env:RAILWAY_API_TOKEN`.
- `alchemy provider check-env` only checks the env-var path, not a stored OAuth credential — it reports "Missing" even when the profile is connected.

## Known sharp edges (accepted, from the probe run)

- Pre-1.0 beta on both packages (beta.87, npm activity through 2026-11-12); expect breaking changes between betas.
- `alchemy logs` does not support Railway services ("logs live in the Railway dashboard").
- Every Service bundle prints one harmless warning: `[UNRESOLVED_IMPORT] Could not resolve 'mongodb'` from the provider's own `Mongo.ts` (treated as external).
- Effect-native `main` Services require the deployed program to be Effect (`{ fetch }` contract). Plain apps (our Elysia server) use `context:` (local dir Railway builds) or a prebuilt `image:` instead — both documented, both Effect-free.

## Open questions this probe did not answer

1. **Adoption of the existing prod project.** The provider silently re-adopts same-named *orphans* it owns, and `alchemy plan --adopt` previews foreign-resource takeover in general — but per-resource takeover of a foreign, dashboard-created Railway project is not documented and was not tested against the real `alfred` project. This is the first experiment of a cutover.
2. **`RAILWAY_GIT_COMMIT_SHA`.** Alchemy deploys by context upload, not git; the docs never mention the variable, and the probe could not verify whether Railway sets it on such deploys. The memory pipeline reads this variable as the deployed commit (`docs/theory/memory.md`), so cutover must re-verify or re-source it (e.g. `GITHUB_SHA` written as a deploy Variable).
3. Whether a `main` Service can run a plain Bun server without the Effect contract (undocumented; assume no).
4. The two doc pages disagree on the generated Dockerfile base (`oven/bun:1` vs `node:26-slim`); overridable either way.
