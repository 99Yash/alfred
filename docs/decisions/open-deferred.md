# Open / deferred

Items intentionally not decided yet. Each is a future ADR when its time comes.

**Deferred features:**

- **iMessage ingestion** — no clean public path. Options when revisited: periodic local-export script + manual upload, or `chat.db` reading from synced files. Not blocking v1.
- **Voice / phone calling** — `LiveKit Agents` is the natural revisit point if this becomes a goal (ADR-0004).
- **MCP server** (alfred-as-MCP-server for external agents to consume) — addable later as a wrapper over `packages/api` tools (ADR-0018).
- **Push / Slack DM / SMS notifications** — schema is forward-compatible (`notification_preferences.channels` is a jsonb list); add when v1 email-only proves insufficient (ADR-0020).
- **Email-reply parsing for memory correction** — structured emails with deep-link-to-app cover the use case at v1; revisit if free-form reply parsing becomes worth the brittleness (ADR-0019).
- **Background-task activity log UI** — flat table of recent agent runs (date/time, workflow, trigger reason, cost) with live updates as `agent.run` SSE frames arrive. Data is already in place: `agent_runs` (status, started_at, ended_at, output, metadata), `api_call_log` (sum cost_usd by run_id), `agent.run` events on the outbox/SSE bus. Implementation is one `GET /api/runs` rollup endpoint + a web route that subscribes to the existing SSE stream. Lighter than the M15 agent-trace UI (which gets the run-tree + per-step prompt/response inspection) — they should coexist, not collapse. Pick up alongside or before M15.
- **Category-aware ingestion filter** — skipping `CATEGORY_PROMOTIONS`/`SOCIAL`/`FORUMS` at the realtime `persistMessage` gate would cut embedding + triage + attachment-extraction cost on the long tail. Deferred because Gmail categories are mutable: a message a user later moves from Social to Primary should pick up full processing, and at-ingest filtering loses that signal without a "category-change" reprocessor. Revisit when observed spend on PROMO/SOCIAL/FORUMS work materially exceeds tolerance, or as part of a broader "re-ingest on label change" path. Until then, all PRIMARY + non-PRIMARY mail flows through the same pipeline.

**Pinned at implementation time:**

- **Specific model SKUs** for boss/sub-agent/embedding/web-search — pulled from `models.dev` at implementation; ADRs name families (Voyage, Sonnet, Sonar Pro), not specific revisions (ADRs 0016, 0021, 0022).

**Tactical / not-architectural (decide while building):**

- Testing strategy (vitest baseline from milkpod; integration tests against a real Postgres via testcontainers).
- CI/CD specifics (Railway GitHub-push deploys; PR previews if needed).
- Secrets management (Railway env vars; Doppler/Infisical only if multi-env complexity grows).
- Package layout details (mostly mirrors milkpod's `packages/{ai,api,auth,config,db,env,sync}` plus new `packages/{integrations,ingestion}`).
- Drizzle migration workflow (already standardized in milkpod's `docs/database.md`).
- Search namespace warming pattern (dimension does this; layered onto ADR-0010's hybrid policy as part of integration ingestion).
