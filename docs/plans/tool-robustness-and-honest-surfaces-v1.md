# Tool robustness & honest surfaces — build plan (#222, #267, #268, #269)

**Date:** 2026-06-25
**ADRs:** 0070 (poison-resistance + backstop), 0071 (honest surfaces + result-honesty + GitHub redesign), 0072 (error taxonomy), 0073 (sub-agent join — design only), 0074 (general tier — framed), 0075 (artifact epic — framed).
**Grilled:** 2026-06-25 (`/grill-with-docs`). Root causes proven against the dev DB + live Google/GitHub creds, not hypothesized.

## The cluster, in one diagram

```
boss asked "prepare a PDF of my PRs" / "summarise issues 222,267-269"
        │
        ├─ #267  drive.export_file(application/pdf) → 43KB PDF string w/ 129 NUL bytes →
        │        Postgres rejects the persist (22P05/22021) → staging stuck 'pending' →
        │        re-exec fast & clean, re-persist throws again → infinite lease-reclaim loop
        │            ├─ #268  boss (or sub-agent) can't join → polls scratch, apologizes, lies "I'll notify you"
        │            └─ #269  giving-up error mis-classified error_kind='attachment' (no attachment present);
        │                     content=''; message 'failed' while run still 'running'
        │
        └─ #222 + issue-summary give-up  boss can't compute LOC (search has no diff stats) and
                 declines to search issues at all (zero tool calls) — tool surface lies + boss bails
```

