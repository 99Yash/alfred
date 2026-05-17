# Cold-start research (m11)

Per ADR-0011 + ADR-0022 alfred runs one Perplexity Sonar Deep Research call per user at signup, extracts structured `user_facts` proposals from the result, and stores the freeform research as a `memory_chunks` row for later semantic recall. Lifetime-once per user.

The pipeline:

1. The Google OAuth callback (`google-routes.ts /callback`) calls `createRun({ workflowSlug: COLD_START_WORKFLOW_SLUG, … })` + `enqueueRun(runId)`. The workflow declares `dedupKey: () => 'cold-start'`, and the partial unique index `agent_runs_dedup_key_idx` on `(user_id, workflow_slug, dedup_key) WHERE dedup_key IS NOT NULL AND status NOT IN ('failed','cancelled')` is the authoritative gate — a duplicate insert (re-connect, second tab) trips Postgres `23505`, which the callback catches and logs. Other failures are also logged but don't bounce the user back to an error page.
2. The `cold-start-research` workflow (`apps/server/src/builtins/workflows/cold-start-research.ts`) runs `gather-signals` → `research` → `extract-facts` → `persist`:
   - `gather-signals` calls `collectColdStartSignals(userId)` — reads the `user` row + connected `integration_credentials` per provider, ordered by `created_at` ASC so multi-account users get a deterministic anchor. v1 contributes `{ name, email, emailDomain, emailDomainIsConsumer, integrations.google? }`.
   - `research` calls `researchUser({ signals })` — one `meteredGenerateText` call against `getResearchModel()` (Perplexity `sonar-deep-research`) with `attribution.kind = 'web_search'`. 30–120s; returns prose + extracted citations. The forwarded `idempotencyKey` is stable per-run (`cold-start.research:${runId}`) — Sonar has no idempotency-key API, so this is observability metadata only; a worker-crash retry will re-bill.
   - `extract-facts` calls `extractColdStartFacts({ signals, research })` — cheap-tier (`getCheapModel()` + `meteredGenerateObject`) converts research prose into structured `{ key, value, confidence, rationale }` proposals.
   - `persist` calls `proposeFact()` per proposal (auto-confirm at confidence ≥0.85 per ADR-0019; existing rejection + active-dup guards apply) and `writeMemoryChunk({ kind: 'cold_start_research', … })` for the research summary. Embedding lands via the existing memory embed-sweep.
3. Cost lands as one `web_search` row + one cheap-tier `llm` row in `api_call_log`, attributable to the run via `(run_id, step_id)`.

Trigger semantics:

- The OAuth callback is the trigger because Google is currently the only integration that contributes signals beyond the user row. When more integrations land (GitHub, …), the trigger should move to whatever signal indicates "onboarding finished" — probably an explicit `cold-start ready` event once an onboarding flow exists.
- Lifetime-once is enforced by the unique index — there is no input-level `force` toggle. Letting `force` be caller-controlled would let any authenticated user spam expensive Sonar runs through `/api/agent/runs`. To re-research a user (future settings button, smoke script), cancel the prior `agent_runs` row first so the new insert clears the partial index.

Smoke: `pnpm --filter server tsx --env-file=.env src/scripts/smoke-cold-start.ts` (cancels any prior cold-start run for the first user, then forces a fresh one; verifies the research → extract → persist pipeline lands a `memory_chunks` row plus zero-or-more `user_facts` proposals tagged `source.kind='cold_start'`). Requires `PERPLEXITY_API_KEY`.
