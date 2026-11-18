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

## Cutover gate experiments — 2026-11-18 (both D2 gates answered)

Ran the two experiments ADR-0128 D2 gates production cutover on, against the real `alfred` project (read-only) and a scratch foreign project (apply). Everything below is verified by execution. Probe stacks live in the probe dir: `lookup.run.ts` (lookup path), `adopt.run.ts` / `adopt-services.run.ts` (takeover preview), `adopt-gate.run.ts` (takeover apply), `env.run.ts` + `src/env-service.ts` (commit-SHA probe).

### Real project topology (read from the dashboard API, 2026-11-18)

Project `alfred` (`0ec1ea83-…`), environment `production` (`9fbd12bc-…`), region `asia-southeast1-eqsg3a`:

| Service | Id | Source |
|---|---|---|
| `Postgres` | `05cab70e-…` | image `ghcr.io/railwayapp-templates/postgres-ssl:18`, own volume (`a21517da-…`, `/var/lib/postgresql/data`) |
| `Redis-E37o` | `12810bc1-…` | image `redis:8.2.9`, custom start command (AOF off, volume-backed), volume (`accc04aa-…`, `/data`) |
| `web` | `2155bb3b-…` | repo `99Yash/alfred` @ `main`, RAILPACK, build `pnpm install --frozen-lockfile && pnpm turbo run build --filter=web` |
| `server` | `822564df-…` | repo `99Yash/alfred` @ `main`, RAILPACK, build `…--filter=server`, start `node apps/server/dist/index.js`, healthcheck `/health` |

### Gate 1a — foreign-resource takeover (`alchemy plan --adopt`, then an apply)

- **Ownership detection works.** Declaring `Railway.Project("Project", { name: "alfred" })` against a fresh state, a read-only plan **fails with typed `OwnedBySomeoneElse`** — the provider's `read` finds the dashboard-created project by name and classifies it unowned (`matchesAlchemyPhysicalName` is the only ownership signal; "alfred" doesn't match the alchemy-name pattern).
- **`--adopt` previews takeover.** The same plan with `--adopt` shows `[Project] adopted`. Per-resource takeover of a foreign, dashboard-created project **works at plan time**.
- **Service adoption is deferred to apply.** With the project declared as a resource reference (managed or lookup'd), the Service's plan-time `read` never runs — the engine skips the ownership probe while `news` still carries the unresolved upstream reference (`Plan.ts:1749`), and the plan shows a tentative `[Server] create` carrying `deferredAdoption`. The probe runs at apply with fully resolved props (`Apply.ts:965`): an `Unowned` result with `--adopt` feeds the found attributes into `reconcile` as `output`, so it **updates the existing service in place instead of creating a duplicate**.
- **Apply verified end-to-end on a scratch foreign project** (`adopt-gate-prod`, created via the dashboard API with a foreign-named `server` service): `alchemy deploy --adopt` → `[Project] adopted` + the Service's apply-time probe adopted the pre-existing service — output `serverId` equals the dashboard-created service id, no duplicate created (21.3 s). Teardown `destroy` removed all 3 resources in 5.1 s.
- **Adoption side effect to handle at cutover:** adopting a Service with default props **created a public domain** (`publicDomain` defaults true; the existing `server` has a domain already but the adopt flow created a new generated one). The cutover program must set `publicDomain`/domain props to match the existing services before or during adoption.

### Gate 1b — the `.lookup` path (better than adoption for the databases)

`Railway.Project.lookup({ projectId })` exists in the provider (undocumented in the Railway docs) and so do `Postgres.lookup`, `Redis.lookup`, `Volume.lookup` — all keyed by ids. Verified read-only against the real project: a stack of pure lookups + scratch-project `Variable` consumers resolved **real values** (private Postgres `connectionUri` with password, `Redis-E37o.railway.internal`, image `ghcr.io/railwayapp-templates/postgres-ssl:18`, volume mount paths/size) in a 3.2 s plan; the scratch consumers deployed in 3.1 s and destroyed in 2.4 s with the real project untouched.

- Lookups **never create, adopt, or write state** — the non-destructive reference for resources the program doesn't manage yet.
- Cutover shape this enables: declare the real project as a **lookup** (so `destroy` can never delete it), adopt/declare the app services, and leave the dashboard-created `Postgres`/`Redis-E37o` as lookups (their names sanitize to lowercase — `resolveName` lowercases — so a `Railway.Postgres("Db", { name: "Postgres" })` would **not** match the capitalized existing service by name; renaming on adopt is possible but the lookup path is safer).
- Caveat: stack **outputs** of lookup attributes are not secret-redacted — the deploy log printed the private Postgres URI including its password. Never return secrets as stack outputs.

### Gate 2 — `RAILWAY_GIT_COMMIT_SHA` on a context-upload deploy: **not set**

Deployed an Effect-native Service via Alchemy's tar-context upload (scratch project) and dumped the container env over a public `/env` route. Result:

- **`RAILWAY_GIT_COMMIT_SHA` is absent**, and `RAILWAY_GIT_BRANCH` too. Railway's docs describe the variable only for git-triggered deploys.
- `RAILWAY_GIT_REPO_OWNER` / `RAILWAY_GIT_REPO_NAME` are present but **empty strings** — on the real prod server (git deploys) they carry `99Yash`/`alfred`. Two consumers break under the cutover unless re-sourced:
  1. **Sentry release attribution** — `apps/server/src/instrument.ts` leaves `release` unset so the SDK reads `RAILWAY_GIT_COMMIT_SHA`.
  2. **The memory producer's deployed-commit field** — `docs/theory/memory.md` names `RAILWAY_GIT_COMMIT_SHA` as the source, and cites `RAILWAY_GIT_REPO_OWNER`/`RAILWAY_GIT_REPO_NAME` as the config evidence for the name link "the code of Alfred is 99Yash/alfred".
- The ADR's fallback therefore applies: at `alchemy deploy` time, write the commit into the service environment as a Variable (CI's `GITHUB_SHA`, plus the repo owner/name), and re-source the ingest + Sentry (`SENTRY_RELEASE` or equivalent). Whether Railway allows user-set `RAILWAY_*`-prefixed Variables is unverified — if rejected, use a neutral name (`ALFRED_DEPLOYED_COMMIT_SHA`) and update the theory page's ingest source at the cutover PR.

### D2 status after these experiments

Both gates are answered and unblock the cutover slice:

1. Foreign takeover works (plan preview + apply, in-place, no duplicates) — and the lookup path is the better default for anything the program shouldn't manage yet.
2. `RAILWAY_GIT_COMMIT_SHA` is absent on context-upload deploys; the deployed-commit ingest and Sentry release must be re-sourced from a deploy-time Variable. No repo code changes yet — that lands with the cutover slice (D1 `infra/` program).
