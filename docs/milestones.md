# Milestone status

- 1 — Scaffold
- 2 — Auth + first Railway deploy
- 3 — Replicache MVP
- 4 — Realtime stack (outbox → Redis → SSE)
- 5 — Durable agent runtime
- 6 — Cost metering
- 7 — Gmail integration end-to-end (7a OAuth+raw ingest, 7b embeddings+search, 7c poll+webhook code; webhook activation deferred — see [pending-setup.md](../pending-setup.md))
- 8 — Memory primitives
- 9 — Email triage workflow (9a schema + Gmail label plumbing, 9b classifier + workflow, 9c trigger from poll_history, 9d smoke-triage)
- 10 — Morning briefing workflow (10-pre per-feature scope sets + requireScopes; 10a email_sends + notify(); 10b morning-briefing workflow; 10c hourly briefing.tick + tz resolution; 10d smoke-briefing). Inbox-only at v1; calendar deferred.
- 11 — Cold-start research at signup (11a `getResearchModel()` + Perplexity Sonar Deep Research wired through `meteredGenerateText` with `kind='web_search'`; 11b `packages/api/src/modules/cold-start/` — signal collector, research call, cheap-tier extractor, dedup; 11c `cold-start-research` builtin workflow with steps `gather-signals` → `research` → `extract-facts` → `persist`; 11d trigger from `google-routes.ts` `/callback` gated by `hasPriorColdStartRun` so a re-connect doesn't re-run; 11e `smoke-cold-start.ts`). Signals are extensible per-integration — Google contributes `accountEmail` today; future GitHub/etc. integrations plug into `collectColdStartSignals` without workflow change. v1 trigger fires from the OAuth callback because Google is currently the only integration that contributes signals beyond the user row; revisit once another integration lands.
- 12 — Skills + user-authored workflows: authoring surface + trigger dispatch only; execution deferred to m13 per ADR-0017 + ADR-0027. Brief-only authoring (no DAG editor), `cron` + `manual` triggers live, `event`/`on_signal` UI-disabled until m13. The planned failed-run execution stub was scoped out before ship; pre-m13 user-authored dispatches threw on registry miss before inserting an `agent_runs` row. See [`CONTEXT.md`](../CONTEXT.md) for the locked m12 scope and ADR-0027 for the trigger-dispatch design.
- 13 — Boss + sub-agent orchestration. Fills m12's user-authored execution gap. Builds the tool registry + tool dispatcher + `system.load_integration` + `AlfredAgent`→runtime bridge + sub-agent spawning + `event`/`on_signal` dispatchers all in one pass (ADRs 0016, 0026, 0040).
- 14 — MCP client
- 15 — Observability
