# Demo-Readiness & User-Model — Session Handoff (2026-06-21)

> **Purpose.** A self-contained handoff so a fresh context window can continue without re-deriving
> anything. It captures the chronological progression of the 2026-06-21 session, the **verified**
> (code- and prod-grounded) state of the world, the two close-outs shipped, and the recommended next
> track. Trust this doc's "verified" claims over the older plan docs — several were stale.
>
> **How to use it.** Read §1 (TL;DR) → §3 (verified state) → §6 (next track). §7 has reproducible
> recipes (prod DB, prod Langfuse, the backfill, the Anthropic key test). §8 is the reference index.
>
> **Companion docs:** [`june-demo-triage.md`](./june-demo-triage.md) (the demo backlog — now partly
> stale, see §3.1), [`integration-object-state-v1.md`](./integration-object-state-v1.md) (the #212
> build plan), [`long-term-memory-v1.md`](./long-term-memory-v1.md), [`meeting-prep-v1.md`](./meeting-prep-v1.md),
> and the prior [`triage-relevance-handoff-2026-06-11.md`](./triage-relevance-handoff-2026-06-11.md).

---

## 1. TL;DR — where things stand (2026-06-21)

1. **The demo spine is in better shape than the plan doc says.** 4 of 7 `june-demo-triage.md` "Now"
   items are actually **DONE** — including both "demo-killers" (date/timezone grounding + connected
   summary, and the tool-selection recovery envelope). Still open: **MEET-001** (meeting prep, not
   started), **CAL-002** (structured attendees), **BRIEF-001** (calendar-anchored briefings). See §3.1.
2. **#211 (self-ingestion loop) is fully closed on prod.** Filter was already deployed; this session
   ran the backfill `--commit`. **40 docs + 39 triage rows deleted, 0 residual.** §4.1.
3. **#224 (Deep tier silently runs Gemini) is root-caused and fixed** in **PR #227**. It was *not*
   "Opus unavailable" — it's a deprecated thinking API that Opus 4.8 rejects with a 400, which
   `withFallback` silently swaps to Gemini. §4.2.
4. **#210 (triage over-tagging) is still live**: urgent+action_needed = **23.5%** of the inbox (was
   26.3% before the #211 backfill). **0 user overrides** exist in prod — the correction signal the
   "destination" fix would learn from has no data yet. §3.3.
5. **The big remaining product work = the user-model epic #218** (#210 + #212). #212 (object-state
   memory, ADR-0062) is **designed but unbuilt**; that's the recommended next track. §6.
