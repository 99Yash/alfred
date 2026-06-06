# Chat turn: latency, blank-UI, and GitHub tools — investigation + fixes

**Date:** 2026-06-06
**Trigger:** On prod (`yashgouravkar@gmail.com`), the chat message *"how many pr's did i close in the past week?"* appeared stuck for minutes, showed cryptic tool cards, then a `spawn sub agent failed` card, and finally gave up with *"I can't directly count your closed PRs… using my current tools."*

This doc captures the full investigation, the (surprising) root causes, the evidence, what was fixed, and what remains.

---

## TL;DR

Four independent problems were stacked on top of each other:

1. **Orchestration latency (the real "slowness").** The model was *not* slow — all LLM calls in the 6-minute prod run totalled **8.5 seconds**. The other ~5.5 minutes was **dead time between workflow steps**, caused by a step-row `attempt` reset that collides with `agent_steps`' unique key on loop re-entry, so the run stalled ~60–90s per step waiting for the stale-lease sweep. **Fixed.**
2. **Blank UI.** On a *new* chat, the `/chat → /chat/<id>` navigation reopens the SSE stream and the `chat.message` "started" event is lost; the client only initialized its stream state on that event, so every subsequent token/tool/thinking event was dropped and the turn rendered blank. **Fixed.**
3. **GitHub has no agent tools.** `GITHUB_ACTIONS = []`. The boss *could not* answer a PR question — it loaded the (toolless) integration, found nothing, and spawned a sub-agent as the only escape hatch. **Fixed** (added `github.search_pull_requests`).
4. **Sub-agent spawn crashes.** `spawnSubAgent` creates the child run with the parent's `chat-turn` workflow but no `threadId`, so `createRun` throws `"chat-turn workflow requires metadata.threadId"`. **Not fixed** (see Remaining work) — but with #3 the boss no longer needs to spawn for PR questions.

Also improved: the tool-call cards (integration logos + human labels + clean failure reasons) — see "Fixes applied."

---

## The big revelation: the model is fast; the orchestration is slow

The prevailing assumption was "the boss model (Gemini 2.5 Pro) is slow, ~5 min/turn." **The data disproves this.**

`api_call_log` for the prod run `run_4n9508ns3vuz` (the exact PR question):

| step (attempt) | model | latency_ms | in_tok | out_tok | finish | ended_at |
|---|---|---|---|---|---|---|
| chat-turn:0 | gemini-2.5-flash | 1890 | 846 | 72 | tool-calls | 10:22:20 |
| chat-turn:1 | gemini-2.5-flash | 2829 | 1020 | 161 | tool-calls | 10:23:41 |
| chat-turn:2 | gemini-2.5-flash | 3050 | 1378 | 222 | stop | 10:28:12 |
| (title gen) | gemini-2.5-flash-lite | 687 | 96 | 3 | stop | 10:28:12 |

- **Total model time: 8.5s.** Wall-clock for the run: **10:22:18 → 10:28:12 ≈ 6 minutes.**
- The chat path runs on **`gemini-2.5-flash`** (fast), *not* Pro. (`getChatModel("standard")` → `gemini-2.5-flash`; `getBossModel()`/`getSubAgentModel()` → `gemini-2.5-pro`, used by the headless brief workflow, not interactive chat.)
- The gaps are **between** calls: turn 0 → turn 1 is ~81s; turn 1 → turn 2 is ~4.5 min. Those are orchestration gaps, not model time.

> Note: `getChatProviderOptions()` enables Gemini thinking with `thinkingBudget: -1` (unlimited). That is *not* the bottleneck here (turns were 1.9–3s), but it is a knob if output latency ever matters: `packages/ai/src/provider.ts:~116`.

### Why the gaps happen (root cause #1)

`agent_steps` is unique on `(run_id, step_id, attempt)`. The chat workflow loops `chat-turn → dispatch-tools → chat-turn → …`. On each advance, `commitStepSuccess` reset **`attempt: 0`** for the next step (`packages/api/src/modules/agent/executor.ts`, "next" branch). But the *first* `chat-turn` already wrote a row at `attempt 0`. So re-entering `chat-turn`:

