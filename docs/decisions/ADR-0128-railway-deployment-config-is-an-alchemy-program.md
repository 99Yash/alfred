# ADR-0128 — The Railway deployment config is an Alchemy program (ACCEPTED — 2026-11-18)

**Status.** Accepted, staged. Amends [ADR-0007](./ADR-0007-hosting-railway.md) (hosting stays Railway), relates to [ADR-0114](./ADR-0114-effect-runs-the-mcp-connection-lifecycle-and-nothing-else.md) and [ADR-0129](./ADR-0129-effect-is-an-allowed-dependency-and-the-migration-is-gradual.md) (Effect adoption), and leaves [ADR-0108](./ADR-0108-infrastructure-cost-is-a-memory-shape-problem-not-a-platform-problem.md) untouched.

**Problem.** The deployment topology — server, web, Railway-managed Postgres with pgvector, Redis, private networking — exists only in the Railway dashboard plus an implicit Nixpacks build. The repo states none of it, nothing checks it, and ADR-0007's one-dashboard ergonomics have a cost the record never priced: the topology is memory, and memory is exactly what a platform switch burns. The owner's stated hedge — "if Railway is down, we might switch" — is not served by anything that exists today; leaving Railway would be a manual rebuild from recollection.

**Decision.** Alfred declares its Railway infrastructure as one typed TypeScript program using [Alchemy](https://alchemy.run) (`alchemy` + `@alchemy.run/railway`, Effect 4 runtime), versioned in the repo and applied with `alchemy deploy`. Hosting stays Railway; ADR-0108's cost verdict is untouched — this changes where the config lives, not what runs. Adoption is staged: the probe round-trip is done and the production cutover waits on the acceptance criteria below.

**Evidence.** Full probe round-trip on 2026-11-18 against a scratch project (measured numbers and every friction in [`docs/research/alchemy-railway-probe.md`](../research/alchemy-railway-probe.md); working probe in `references/scratch/alchemy-railway-probe/`): plan of 6 resources + 3 bindings in ~0.9 s; deploy in 2m02s with the service shipped as an uploaded build context (no Docker daemon, no git); live `/health`, Redis write+read, volume persistence, and a private Postgres URI that Alchemy itself secret-redacts; a second deploy proving **`Plan: no changes` in 7 ms**; and a destroy that removed 6/6 resources in 22.7 s with nothing left in the workspace. The type checker caught three real API mismatches in the docs' own example before anything deployed — the compiler carries the proof, which is the house style for gates.

## D1 — The infra program is its own program, outside app code

- One program (`alchemy.run.ts` + resource modules, e.g. under `infra/`) declares the topology. It imports `effect` — Alchemy v2 is Effect-native and its resources are typed through it.
- This is the first Effect use outside the ADR-0114 island. ADR-0129 (2026-11-18) opens Effect adoption generally at a gradual pace, so no adoption ADR was needed; the program follows the same per-module discipline — its public interface is a CLI, not app types.
- The program carries no business logic. Infrastructure binds to the app through environment variables only. If a resource seems to need app wiring inside the infra program, that is a smell to raise, not a capability to extend.

## D2 — The deploy trigger changes, and the memory ingest must follow (gating criterion)

- Today Railway builds on GitHub push, and the memory pipeline reads `RAILWAY_GIT_COMMIT_SHA` as the deployed commit (`docs/theory/memory.md`). Under Alchemy, the deploy is a context upload; the probe could not verify that Railway sets `RAILWAY_GIT_COMMIT_SHA` on such deploys, and the docs are silent.
- **No production cutover until the deployed-commit ingest reads a source that is proven on both the old and the new trigger** — verify Railway still sets the variable on context-upload deploys, or write the CI commit (`GITHUB_SHA`) into the service environment at deploy time and re-source the ingest.
- The first cutover experiment is `alchemy plan --adopt` against the real `alfred` project in a read-only plan: the probe proved adopt of owned orphans and preview machinery, but not takeover of a foreign, dashboard-created project.

## D3 — State is local, and recovery is the documented default

- `Alchemy.localState()` keeps state under `.alchemy/` (gitignored). A wiped state store re-adopts owned resources silently on the next deploy; foreign-looking resources fail with a typed `OwnedBySomeoneElse` instead of being adopted by accident. No new cloud dependency for state — the Postgres state backend exists if a second machine ever needs it, and needs no new provider either (ADR-0008's Postgres).

## D4 — Version pin and known frictions, accepted

- Pin `effect@^4.1.4` stable together with `alchemy` and `@alchemy.run/railway` at the same beta. The docs' `effect@rc` is stale and breaks the CLI boot (`effect/SemVer` is gone at rc.118) — probe finding.
- Accepted frictions: pre-1.0 beta churn on both packages; `alchemy logs` unsupported for Railway (logs stay in the dashboard); one harmless `mongodb` unresolved-import warning per Service bundle; OAuth setup is interactive-only, so the automatable path is a stored token (`--method stored --set token=env:RAILWAY_API_TOKEN`).

## Amendment 2026-11-18 — both D2 gates answered; cutover slice built

Evidence in [`docs/research/alchemy-railway-probe.md`](../research/alchemy-railway-probe.md), section "Cutover gate experiments". Both gates ran against the real project (read-only) and a scratch foreign project (apply):

- **Foreign takeover works.** `alchemy plan --adopt` previews the adoption of the dashboard-created project per-resource, and the apply-time ownership probe takes over a foreign-named service **in place** (output id equals the pre-existing service id; no duplicate). Service adoption is deferred to apply because the project reference is unresolved at plan time — the plan shows a tentative create. Adoption side effect to handle: with default props it mints a second public domain, so the cutover program sets `publicDomain: false` (which never deletes a domain the program does not own).
- **The `.lookup` path exists and is the better default for what the program should not manage yet.** `Project.lookup` / `Postgres.lookup` / `Redis.lookup` / `Volume.lookup` resolve real prod values read-only; a lookup never creates, adopts, writes state, or can be destroyed. It also dodges the lowercase-name hazard: the provider lowercases declared names, so the capitalized dashboard service `Postgres` cannot be matched by name.
- **`RAILWAY_GIT_COMMIT_SHA` is not set on context-upload deploys** (measured: an Effect-native Service's container env held no commit SHA, no branch, and `RAILWAY_GIT_REPO_OWNER`/`RAILWAY_GIT_REPO_NAME` empty). The D2 fallback therefore applies: the trigger-switch slice must write the commit (and repo identity) into the service environment at `alchemy deploy` time and re-source the two consumers — Sentry release attribution (`apps/server/src/instrument.ts`) and the memory producer's deployed-commit field (`docs/theory/memory.md`).
- **The cutover slice is in the repo** under `infra/` as a workspace member: the program lookup-declares the project and the two databases (destroy-proof), manages the two app services with their current GitHub source (deploy trigger unchanged), and every plan proves the databases exist through a pure `VerifyDatabases` action. The first adoption is `pnpm --filter @alfred/infra adopt`. The version triple is catalog-pinned (owner approved the `effect` 4.0.6 → 4.1.4 bump; see the ADR-0129 amendment).

## Alternatives weighed

- **Keep dashboard-only (status quo).** The gap stays. Rejected because the topology is already non-trivial (6 resources + private net + two managed databases), the repo's own style is compiler-carried proofs, and the platform-switch hedge has no story without config-as-code.
- **Terraform/OpenTofu with the Railway provider.** HCL, codegen, no per-PR stage model, no local emulation; the most machinery for the smallest topology. Rejected.
- **Pulumi.** TypeScript, but a state backend + engine + provider stack is overkill for 6 resources on one platform. Rejected.
- **`railway.json` / config-as-repo-files.** Captures per-service build config but not the database/volume/private-net topology, and nothing checks it against reality. Rejected.

## Why not "nothing until Railway actually breaks"

An outage is survived by Railway, not by us — no tool helps mid-incident. What IaC buys is the *decision* to leave: the same program shape has first-class Fly, AWS, GCP, and Hetzner providers, so the hedge becomes an edit to the provider wiring plus an adopted-state migration, not a rebuild from memory. That is the only honest version of "we might switch", and it costs one program and one CLI in exchange.