Two themes: **platform robustness** (#267/#269 + #268-design) and **boss capability honesty** (#222 + issue give-up). Proof: export replays clean in 1.7s; jsonb insert of the result → `22P05`, text → `22021`; `msg_oo41nkmv4e61` = `failed/attachment/content=''` on a no-attachment turn; run `run_m78xa3ei2w4n` cancelled at `attempt=18` looping `dispatch-tools`; issue-summary run `run_xdwyediskqti` = `attempt=0, 0 tool calls`, reasoning shows it found the workaround then bailed.

## Prior work this builds on (don't re-derive)

- **ADR-0068 / #213 (closed)** — the GitHub query validator (`superRefine` qualifier whitelist `GITHUB_PR_SEARCH_QUALIFIERS` + `@me`→login + structured time windows). ADR-0071 **keeps and extends** it (does not reverse it); it already closed the `merged-by:` confident-zero, so the result-honesty primitive is now defense-in-depth for GitHub and load-bearing only for the general tier.
- **`docs/plans/chat-latency-and-github-tools.md` (2026-06-06)** — made `attempt` monotonic (the reason the backstop keys on consecutive same-step reclaims, never `attempt`); added `github.search_pull_requests`; flagged the sub-agent no-join gap (§A) that ADR-0073 closes.
- **Sub-agent spawn registration** — chat spawn now runs on the fixed `__user-authored-brief__` slug registered at boot (a since-fixed crash from chat-latency §A); ADR-0073's join assumes this working spawn.
- **ADR-0053** (connected catalog, eager declare + preamble summary) — F2 grounding extends it with the connected-account *binding*. **ADR-0034** (`wakeCondition`/HIL parking) — ADR-0073 reuses it. **ADR-0065** (chat-file storage, on Cloudflare R2 since its 2026-06-24 amendment via the `files-sdk`/S3 seam) — ADR-0075 reuses it.
- **Reliability lease cluster #135/#136/#137/#151** — ADR-0070 edits the same lease/executor machinery: **#135** (no alert on terminal job failure) is the sharpest coupling — the backstop *manufactures* terminal failures that, outside chat, die silently until #135's alert path exists; **#137** (no lease tests; "stand up a DB/tx harness") is a **prerequisite** for ADR-0070's backstop tests; **#136** (transient retry) is the **complementary half** of step-retry policy (must coexist with the give-up backstop); **#151** (write idempotency) is eased by terminal-fail. Cross-referenced here, not folded into this batch.

## In this batch (build) vs deferred (design)

| Work | ADR | Status |
|---|---|---|
| Null-byte sanitizer at dispatch boundary | 0070 | **build** |
| Non-progressing-step backstop (3 consecutive same-step reclaims → terminal) | 0070 | **build** |
| Presence gate (load-bearing) + narrow attachment signal (drop the broad substring net) | 0072 | **build** |
| Terminal-aware `finalizeFailedMessage` | 0072 | **build** |
| GitHub `search` extended to issues (keep+extend ADR-0068 validator) | 0071 | **done** (PR honest-surfaces) |
| GitHub `get_pull_request` / `get_issue` (fetch-by-number, LOC) | 0071 | **done** |
| `drive.export_file` honest read-in (text allowlist + teaching redirect) | 0071 | **done** (schema-bound allowlist `DRIVE_TEXT_EXPORT_MIME_TYPES`) |
| Boss rubric (resolve-or-state, attempt-closest) + F2 connected-identity grounding | 0071 | **done** (chat + boss prompt bases; `connected-summary` `— connected as <login>`) |
| Result-honesty primitive (defense-in-depth behind 0068; guards residue + general tier) | 0071 | **done** (`incomplete_results` note + sanitize-and-merge) |
| Sub-agent join (`await_sub_agent` + child-completion signal) | 0073 | **design only** |
| General tier (raw passthrough / Code Mode), BYO-MCP | 0074 | **framed/deferred** |
| Produce-artifact epic (inline sidebar + renderers) | 0075 | **framed/deferred** |

## Phase 1 — Platform poison-resistance (ADR-0070)

> **Mechanism, corrected from dev run `run_m78xa3ei2w4n` (verified 2026-06-25).** The run did real work first — searched PRs **and built a Google Sheet (31 rows)** — then `drive.export_file` was the last tool and the only one stuck (`action_stagings` = `pending`, no `execute_error`). Two facts drive the design:
> - **`attempt=18` is NOT 18 reclaims.** `attempt` is the monotonic per-run counter (executor.ts:307, +1 per step success). 18 ≈ 9 chat-turn + 9 dispatch executions. The step timing shows exactly **one** genuine reclaim (attempt 17→18); the loop was *nascent* (2nd attempt `running` at manual cancel), not 18-deep. The infinite-loop *mechanism* is real, but the prose "threw on every attempt / 18 reclaims" is wrong — fix it in ADR-0070's "Why".
> - **The boundary sanitizer (1.1) fixes #267 at the root; the error-write is a *distinct* poison sink, not "the wedge."** A clean result persists fine → the turn *succeeds* → no throw-chain → no loop. The incident *also* showed a second defect, visible only because 1.1 was absent: the result-write threw, `finalizeFailedMessage` succeeded, then `commitStepFailure` re-threw persisting `agent_runs.error.message = <the poison pg error>` as jsonb → escaped `runOnce` → run stayed `running` → reclaim → re-run poison → repeat. Either fix alone breaks the loop, but they cover different classes: **1.1 = poison arriving as a tool *result* (this incident); 1.3 = poison arriving as a *thrown* error/text string.** Both ship; the failure-recording path is its own sink, a redundant fast-terminal guarantee for #267, not the root.

1. `@alfred/contracts`: `sanitizeToolResult(value) → { value, removed }` — recursive; strip `U+0000` + lone surrogates from strings **and from object keys** (a NUL-byte key poisons the same jsonb write). Unit tests (null-byte, surrogate, nested, **poisoned key**, non-string passthrough).
2. `dispatch/index.ts`: apply in **both** `executeAndCommit` (immediately after `tool.execute` returns — line ~668, so the `execute_result` write at ~694 *and* the returned `toolResult` are both clean) and `executeFastPath` (~713); on `removed > 0` emit a `console.warn` (tool + count) and carry a `sanitized` flag **on the dispatch envelope / tool-call log, not as a property set on the result value** (a bare string/array/primitive result can't hold a flag; assigning to a string throws in strict mode). This also protects the transcript/state sinks (same value flows there).
3. **Sanitize the error-persistence sites too** (the throw-poison-class companion + a redundant fast-terminal guarantee for #267 — promoted from ADR-0070 rejected-alt (c) to a required item). Apply the same strip to every poison-reachable error/text write:
   - `executor.ts` `commitStepFailure` + `markRunFailed`: sanitize the `error.message` string before the `agent_runs.error` / `agent_steps.error` jsonb writes.
   - `chat-turn.ts` `finalizeFailedMessage`: sanitize `content` and the `toolCalls` previews before the `chat_messages` insert.
   - `dispatch/index.ts` the `if (error)` branch (`:673-685`): sanitize the `executeError` jsonb write — the **throw-poison class** (a tool that *throws* a null-byte message), distinct from #267's result-poison and unreachable by the boundary sanitizer; named so the sink enumeration is complete.
   - **Why required, not belt-and-suspenders:** the error-sink strip closes the throw-poison class the boundary sanitizer can't reach, and gives #267 a redundant fast-terminal guarantee — if the boundary were ever bypassed, the poison fails **fast + clean** (`commitStepFailure` succeeds → terminal `failed` in ~2s) instead of looping. That frees the backstop below to guard only the residual "step genuinely can't progress" class (real hangs / event-loop blocks). (#267 itself is already resolved by 1.1 alone — the result persists clean and the turn succeeds.)
4. `agent/executor.ts` `leaseRun` (the residual-class backstop): before re-leasing a stale-`running` row, count contiguous `agent_steps` rows for `(run_id, current_step)` that `leaseRun` marked reclaimed since the last *successful* step — **matched on a structured marker `leaseRun` sets (`error.reason='lease_reclaimed'` or a flag column), NOT `LIKE 'lease reclaimed%'` on the prose message (reworded prose would silently disable the backstop)** — `>= 3` → terminal-fail. The terminal write **must** use the synthetic clean message `"step <id> not progressing: reclaimed N times"` and **must not** echo the original error (else the terminal write re-throws on the same poison and the loop survives the backstop). Tests: trips at 3; one genuine worker death still recovers.
   - **Do not** key on `attempt` (monotonic; see `chat-latency-and-github-tools.md`).
   - **Prerequisite:** the "trips at 3 / survives one reclaim" tests need a DB/tx lease-test harness that doesn't exist yet (**#137**) — stand it up as part of Phase 1. The "since the last *successful* step" anchor must match `commitStepSuccess`'s real terminal-success status string (monotonic `attempt` means a `step_id` recurs across loop iterations; the count resets only on real forward progress).

## Phase 2 — Error taxonomy (ADR-0072) — depends on Phase 1's terminal path

1. **Presence gate (load-bearing), split by recoverability.** Because the whole-thread transcript is replayed each turn, a provider image-reject can be caused by the current turn's image *or* an earlier one. Carry the triggering `userMessageId` on the chat run state; `threadImageAttachments(userId, threadId, userMessageId)` joins `chat_attachments`⋈`chat_messages` for the thread's `ready` images and returns `{ currentTurn, historical }`. `classifyChatFailure(err, { currentTurnHasImage, historicalHasImage })` returns `attachment` when the current turn has an image (UI "Send without it" can drop it), `attachment_history` when only an earlier turn does (retry can't reach it → new chat), else `generic`. The current/historical split matters: a thread-wide flat `attachment` would dead-end the "Send without it" retry (it only drops the current turn's attachments). A failure with no image anywhere → `generic`. **This (with the split) resolves the reported #269 without the dead-end loop.**
2. **Narrow the signal.** Keep only the genuine provider-image-reject signals (`"unable to process input image"`, the `invalid`/`unsupported image` family) and **delete the over-broad `mentionsAttachment` net** (`attachment|file|image|media|mime` + the `could not process` clause) — that net is what mis-bucketed the export failure. Do **not** relocate a throw to hydration: hydration already swallows a bad image to a placeholder and continues; leave it. Add the `attachment_history` kind to `chatErrorKindValues` and a `FAILURE_PRESENTATION` row (copy → start a new chat, `retry:"none"`).
3. `finalizeFailedMessage`: mark the message `failed` only on a terminal fault (not a to-be-reclaimed error), so `chat_messages.status` and `agent_runs.status` agree. Tests: a tool failure with no image → `generic`; a current-turn image-reject → `attachment`; a historical-only image-reject → `attachment_history`; structured signals (429/5xx/turn-cap) unaffected.

## Phase 3 — Honest surfaces (ADR-0071) — ✅ BUILT (branch `feat/honest-surfaces-0071`)

**Status (2026-06-25).** All five build items landed. Notable design realizations: the `author:`-collision lever became `sanitizeGithubSearchQuery` (fold colliding `author:`/`is:`/`state:`/redundant-date qualifiers into structured fields; `githubSearchQueryIssues` now rejects only the residue with no safe auto-fix — invented keys, malformed dates, field contradictions). `search_pull_requests` → `github.search({ type, … })`; integration `searchPullRequests` → `searchGithub` (+`getPullRequest`/`getIssue`). Drive allowlist enforced at the **schema refine** (single source `DRIVE_TEXT_EXPORT_MIME_TYPES`) so a binary `mimeType` returns `invalid_input` with the teaching redirect pre-execute. F2 identity rides the ADR-0053 catalog line (`— connected as 99Yash`), scoped to GitHub. Verified: 13-package typecheck, web-boundaries, 326 api tests (21 github), eval `github-grounding` 5/5 incl. issue-search + LOC no-give-up. **Remaining: live verify** (re-run the PDF/issue-summary/LOC prompts against the dev app) before closing #222/#267/#269.

1. **GitHub search**: generalize `search_pull_requests` → `github.search({ q, type, … })` on `/search/issues`; extend the whitelist (today `GITHUB_PR_SEARCH_QUALIFIERS` in `contracts/src/github-search.ts`) to issue qualifiers and conditionalize the always-appended `is:pr` on `type`; preserve `@me`→login. For the per-turn `author:`-collision retry, prefer **sanitize-and-merge** (strip colliding qualifiers from freeform `q`, fold into the structured fields) over description tweaks — the description is already explicit and the boss still re-trips it (#213's own suggested lever). Result-honesty: 0068's validator already rejects invented qualifier *keys* pre-network, so flag only the residue it can't catch — a valid key with an unsatisfiable value, or `incomplete_results`.
2. **Fetch-by-number**: `github.get_pull_request` / `github.get_issue` (`owner`/`repo`/`number`, `riskTier:'low'`) → `GET /repos/{o}/{r}/{pulls|issues}/{n}`; PR returns `additions`/`deletions`/`changed_files`. Boss fans out over search hits to total LOC (cap + `log()` truncation).
3. **drive.export_file**: bound `mimeType` to a text-export allowlist (single source in `@alfred/contracts`); binary `mimeType` → `invalid_input` with the teaching/redirect message.
4. **Boss rubric** (one structural principle in the prompt base): resolve resolvable params; attempt the closest real tool; if truly unable, state what you can't + what you can; never silently narrow or bail. **A live Sheet/Doc that already answers the ask IS the deliverable — stop there; don't chase a binary export** (in `run_m78xa3ei2w4n` the boss had already built the PR Sheet, then poisoned itself reaching for a redundant PDF). + **F2**: inject connected integration identities (GitHub login/primary repo) into the boss preamble (extends ADR-0053's catalog with the binding).
5. **Maintenance**: curated Zod, drift-guarded by evals — no codegen (DSL layer isn't machine-readable).

## Evals (ADR-0055, evalite)

- `github-grounding.eval.ts` (extend): searches **issues** with a whitelisted/structured query; totals LOC via fan-out. A confident zero on an unrecognized qualifier *key* is already impossible (0068 validator) — the eval guards the residue it can't catch (valid key / bad value, `incomplete_results`) and the structured-vs-freeform split.
- New: a tool result with null bytes is persisted clean (sanitizer); **a step whose result poisons the persist now fails terminally in one attempt (error-write sanitize, Phase 1.3) — NOT via the 3-reclaim backstop**; the backstop trips at 3 only for a step that genuinely never progresses; a no-attachment tool failure classifies `generic` not `attachment`.

## Verify live (localhost:3000 / dev DB / Langfuse)

- Re-run "prepare a PDF of my PRs": `export_file` redirects honestly; no `pending` staging; no reclaim loop; run reaches a terminal state.
- Re-run "summarise issues 222,267-269 on alfred": boss searches issues (no give-up, no asking for the repo) and answers.
- Re-run a LOC question: boss fetches per-PR and totals.
- Confirm no `chat_messages` row is `failed/attachment` without an attachment; message/run statuses agree.

## Issue → close mapping

- **#267** → ADR-0070 (sanitizer + backstop) + ADR-0071 (drive honest read-in). Close on Phase 1 + Phase 3.3 + live verify.
- **#269** → ADR-0072. Close on Phase 2 + live verify.
- **#222** → ADR-0071 (get_pull_request fan-out for LOC; + the silent-narrowing rubric). Close on Phase 3 + live verify.
- **#268** → ADR-0073 (design). Leave open with the ADR linked; #267/#269 fixes make its dead-end visible/non-infinite. Implement in a follow-up PR.

## Deferred (own grills/PRs)

- **#268 join** (ADR-0073) — next, once this batch lands. Its follow-up also owns the two #268 UX findings: the false "I'll notify you" promise (covered by ADR-0073 rubric #5) and the `TOOL_LABELS` card that undersells a delegating, partly-failed turn ("Searched multiple sources and saved notes" + a quiet "Some steps failed") — a sibling honest-surface gap not touched here.
- **General tier / Code Mode / BYO-MCP** (ADR-0074, tracked in **#271**) — needs a sandbox + cross-integration risk grill; Railway + R2 + Vercel-AI-SDK constraints (no CF Workers isolate in hand).
- **Produce-artifact epic** (ADR-0075, tracked in **#272**) — inline sidebar + renderers, borrow from `-dimension-ai-web`.