1. `tryInsertStepRow(run, "chat-turn", 0)` → unique violation → returns `false`.
2. `runOnce` returns `{ kind: "skipped", reason: "step_already_committed" }`.
3. The worker only re-enqueues on `kind === "advanced"`, so it **does nothing**.
4. `leaseRun` had already set the run to `running` with a fresh `last_checkpoint_at`, so the 30s resume sweep skips it (not stale) until the **60s `STALE_RUN_LEASE_MS`** elapses.
5. The stale sweep then reclaims it as a presumed-dead worker, bumps `attempt → 1`, marks the orphan row failed, and finally runs the step.

That 60s-stale + up-to-30s-sweep ≈ the observed **70–90s per loop iteration**.

**Evidence (local repro `run_c8h0d8500c36`, `agent_steps` timing):**

```
chat-turn      att0  10:43:36.295 → 10:43:38.742   (2.4s)
dispatch-tools att0  10:43:38.755 → 10:43:38.764   (instant; first visit, no collision)
chat-turn      att1  10:44:48.488 → 10:44:51.694   (gap 69.7s before it started)
dispatch-tools att1  10:46:18.483 → ...            (gap 86.8s before it started)
```

The attempt numbers climb only via the stale-reclaim path (0 → 1 → …), and `chat-turn:0 → dispatch-tools:0` was instant (dispatch's first visit, no row to collide with) while every *re-entry* stalled. That is the signature of the collision-then-stale-sweep path.

---

## Fixes applied

All changes typecheck (`pnpm check-types`, 14/14 packages). None are committed yet.

### 1. Orchestration latency — `packages/api/src/modules/agent/executor.ts`
`commitStepSuccess`, "next" branch: changed `attempt: 0` → **`attempt: attempt + 1`** (monotonic per-run execution counter). Each step execution now gets a unique `(run, step, attempt)`, so loop re-entry never collides → the immediate re-enqueue is processed right away → no stale-sweep wait.

- Safe because `ctx.attempt` is only used for attribution / idempotency keys (`stepId`, Langfuse, dispatch idempotency), never as a "first attempt" branch or a retry cap (verified by grep). The stale-reclaim (`+1`) and interrupt-resume (`+1`) paths already only increment, so the counter is monotonic and never repeats per step.
- **Expected effect:** ~6 min → ~10–15s for a 3-turn chat run.

### 2. Blank UI — `apps/web/src/lib/chat/use-chat-stream.ts`
Added `ensureStreamRef(messageId, runId)` and made `chat.reasoning` / `chat.delta` / `chat.tool` lazily initialize the stream state instead of dropping events when the `chat.message` "started" event was missed. (Keyed on both `messageId` and `runId`.) A missed "started" no longer blanks the turn.

### 3. Tool-call cards — `apps/web/src/routes/-chat/tool-call-card.tsx`
- Leading glyph is now the **integration's real logo** (`IntegrationGlyph` + `getIntegrationProvider`) instead of a generic wrench.
- Human labels: `system.load_integration` → "Connected to GitHub" (with logo); `system.spawn_sub_agent` → "Delegated a sub-task" (+ the brief inline); integration tools → humanized verb.
- Failure path: clean reason extracted from the result JSON in the expandable panel, instead of dumping raw `{"message":"…"}`.
- Reload fallback: `load_integration` reads the slug from `resultPreview` when `argsPreview` isn't persisted.

### 4. GitHub PR tools — make "count my PRs" actually work
- `packages/contracts/src/tools.ts`: `GITHUB_ACTIONS = ["search_pull_requests"]`.
- `packages/integrations/src/github/credentials.ts`: added `listGithubCredentials(userId)` (+ `GithubCredentialSummary`).
- `packages/integrations/src/github/pull-requests.ts` (new): `searchPullRequests({accessToken, q, perPage})` → GitHub REST Search API (`GET /search/issues`), returns `{ totalCount, incompleteResults, query, items[] }`. Plain `fetch` with `User-Agent` (GitHub rejects requests without one).
- `packages/integrations/src/github/index.ts`: barrel exports for the above.
- `packages/api/src/modules/tools/github.ts` (new): `github.search_pull_requests` (`riskTier: no_risk`). Structured input — `author` (default `@me`), `state` (open|closed|merged|all), `closedWithinDays`, `createdWithinDays`, `query`, `perPage` — that the tool composes into a GitHub query server-side (so the model doesn't have to compute dates). For the PR question: `state:"closed", closedWithinDays:7` → exact `totalCount`.
- `packages/api/src/modules/tools/index.ts`: registered `githubTools` in `registerBuiltinTools()`.

The boss already calls `system.load_integration("github")`; the next turn's `resolveSdkTools` now surfaces `github.search_pull_requests`, so it answers directly — no sub-agent needed.

---

## Remaining work

### A. Sub-agent spawn crash (not fixed — deliberately deferred)
`packages/api/src/modules/agent/sub-agents.ts:82` creates the child run with `workflowSlug: parent.workflowSlug`. For an interactive parent that's `chat-turn`, whose `initialState` requires `metadata.threadId` (`workflows/chat-turn.ts:688`) — which `spawnSubAgent` doesn't pass. `createRun` calls `initialState` synchronously (`service.ts:149`), so it throws `"chat-turn workflow requires metadata.threadId"` and no child row is created (confirmed: prod had zero `metadata->subAgent` rows).

**Fix:** sub-agents should run the headless brief loop, i.e. `workflowSlug: USER_AUTHORED_BRIEF_WORKFLOW_SLUG` (`workflows/user-authored-brief.ts`), which reads `subAgent` metadata, writes `scratch.<subId>.summary`, and needs only a `brief` (no `threadId`).

**Deeper gap:** even fixed, `chat-turn` has **no await/wake when a sub-agent completes** — spawn is fire-and-forget; the boss is expected to poll `system.read_scratch` on later turns (no parent re-enqueue on child completion exists; ADR-0016 line 829 / ADR-0035). So a chat spawn won't reliably surface a result in-turn. Decide whether interactive chat should support spawning at all, or whether the boss should always answer directly / escalate the whole turn into a brief run.

### B. Verify the latency fix live
The executor change needs a **server restart** to load. Then send any chat that loops (e.g. one that triggers a tool) and confirm `agent_steps` gaps are milliseconds, not ~70s. (Was not done here to avoid restarting the user's running dev server.)

### C. Optional speed knobs (not needed given the data, but available)
- `packages/ai/src/provider.ts:~116` — Gemini `thinkingBudget: -1` (unlimited). Cap or disable if output latency ever matters.
- `chat-turn.ts` agent instantiation — no `maxOutputTokens` cap.

---

## How to verify

**Latency (after server restart):**
```sql
-- local: docker exec alfred-postgres-1 psql -U alfred -d alfred
select step_id, attempt, status, started_at, ended_at
from agent_steps where run_id = '<new run>' order by started_at;
-- gaps between a step's ended_at and the next step's started_at should be ~ms.
```

**Model vs orchestration time:**
```sql
select model, latency_ms, step_id, created_at
from api_call_log where run_id = '<run>' order by created_at;
-- sum(latency_ms) ≈ model time; compare to run wall-clock (agent_runs.created_at→updated_at).
```

**GitHub tool:** ask "how many PRs did I close in the past week?" — boss should `load_integration(github)` then `github.search_pull_requests({state:"closed", closedWithinDays:7})` and report `totalCount`.

---

## Appendix: how the data was pulled

- **Prod DB:** no public Postgres proxy. `railway ssh -s server`, then run a node script using the in-image `pg` at `/app/node_modules/.pnpm/pg@8.20.0/node_modules/pg` against `process.env.DATABASE_URL` (base64 the script onto the box to avoid quoting issues).
- **Local DB:** `docker exec alfred-postgres-1 psql -U alfred -d alfred` (creds `alfred:alfred`, db `alfred`).
- **Key IDs:** prod user `LNoRaMW6LA0mno2SbJYsl6v6H7XLdqhP`; prod run `run_4n9508ns3vuz` (thread `986275b2-f62b-437b-84f3-d370498cebaa`); local repro run `run_c8h0d8500c36`.
- **Integrations on this account (both prod + local):** `github` (active, scopes `read:user, repo, user:email`, login `99Yash`) and `google` (active). So GitHub *was* connected — the gap was purely missing tools.

### Files touched
- `packages/api/src/modules/agent/executor.ts` (latency)
- `apps/web/src/lib/chat/use-chat-stream.ts` (blank UI)
- `apps/web/src/routes/-chat/tool-call-card.tsx` (cards)
- `packages/contracts/src/tools.ts` (GITHUB_ACTIONS)
- `packages/integrations/src/github/{credentials.ts,pull-requests.ts,index.ts}` (GitHub API)
- `packages/api/src/modules/tools/{github.ts,index.ts}` (tool + registration)
