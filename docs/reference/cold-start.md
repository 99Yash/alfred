# Cold-start research (m11, v2)

Per ADR-0011 + ADR-0022 (v2 amendment) alfred runs one lifetime-once self-research pass per user at signup, extracts structured `user_facts` proposals from it, and stores the synthesized research as a `memory_chunks` row for later semantic recall.

**v2 replaces the stranded single Perplexity Sonar Deep Research call with the agent harness**, run bounded inside the deterministic onboarding workflow: a boss identity-resolution seed → bounded parallel aspect sub-agents over `system.web_search` (grounded Gemini 2.5 Flash) → boss synthesis → the unchanged extract → persist tail. The Sonar account lost billing; the agent path rides the Google key we already hold.

**Scope is the account holder only.** Company, role, team, and publicly attested relationship/family facts may land as `user_facts`/`memory_chunks` _about the user_; third parties get at most a one-line relation mention, never recursive research or their own rows.

**v2.0 is web-only** because new users default to `gated`, which would park live Gmail/Calendar reads in a watcher-less onboarding run. Read-only `calendar.list_events` + `gmail.search` aspects are a v2.1 follow-up, gated on the run-scoped autonomy override; `gmail.read_message` stays unavailable at callback time because it reads the not-yet-ingested `documents` store.

## The pipeline

The OAuth callback (`google-routes.ts /callback`) calls `createRun({ workflowSlug: COLD_START_WORKFLOW_SLUG, … })` + `enqueueRun(runId)`. The workflow (`apps/server/src/builtins/workflows/cold-start-research.ts`) runs six steps; the helpers live in `packages/api/src/modules/cold-start/`:

1. **gather-signals** — `collectColdStartSignals(userId)` reads the `user` row + connected `integration_credentials` per provider (ordered by `created_at` ASC for a deterministic anchor). Contributes `{ name, email, emailDomain, emailDomainIsConsumer, integrations.google? }`.
2. **seed** — `resolveIdentity({ signals })`. A boss-tier model with a local `web_search` tool, capped at a few searches (`stopWhen(stepCountIs)`), answers "which person is this, exactly?" — pinning the canonical public profile (LinkedIn / company bio / personal site / GitHub) that matches the name + work email. Returns a short prose **identity anchor** (`CONFIDENT:` / `NO CONFIDENT MATCH:` prefix). Mismatch here is the expensive failure mode; the boss is told to prefer "no confident match" over a false anchor.
3. **research-aspects** — `researchAspects({ signals, anchor })`. A small, deterministic set of aspect sub-agents (`professional`, `online`, `personal`, plus `employer` only when the email domain isn't consumer) run **concurrently** via `Promise.all`. Each is a sub-agent-tier model with the same bounded `web_search` loop, briefed on one facet with the identity anchor injected so all aspects research the same person, returning ~500 words of dense findings. A single aspect that throws degrades to an explicit empty finding rather than sinking the run.
4. **synthesis** — `synthesizeColdStart({ signals, anchor, aspects })`. The boss folds the anchor + every finding into one ~300-word telegraphic summary, deduping across facets and dropping anything a sub-agent reported as unattested. This summary is the `memory_chunk` content **and** the extractor input; it keeps the old `ResearchResult` shape so the tail below is byte-identical to v1.
5. **extract-facts** — `extractColdStartFacts({ signals, research })`. Cheap-tier (`getCheapModel()` + `meteredGenerateObject`) converts the summary into structured `{ key, value, confidence, rationale }` proposals (ADR-0019's two-stage extract tail, unchanged).
6. **persist** — `proposeFact()` per proposal (auto-confirm at confidence ≥0.85 per ADR-0019; rejection + active-dup guards apply) and `writeMemoryChunk({ kind: 'cold_start_research', … })`. Embedding lands via the existing memory embed-sweep.

**Relation guard** (threaded through the aspect briefs + synthesis prompt + extractor): attestation, not fame; never infer from a shared surname/city/coincidence; hedge or omit low confidence; for a public-figure relative, one clause on why they're notable; for minor children, "exists / how many" is the most that's reported.

## Cost & metering

Each `web_search` lands its own `api_call_log` row tagged `kind='web_search'` (it routes through the same `runWebSearch` the boss uses). Each reasoning turn (seed, every aspect, synthesis) is a `kind='llm'` row, and extract is one cheap-tier `llm` row — all attributable to the run via `(run_id, step_id)`. The aspect sub-agents run in parallel, so step 3's wall time is the slowest single aspect, not their sum.

## Idempotency & trigger

- **Lifetime-once** is enforced by the partial unique index `agent_runs_dedup_key_idx` on `(user_id, workflow_slug, dedup_key) WHERE dedup_key IS NOT NULL AND status NOT IN ('failed','cancelled')` — the workflow declares `dedupKey: () => 'cold-start'`, so a duplicate `createRun` (re-connect, second tab) trips Postgres `23505`, which the callback catches and logs. There is no input-level `force` toggle (it would let any authenticated user spam expensive runs through `/api/agent/runs`). To re-research a user, cancel the prior `agent_runs` row first so the new insert clears the index.
- Each step **checkpoints** its result, so a worker crash re-runs only the failed step (re-billing just that step's LLM + web_search calls — cheap; no checkpoint cache warranted).
- The OAuth callback is the trigger because Google is currently the only integration contributing signals beyond the user row. When more integrations land, the trigger should move to whatever signal indicates "onboarding finished."

## Smoke

`pnpm --filter server tsx --env-file=.env src/scripts/smoke-cold-start.ts` (cancels any prior cold-start run for the first user, then forces a fresh one; verifies the seed → aspects → synthesis → extract → persist pipeline lands a `memory_chunks` row plus zero-or-more `user_facts` proposals tagged `source.kind='cold_start'`). Requires `GOOGLE_GENERATIVE_AI_API_KEY` (required env, so a configured dev tree already has it).