6. **A week-long observability dig (the "can of worms")** produced the self-hosted Langfuse stack +
   I/O capture (PR #225) and surfaced the real bugs (#222/#223/#224). Context in §5.

---

## 2. Session chronology (what happened in this chat)

This session was an orientation → audit → close-out, in this order:

1. **Read the week's context** — journals (`~/journal/2026-06-20*` and `2026-06-21*`), the merged-PR
   list (#126–#225), the open-issue tracker (40+ issues), and `docs/plans/june-demo-triage.md`.
2. **Verified the demo spine and epic against code** (two `Explore` agents) rather than trusting the
   plan's checkboxes — found the plan lags the build (§3.1, §3.2).
3. **Queried prod directly** (the user invited it): the prod Postgres (`railway ssh` + `pg`, §7.1) for
   the #210 distribution and #211 residue, and prod **Langfuse Cloud** REST API (§7.2).
4. **Closed #211 on prod**: dry-run → user approval → `--commit` → verification (§4.1).
5. **Diagnosed and fixed #224**: live Anthropic API tests (§7.4) proved it's the thinking-API 400, not
   a bad key; fixed via adaptive thinking; opened **PR #227** (§4.2).
6. **Recorded everything**: journals `2026-06-21T07:32:11Z` + `T07:48:46Z`, four memory files (§8.5),
   and this handoff.

Decisions the user made this session: (a) run the #211 backfill (dry-run first); (b) next substantial
track = the user-model work (#210 + #212); (c) open the #224 PR now; (d) write this handoff.

---

## 3. Verified state of the world

### 3.1 Demo spine — `june-demo-triage.md` "Now" list (verified against code)

| ID | Plan said | **Verified reality** | Evidence |
|---|---|---|---|
| **CAL-001** wire `calendar.list_events` | "still a stub" | ✅ **DONE** — executes, picks Google credential, scope-gated, returns sorted non-cancelled events | `packages/api/src/modules/tools/calendar.ts:164,232-254`; registered in `tools/index.ts:40` |
| **CAL-002** normalize event read model | ready | ◐ **PARTIAL** — briefing attendees flattened to `"Name <email>"` strings, not structured `{email,displayName,…}`; chat rail/meeting-prep not unified | `packages/contracts/src/briefing.ts:121-143` (CalendarContribution) |
| **MEET-001** meeting-prep gatherer | "highest value" | ✗ **NOT STARTED** — no `packages/api/src/modules/meeting-prep/`; only `ADR-0054` + `docs/plans/meeting-prep-v1.md` | — |
| **BRIEF-001** calendar-anchored briefings | ready | ◐ **PARTIAL** — calendar gathered but email categories are still the primary spine; not anchored on meetings | `briefing/gather.ts:258-316`, `compose.ts:116-150` |
| **GROUND-001** date + connected summary | ready | ✅ **DONE** — date+IANA tz and connected summary injected into **both** boss & chat prompts, run-snapshotted (ADR-0053) | `agent/grounding.ts:25-35`, `agent/connected-summary.ts:146-180`, `chat-turn.ts:350-357`, `user-authored-brief.ts:144-147` |
| **GROUND-002** wire `system.read_user_context` | ready | ✅ **DONE** — registered, `system`/`no_risk`, in both prompts | `tools/system.ts:76-89`; `memory/user-context` |
| **GROUND-003** tool-selection recovery | ready | ✅ **DONE** — unknown action enumerates the integration's real action list; handles qualified `int.action` names | `dispatch/index.ts:511-538,540-594` |

**Net:** the grounding track (the demo-killers) is shipped. The remaining demo value is **MEET-001**
(depends on **CAL-002** for structured attendee matching) and **BRIEF-001**.

### 3.2 User-model epic #218 — tier build state

| Tier / item | State | Evidence |
|---|---|---|
| **#211 self-ingestion (Tier 0)** | ✅ **DONE + deployed + backfilled** (this session) | filter `integrations/src/google/ingestor.ts:225-240`, `parseEmailAddress` in `contracts/src/guards.ts:84-88`; backfill `apps/server/src/scripts/backfill-retire-self-mail-committed.ts` (tsdown entry `apps/server/tsdown.config.ts:16`) |
| **#212 object-state memory (Tier 1, ADR-0062)** | ✗ **NOT STARTED** — design only | `docs/plans/integration-object-state-v1.md` + ADR-0062 in `decisions.md`; **no** schema tables, registry, reducer, or `gather.ts` reconciliation. `github-webhook.ts:36-90` is a pure event log. Migration head = `0042`. |
| **#210 presentation-layer demotion** | ◐ **PARTIAL** — significance feeds the *classifier*, not the *presentation* | `triage/sender-relationship.ts:27-35` (`bucketSignificance`), used in `email-triage.ts:652-680`, read by `classify.ts:213` (rubric 16b gates the **todo**, not the category). **No** briefing-lane/rail ranking or recurrence decay yet. |

### 3.3 Prod data snapshot (2026-06-21, queried directly)

**Postgres** (`alfred/production`, 2 users: `yashgouravkar@gmail.com`, `yash.k@oliv.ai`):

- `email_triage`: **966 rows** after the #211 backfill (was 1005), span 2026-05-20 → 2026-06-21.
- **Attention share (#210)**: urgent+action_needed = **23.5%** post-backfill (was **26.3%**; urgent
  fell 9.4%→7.2%). Full distribution post-backfill: fyi 34.0%, action_needed 16.3%, marketing 14.2%,
  done 13.8%, newsletter 8.4%, urgent 7.2%, meeting 3.1%, payment 1.7%, awaiting_reply 1.2%, follow_up 0.2%.
- **0 user overrides**: all triage rows are `source=auto`. No `source=user` rows → **no correction
  signal** for ADR-0055 Loop-2 / the "destination" fix. The bridge (computed significance + standing +
  recurrence) must carry #210 on its own for now.
- `documents`: 1384 total; self-mail docs now **0** (was 40).

**Langfuse** — prod is on **Cloud** (`cloud.langfuse.com`), keys rotated this week onto Railway
(`pk-lf-0a1de65f…`); the fresh `alfred-prod` project had only **8 traces** (the old ~8.5k-generation
project is abandoned). Traces group correctly (`run:…` parents). I/O capture **off** in prod by design
(`LANGFUSE_CAPTURE_IO` unset → `input:null`). Local/dev = **self-hosted** at `:3100` with capture **on**.

---

## 4. Work completed this session

### 4.1 #211 — self-ingestion loop, closed on prod

- **State going in:** filter merged (PR #220) and **already deployed** (Railway SUCCESS deploy
  07:13 UTC, after #220 merged) → new self-mail is dropped at ingestion. Only the historical backfill
  remained.
- **Ran** (see §7.3 for the exact recipe) the committed backfill, targeting **both** prod users (the
  script defaults to only `yashgouravkar@gmail.com`):
  - `yashgouravkar@gmail.com`: 24 docs / 23 pure threads (e.g. "Alfred build still failing" ×4, "Ben
    Book reply is overdue" ×8).
  - `yash.k@oliv.ai`: 16 docs / 16 pure threads (e.g. "Baserow response time alarm" ×9 by day,
    "Production server is still down").
  - **0 mixed threads** for either user → no risk of dangling `email_triage.document_id` (the P2 the
    script guards against; see `.lessons/gather-triage-documentid-innerjoin.md`).
- **Result:** deleted **40 documents + 39 triage rows**; verified `self_docs_remaining = 0`. Bonus:
  #210 attention share **26.3% → 23.5%**. The loop is now dead in both directions.

### 4.2 #224 — Deep/Opus tier silently served Gemini (FIXED → PR #227)

- **The issue's assumption was wrong.** Live Anthropic API calls with the active key returned **200
  for both Opus and Sonnet** — the key is valid and Opus is reachable.
- **Real root cause:** `getChatProviderOptions()` sent the **legacy** extended-thinking API
  `anthropic: { thinking: { type: "enabled", budgetTokens: 2_048 } }`. **`claude-opus-4-8` rejects it
  with HTTP 400** — *"thinking.type.enabled is not supported for this model. Use thinking.type.adaptive
  and output_config.effort."* A 400 is non-retryable, so `withFallback`'s `error(() => true).switch`
  rule **immediately fell to `gemini-2.5-pro`** — chronic and silent on every Deep turn.
- **Asymmetry (verified):** **Sonnet 4.6 still accepts** `thinking.type.enabled` (200); only **Opus 4.8
  rejects it**. So only the Deep tier broke; standard chat (Sonnet) stayed on Anthropic; the boss
  (`getBossModel`, no `thinking`) is **unaffected**. **Do not conflate with #223** (boss prompt-cache).
  - The one true overlap: when a Deep turn fell to Gemini, the Anthropic-only `cacheControl` was
    ignored → that explains the "0% cache / ~11s-per-step" seen on that specific Deep run.
- **Fix (PR #227):** `getChatProviderOptions(tier)` → `thinking: { type: "adaptive", display:
  "summarized" }` + `effort: tier === "deep" ? "high" : "low"`. Adaptive works on both models (Opus +
  adaptive + effort verified 200, returns a thinking block); `display:"summarized"` keeps the
  "Thinking…" accordion fed; effort makes "Deep" actually escalate. `@ai-sdk/anthropic@3.0.71` supports
  it. `chat-turn.ts` passes `state.tier`.
- **Verified:** `check-types` (@alfred/ai + @alfred/api) + `oxlint` clean.
- **Acceptance (post-deploy):** a Deep turn → `api_call_log` served model = `claude-opus-4-8`, not gemini.
- **Deferred (out of scope):** the *defensive* half of #224 — surface served-model/fallback in the chat
  UI so a real Anthropic outage downgrade isn't silent (pairs with **#216** trace-label fix).

---

## 5. The observability "can of worms" (week-of narrative)

The week's drag was an observability dig that started from "the Langfuse dashboard is empty" and kept
unspooling — but it's what made the real bugs visible:

1. **0 traces** despite thousands of observations → fix: `client.trace()` upsert was missing (orphaned
   observations). Now traces group. (journal 2026-06-20T14:48)
2. Then: tool calls uninstrumented, generations stored **no I/O text**, model labels wrong.
3. → **Self-hosted the whole Langfuse v3 stack locally** (`docker/langfuse/docker-compose.yml`, web on
   `:3100`, bound to `127.0.0.1`), off Cloud's free tier. (journal T06:16; memory
   `project_langfuse_self_host`)
4. → **Opt-in I/O capture** behind `LANGFUSE_CAPTURE_IO` (off in prod, on locally) — **PR #225**
   (closes #215). Security fix in review: bound web+minio to localhost.
5. The payoff — using the now-readable traces to debug real chats surfaced: **#222** (GitHub PR
   LOC/diff tool gap), **#213** (free-formed PR-search query → nondeterministic counts), **#223** (0%
   boss prompt-cache, ~11s/step, ~23s TTFB), **#224** (this session's fix), **#216** (served-model
   mislabel), **#226** (trace-envelope gaps: env tag, sessionId, role on non-chat pipelines).

Alongside this ran a large tech-debt/perf/SSOT sweep (PRs #168–#217: parallel tool dispatch #200,
same-run idempotency #202, shared types #217, model-id SSOT #190, etc.) — solid hygiene, but **none
touched the product gaps** (#210/#211/#212). That's the gap this and the next session close.

---

## 6. Recommended next track — the user-model epic (#210 + #212)

The user chose this as the substantial next track. Recommended order:

**A. Build #212 object-state memory v1 (ADR-0062) — the loop-closure mechanism.**
Plan already written: [`docs/plans/integration-object-state-v1.md`](./integration-object-state-v1.md).
The v1 slice (per the plan + memory `project_212_loop_reconciliation_design`):
1. **Schema** — object-state projection tables (work-object lifecycle) + an **object↔entity edge table**
   *distinct from* `entity_relations` (entity↔entity); objects must NOT become entities. New migration
   (head is currently `0042`). Substrate = ADR-0058 Postgres.
2. **Registry** — registry-driven `IntegrationObjectDef` with an `extractKeys` slot (v1 = a
   deterministic regex key-extractor, e.g. GitHub CI `head_sha`).
3. **GitHub reducer** — real-time webhook reducer over `github-webhook.ts`'s event log applying
   `applyEvent` → state; **propose/dispose invariant** (the LLM/boss may *propose* candidate keys, never
   *assert* state — keeps ADR-0048 determinism intact).
4. **Reconciliation** — wire `extractKeys → resolveByKey → getState` into `briefing/gather.ts` so a
   merge/fixed-build that happened days ago (outside the 24h/cap-25 gather window) closes the loop and
   stops resurfacing. Add a contract test.
   - Why forced (not gold-plating): the gather window literally cannot see old closures → a materialized
     projection is required. (journal 2026-06-21T04:47)

**B. #210 presentation-layer demotion — layer on once loops close.**
- Demote at the **presentation layer** (briefing lane order + rail badge ranking by
  significance/recurrence), **never** re-stamp the immutable category (ADR-0048/0059/0060). Only explicit
  user authority (`force_category`) re-stamps.
- Significance is already computed and fed to the classifier (`sender-relationship.ts`); the missing
  piece is consuming it for **ranking/demotion** in `gather.ts`/rail, plus recurrence decay.
- **Caveat from prod:** 0 user overrides exist → the "learn from dismiss/archive" destination (Path C /
  ADR-0055 Loop-2) has no training data yet; the computed-significance bridge (Path B) must carry it.

**ADR-0063 (extraction front-door — how/when to extract from emails)** is explicitly deferred to its own
grill; #212 does **not** block on it (the deterministic regex extractor fills `extractKeys` in v1).

**Other candidate work (not this track):** MEET-001 meeting prep (highest *demo* value, needs CAL-002
first); the defensive half of #224 + #216; #223 boss prompt-cache; the o11y envelope #226.

---

## 7. Reproducible recipes (for the next session)

### 7.1 Ad-hoc prod Postgres read
`railway` is linked to `alfred/production`. There is **no** public Postgres proxy — run on the server.
Full recipe: `.lessons/prod-adhoc-query-recipe.md`. Short form:
```bash
# write a script.cjs that does:  const pg = require("/app/node_modules/.pnpm/pg@8.20.0/node_modules/pg");
#                                 new pg.Client({ connectionString: process.env.DATABASE_URL }) ... read-only
B64=$(base64 < script.cjs)
railway ssh -s server "echo $B64 | base64 -d > /tmp/q.cjs && node /tmp/q.cjs; rm -f /tmp/q.cjs"
```
Gotcha: `railway` link is **per-directory** — run from the repo root (a `cd` into scratchpad loses it).
pg version was `pg@8.20.0`.

### 7.2 Prod Langfuse (Cloud) read
Keys are on Railway (`railway variables --service server` → `LANGFUSE_PUBLIC_KEY/SECRET_KEY/HOST`). Cloud
is reachable from the laptop; query with HTTP Basic auth `pk:sk`:
```js
const auth = "Basic " + Buffer.from(`${PK}:${SK}`).toString("base64");
await fetch("https://cloud.langfuse.com/api/public/traces?limit=5", { headers: { Authorization: auth } });
// also: /api/public/observations?type=GENERATION  ·  /api/public/metrics/daily
```
Local self-hosted is the same API at `http://localhost:3100` (seeded throwaway keys; capture is ON).

### 7.3 The #211 backfill (already run; here for reference / re-verify)
```bash
# path is apps/server/dist/, NOT dist/ ; default target is only yashgouravkar@gmail.com (prod has 2 users)
railway ssh -s server "node apps/server/dist/scripts/backfill-retire-self-mail-committed.js \
  --emails=yashgouravkar@gmail.com,yash.k@oliv.ai"            # dry-run (no --commit)
# append --commit to delete. Re-verify: self_docs_remaining should be 0.
```

### 7.4 Live Anthropic model/feature test (how #224 was proven)
```bash
KEY=$(grep -E "^ANTHROPIC_API_KEY=" apps/server/.env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d ' \r')
curl -s https://api.anthropic.com/v1/messages -H "x-api-key: $KEY" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-8","max_tokens":4096,"thinking":{"type":"adaptive"},"output_config":{"effort":"high"},"messages":[{"role":"user","content":"hi"}]}'
# opus + thinking.type.enabled → 400 (the bug); opus + adaptive+effort → 200 (the fix); sonnet accepts both.
```

---

## 8. Reference index

### 8.1 GitHub issues
- **Epic:** #218 (the evolving user-model — spine behind #210/#211/#212 + tagging + standing-instructions + cold-start).
- **Product:** #210 (over-tagging, live), #211 (self-ingestion — **done/closeable**), #212 (loops never close — next build).
- **Observability/perf (from the dig):** #213 (PR-count nondeterminism), #214 (tool spans), #216 (served-model label), #219 (domain decision trace + drift metrics), #222 (GitHub PR LOC/diff tool), #223 (boss 0% prompt-cache, ~11s TTFB), #224 (**fixed → PR #227**), #226 (trace-envelope gaps).
- **Tech-debt/dedup:** #204–#209; hardening bundles #134–#167; perf #191–#195; durability #192/#193.

### 8.2 Pull requests
- **#227** — this session's #224 fix (open).
- **#225** — Langfuse I/O capture + self-hosted stack (#215, merged).
- **#220** — #211 self-ingestion filter + backfill (merged, deployed).
- Recent context: #217, #203, #202, #201, #200, #199, #190, #172, #131, #128.

### 8.3 ADRs (`decisions.md`)
0048 (briefing determinism + immutable labels), 0051 (triage v3 / sender priors), 0053 (run grounding +
connected summary), 0056 (memory governance), 0057 (capture + significance + chat→memory), 0058
(Postgres substrate), 0059/0060 (model never bends category), **0062 (integration object-state memory)**,
0063 (extraction front-door — stub, deferred).

### 8.4 Plans (`docs/plans/`)
`june-demo-triage.md` (demo backlog; partly stale — see §3.1), **`integration-object-state-v1.md`** (#212),
`long-term-memory-v1.md`, `meeting-prep-v1.md` (MEET-001 / ADR-0054), `triage-relevance-handoff-2026-06-11.md`,
`chat-latency-and-github-tools.md`.

### 8.5 Journals (`~/journal/`, this session)
`2026-06-21T07:32:11Z` (orientation + state audit), `2026-06-21T07:48:46Z` (#211 close-out + #224 fix).
Week context: the `2026-06-20*` and earlier `2026-06-21*` entries (Langfuse dig, #211 build, ADR-0062 grill).

### 8.6 Auto-memory (`~/.claude/projects/-Users-yash-Developer-self-alfred/memory/`)
Created/updated this session: `project_deep_tier_opus_thinking_fix` (new — #224), `project_self_ingestion_tier0`
(now DONE), `reference_langfuse_access` (prod/local split + capture flag), `project_triage_attention_overtag_audit`
(fresh prod numbers + 0-overrides). Also relevant: `project_user_model_spine`, `project_user_model_epic_build_order`,
`project_212_loop_reconciliation_design`, `project_langfuse_self_host`.

### 8.7 Repo lessons (`.lessons/`)
`prod-adhoc-query-recipe.md`, `gather-triage-documentid-innerjoin.md` (the #211 mixed-thread P2),
`run-committed-script-dev-dry.md`.
