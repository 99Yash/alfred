# Backlog order, 2026-07-30

> **Status.** Live. This file is the single priority order for the repo as of
> 2026-07-30. It replaces two orders that never met: the tier artifact (rev 26,
> 2026-07-13) and the `arch-20260727` campaign queue. Supersede it with a new
> dated file, do not edit it in place.
>
> **Amended 2026-07-30T08:33Z**, same day, to record what landed and to correct
> two Tier 0 claims that were read off an issue instead of the code. The order
> itself does not change. See "Tier 0 status" and "Prod deploys are blocked".
>
> **Amended 2026-07-31T10:27Z.** Tier 0 is finished and the deploy pipeline is
> open again. Tier 1 started. A second line of work that this order does not
> name now takes most of the merges. The order itself still does not change. See
> "State, 2026-07-31" near the end for everything after 07-30T08:33Z.
>
> **Amended 2026-07-31T14:10Z.** PR #611 completed #555's acceptance coverage,
> #555 is closed, and `main` is green again. The order itself does not change.
>
> **Amended 2026-07-31T14:18Z.** The final Tier 0 reconciliation is complete:
> #232 now owns only the outbound Calendar invite floor, and that finding has
> moved out of #163. #234 now records the same ownership boundary.
>
> **Amended 2026-08-01T02:54Z.** PR #612 merged and closed #556. The next
> authored workflow slice is #557, although #612 already landed part of its
> readiness substrate while closing activation review gaps. The merge left
> `main` red in `api-tests`; see "State, 2026-08-01" at the end.
>
> **Amended 2026-08-01T05:26Z.** PRs #613 and #614 landed the pure #557
> capability resolver and follow-up readiness fixes. PR #615 restored the tool
> schema budget, and merge CI is green. #557 remains open for the recovery
> contract and its remaining acceptance coverage; see the latest state at the
> end.
>
> **Amended 2026-08-01T08:03Z.** PR #617 finished and closed #557. Its merge
> CI is green. The authored workflow queue now moves to #558; see the latest
> state at the end.
>
> **Amended 2026-08-01T10:59Z.** PR #619 finished and closed #558. The
> occurrence and readiness tests are green, but the merged `static` job found
> unupdated server-side `createRun` callers. Restore `main` to green before the
> authored workflow queue moves to #559; see the latest state at the end.
>
> **Amended 2026-08-01T12:36Z.** PR #620 repaired the server-side occurrence
> callers and restored `static`. Its `api-tests` check passed; the post-merge
> run was then superseded by PR #621, whose full successor CI passed. `main` is
> green and the authored workflow queue can move to #559. See the latest state
> at the end.

135 issues were open when this order was written. 26 of them are newer than the
last tier artifact. The campaign holds 26 more items that are not issues at all.

**Six closed the same day** (see "Closed 2026-07-30" at the end), so the live
count is 129. **On 2026-07-31 the count is 124.**

## Three findings that change the shape, not only the order

### 1. Six epics are fully specified. None is in flight.

| Epic                                 | Slices           | Blocked children |
| ------------------------------------ | ---------------- | ---------------- |
| #553 user-authored workflows v1      | 7 (#555 to #561) | **0**            |
| #554 composable automation substrate | 6 (#562 to #567) | 4                |
| #422 Context Fabric                  | 9 (#423 to #431) | 9                |
| #397 chat to memory capture          | 4 (#399 to #402) | 4                |
| #236 reply drafting                  | 7 (#237 to #243) | 6                |
| #218 briefing slices                 | 5 (#416 to #420) | 5                |

Roughly 60 of the 135 open issues are children of these six. The backlog is
rich in design and poor in build. Only #553 has no blocked child, so only #553
can start today.

### 2. The campaign does not touch the backlog

PRs #583 to #601 merged in 3 days. Not one body has a `Closes #N`. Open issues
went 135 to 135.

**The pattern held today.** PR #604 and PR #605 both merged at 08:09Z with no
closing keyword and no `closingIssuesReferences`. The open count is still 129.
#604 is correct to say `Refs #453`, because the rollout is not finished. #605
carries no issue at all.

Worse, the two lists overlap in one place and neither knows it. **#570 (wire the
test trees into** `check-types`**) is campaign items 11, 12, 33 and 46.** Item 12
landed and put `web test` into CI. Item 07 added
`apps/web/tsconfig.test.json`. #570 still says "201 test files" and still says
nothing is typechecked. The real count is 225, and `packages/api`, `ai`, `db`,
`integrations` and `contracts` all still declare `"include": ["src"]`.

> Updated 2026-07-31. PR #606 carries `Closes #455` and `Closes #533`, so the
> "not one body has a closing keyword" claim no longer holds. The #570 count is
> now 236 files. See "State, 2026-07-31".

### 3. About 20 issues are review residue, not work

#145, #162 to #167, #176 to #179, #183 to #185, #204 to #209. Most describe
themselves as low severity and "acceptable at current single-user scale; filed
for awareness". Five carry the `duplicate` label. They inflate the count by 15%
and they hide the real order.

Close them as a batch. **One exception first:** #163 names an unguarded calendar
invite channel, a sibling of #134. Lift that item out before you close #163.

> Done 2026-07-31. The invite item now belongs to #232. #163 contains only its
> two remaining tool-dispatch reliability findings.

## Tier 0. Now. Five items, all verified, all small.

Each claim below was checked against the code today, not read off the issue.

1. **#453 encrypt the OAuth credential vault.** The only 🔴 in the backlog.
   `access_token` and `refresh_token` are plain `text` columns in both
   `packages/db/src/schema/auth.ts:39-40` and
   `packages/db/src/schema/integrations.ts:49-50`. No `createCipheriv`,
   `encryptSecret` or `sealSecret` exists anywhere in `packages/` or `apps/`.
   Every token you hold is plaintext in Postgres. Scope is about one day: wrap
   three persistence modules with a single KEK.
2. **#455 bump better-auth.** The lockfile resolves `better-auth@1.6.9`. The
   CVE fix is 1.6.11. The catalog range `^1.3.28` already permits it, so this is
   a lockfile bump plus the account-link config.
3. **#457 make the Gmail webhook fail closed.** One guard. It currently skips
   OIDC verification when `GOOGLE_PUBSUB_AUDIENCE` is unset.
4. **#232 give outbound sends a gated floor**, and #134 falls out of it. No
   `alwaysGated`, `GATED_FLOOR`, `mustBeGated` or `forceGated` symbol exists in
   `packages/api/src` or `packages/contracts/src`. A send-capable tool can be
   set to `autonomy` and then execute with no human gate. Fix the floor, not the
   instance.
5. **#533 add a retention reaper to** `events_outbox`**.** No delete, reap,
   retention or prune path exists for the highest-volume table in the system.
   This one is a clock that runs in production.

## Tier 0 status, 2026-07-30T08:33Z

**Tier 0 is not done. One of the five is built. Two were already fixed before
this order was written. Two are unstarted.**

> Superseded on 2026-07-31. All five are now resolved. This table stays as the
> 07-30 record. Read "State, 2026-07-31" for the current phase of each item.

`.campaign/backlog-tier0-20260730/state.json` is the machine record. Every line
below was re-checked against `main` at `932dd8e7`.

| Item                    | Phase                                     | Receipt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · #453 vault          | **landed, not rolled out**                | PR #604, merged 08:09Z. `packages/db/src/credential-vault.ts`, `credential-envelope.ts`, `credential-vault-maintenance.ts` and `docs/runbooks/oauth-credential-vault-rollout.md` are on `main`. The PR body says `Refs #453`, not `Closes`, on purpose: the rollout is a maintenance window. See the next section.                                                                                                                                                                                                                                                                                                                                 |
| 2 · #455 better-auth    | **built, on a branch**                    | The catalog floor moves `^1.3.28` -> `^1.6.11` and the lockfile resolves 1.6.25. The floor **is** the fix: 1.6.11 added the missing local-`emailVerified` check and defaults `requireLocalEmailVerified` to true. 3 tests in `packages/api/test/auth/account-linking.test.ts` — two pin the version from opposite ends (lockfile, catalog range), one asserts the default is never set to `false`. `disableImplicitLinking` was tried and dropped: with Google as the only sign-in path it can never fire, and it would refuse a later magic-link-first user's Google link with no in-app escape. See ADR-0009's 2026-07-30 correction.            |
| 3 · #457 Gmail webhook  | **closed as a duplicate of #291**         | PR #320 fixed it on 2026-06-28. `assertGmailPushOidcConfigured` (`gmail-push-config.ts:33`) throws when the audience is unset, and `verifyPubSubOidcForGmailWebhook` (`gmail-webhook.ts:88-93`) calls it before it returns. The skip survives only when `NODE_ENV !== "production"` **and** no push topic is set.                                                                                                                                                                                                                                                                                                                                  |
| 4 · #232 outbound floor | **already enforced. Re-scope the issue.** | The floor is `toolRequiresApproval` (`dispatch/index.ts:933`): `policyMode === "gated" \|\| riskTier === "high"`. A `high` tool gates under `autonomy` too. `gmail.send_draft` is `high` (`tools/gmail.ts:270`), and `registry.ts:372-396` refuses a `fast_path` tool that could ever gate. PR #577 preserved that contract.                                                                                                                                                                                                                                                                                                                       |
| 5 · #533 outbox reaper  | **built, on a branch**                    | `packages/api/src/events/outbox-reaper.ts` deletes published rows past `OUTBOX_RETENTION_MS` in bounded id pages, hourly, and exempts `published_at IS NULL`. 8 database-backed tests, plus 7 for the shared `PeriodicTask` lifecycle it now runs on. A structural review caught two real defects in the first cut: the `DELETE` used `id IN (subquery)`, which Postgres plans as a sequential scan of the whole table (91ms / 12,540 buffers at 800k rows, 20 times an hour) — now `id = any(array(...))`, an index scan at 2.5ms; and the pass never checked its stop flag between batches, so the documented shutdown protection did not exist. |

Items 3 and 4 are the two the order got wrong. The order claimed each was checked
against the code; both were read off the issue. The lesson is narrow and it costs
nothing to state: a missing symbol name is not a missing guard. `GATED_FLOOR` does
not exist because the floor is spelled `riskTier === "high"`.

**What is left of items 3 and 4 after the correction:**

- Close **#457** as a duplicate of **#291**.
- **#232** shrinks to one real hole. `calendar.create_event` is
  `riskTier: "medium"` (`tools/calendar.ts:284`), so under an `autonomy` policy
  it creates an event and mails every invitee with no human gate. That is the
  unguarded invite channel **#163** names, and it is the item the order told you
  to lift out of #163 before closing it. Re-scope #232 to "outbound _invite_
  floor" and keep it.
- **#134** keeps a separate, smaller residual. The send path gates, so the mail
  cannot leave without approval, but no recipient allow-list exists anywhere in
  `packages/api/src` or `packages/integrations/src`. #134 is about the
  allow-list, not about the gate.

> Completed 2026-07-31. #232 is now the input-dependent invite floor:
> `calendar.create_event` with attendees must resolve to `high`; an event with
> no attendees keeps its current tier. #163 no longer owns this finding.

So the live Tier 0 queue is one item: **finish the #453 rollout.** #455 and #533
are built on `fix/tier0-better-auth-outbox-retention`.

### One thing #533 uncovered, and did not fix

#533 asked for retention measured in "hours, not days". Hours is not safe here.
`apps/web/src/lib/events/replay-anchor.ts` persists the replay cursor in
`localStorage` with **no expiry**, and `replay-state.ts` documents a known state
in which a barrier can never be cleared, so `since` freezes. A client can
therefore present a cursor that is arbitrarily old.

When a cursor points below the retained window, `getEventsSince` returns the
surviving rows and the client silently receives nothing for the gap. It cannot
tell "no events happened" from "your history was reaped". The reaper ships with
7-day retention so no plausible cursor lands in that hole, but the detection is
still missing. It is the same defect class as **#532** (the `MAX(id)` watermark
drops gap frames), so it belongs in the one later slice this order already
prescribes for #192, #532 and #533 together — not in the reaper.

## Prod deploys are blocked

> **Fixed 2026-07-31T05:25Z. This section is history.** The KEK is set, the boot
> gate passes, and production deploys again. See "State, 2026-07-31".

`OAUTH_CREDENTIAL_KEK` is **required** by `serverEnv()`
(`packages/env/src/server.ts:97`, no default and no `.optional()`). It is **not
set** on the Railway `server` service. So:

- Deployment `655ec5ea` (08:09:43Z, the #604 merge) is **FAILED**. Its log ends
  with `Error: Missing or invalid environment variables: OAUTH_CREDENTIAL_KEK`.
- Production still serves `3d3e2fc5`, the #605 merge 30 seconds earlier, which
  deployed clean. The running process is healthy, so nothing looks wrong from
  outside.
- **Every future deploy fails the same way until the KEK is set**, whatever it
  contains. This is not only a #453 problem. The next unrelated fix cannot ship.

The boot gate is deliberate: `assertPersistedCredentialsSealed`
(`credential-vault-maintenance.ts:179`) refuses to serve a table with a plaintext
row rather than degrade quietly. So the key alone is not enough. Run the whole
window in `docs/runbooks/oauth-credential-vault-rollout.md`: generate the key,
set it, back up, stop the writers, run `pnpm db:encrypt-credentials`, verify
zero plaintext, restart.

Do this before any other Tier 0 item. It is the only thing in the backlog that
holds the deploy pipeline shut.

## Tier 1. The one big bet: #553 workflows v1.

> **Started 2026-07-31.** PR #610 landed the substrate and PR #611 completed the
> acceptance coverage. #555 is closed. See "State, 2026-07-31".

Work it in its authored order:

```
#555 (complete) -> #556 -> #557 -> #558 -> #559 -> #560 -> #561
```

Why this epic and not the other five:

- It is the oldest unbuilt promise in the repo (ADR-0017 and ADR-0025).
- It is the only epic with zero blocked children.
- It turns "say it in chat" into durable automation, which is the product claim.
- **#554 builds on it, so #553 first is a sequence, not a preference.** #562's
  own body says the subscription, receipt and cursor primitives are "the same
  ones #560 builds for Gmail; adopt them unchanged".

Freeze the other five epics while this runs. Do not start #554, #422, #397,
#236 or the #218 briefing slices. Their specs keep their value on disk.

## Tier 2. The daily product failures. Run beside Tier 1.

These four are what you feel every morning. They are cheap and they are not
epics.

- **#210** triage over-tags attention. Significance is absolute and it gates
  todos, not categories.
- **#353** the todo rail is a graveyard at 2.4% accept, plus **#354**, its
  internal-alarm instance.
- **#573** distill the triage `SYSTEM_PROMPT`. It grew 60% in three weeks to
  about 11k tokens. The eval gate already exists to hold it.
- **#478** size effort per turn. Auto/Sonnet at fixed `effort: "medium"`
  over-thinks trivial artifact edits, which is where the money goes.

## Tier 3. Finish the campaign, but only the strong half.

26 items remain. 16 are the weakest tier the review assigns, and 18 of the 26
sit in one subsystem: the web event and chat-stream client. That is a fifth
round on one file family.

**Land these 10. They have real chains or they close an issue:**

| Item   | Why it survives                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 37, 38 | The replay barrier release does not match the run lifecycle. The 07-28 handoff traced a chain to a bubble that can never complete. |
| 34     | A replayed older `chat.message/started` can blank the live turn.                                                                   |
| 25     | Union hole in the thread-scoped kind derivation.                                                                                   |
| 44     | `writeFrame` does not send every envelope field the contract declares.                                                             |
| 11     | **Closes #570.** Typechecks the test dirs in api, ai, integrations.                                                                |
| 46     | `ci.yml` runs api twice, db, ai and web. It does not run integrations.                                                             |
| 33     | jsdom in `apps/web`, but only if item 34 needs it.                                                                                 |
| 06     | The briefing gather to compose seam.                                                                                               |
| 30     | The staging-store port insert door.                                                                                                |

**Drop the other 16.** They are items 13, 14, 20, 24, 26, 27, 28, 29, 35, 36,
41, 42, 43, 45, 47, 48. Mark them `skipped` in `state.json`. File an issue only
for one with a chain you can name.

## Tier 4. Close or merge.

The ~20 residue issues in finding 3. Also fold these three, which are one
system and are filed as three:

- **#192** ephemeral chat deltas route through the durable Postgres outbox, so
  the hot path pays a DB write per token.
- **#532** outbox replay drops gap frames below the `MAX(id)` watermark.
- **#533** no retention. This one is Tier 0. The other two belong in one later
  slice with it.

## What this order deliberately does not do

- It does not start a second epic. Six specified epics with none in flight is
  the failure this order exists to correct.
- It does not finish the campaign. The campaign earned 17 landed items. The
  remaining "worth exploring" tier costs more in review rounds than the defects
  cost in production.
- It does not re-tier the residue. Residue gets closed, not ranked.

## Closed 2026-07-30

Each of these had merged work and an open ticket. Every claim was checked against
`main`, not read off a PR title.

| Issue                           | Receipt                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #191 parallel tool dispatch     | `chat-turn.ts:677` dispatches the batch concurrently. Gated writes stay serial by design. PR #200.                                                                                                       |
| #195 dispatch round-trips       | `staging-store.ts:190-207` is one `onConflictDoUpdate` with a no-op set and `xmax = 0`. The `SELECT`-back branch is gone. 3 round-trips to 2. PR #200.                                                   |
| #184 diverged workflow helpers  | `toolResultMessage` and `dispatchResultToToolOutput` are one copy in `dispatch/result-routing.ts:29,46`. `resolveSdkTools` no longer exists. `runToolRound` serves both workflows. PR #536.              |
| #137 "zero runtime tests"       | The premise is false. 12 test files: 9 on compaction, 2 on lease, plus `commit-cancel-race.test.ts` on `(runId, stepId, attempt)`.                                                                       |
| #529 general invocation tier v1 | `request` is registered on 8 integrations plus Railway GraphQL. `assertReadableRequest` at `gate.ts:235`. 11 test files plus `passthrough-honesty.eval.ts`. Flags default off per the PRD's own rollout. |
| #287 show a doc inline          | `ExternalFileBody` at `artifact-sidebar.tsx:511` cites #287 by number: trusted-host Drive `/preview` iframe with `allow-downloads`.                                                                      |

### Four that look done and are not

Do not close these. The work near them landed, so they read as stale.

- **#580 sender-kind floor.** Still real. `isBroadcastAuthSignInConfirmation`
  (`triage/floors/sender-kind.ts:234`) runs no `matchesExposedSecret` check.
  Only `collab_passive_activity` carries the veto (`:178`). PR #579 was a
  different item.
- **#570 test trees.** Half done. `apps/web/tsconfig.test.json` exists and CI
  runs `web test`, but api, ai, db, integrations and contracts all still declare
  `"include": ["src"]`. The count is 225 files, not 201. Campaign item 11 closes
  the rest.
- **#159 SSE errors.** The recovery half is done: the browser reconnects and the
  `?since` replay anchor restores state. `onError` reaches every subscriber
  (`lib/events/stream.ts:45,72`), but no component renders it. The scope shrinks
  to "render it".
- **#532 replay gap frames.** Still real. The watermark is still a snapshot of
  `MAX(id)` (`api/src/modules/events/index.ts:20,91-93`).

Never close an epic on a child's PR. #435, #397, #272, #271 and #218 all had
merged work referencing them and all keep open children. #354 is held on purpose
for the #218 gate.

## Campaign state reconciled today

Item 40 read `review` while PR #601 was merged as `ed321dfb`. Set to `landed`.
Worktree `.claude/worktrees/arch-20260727-40` was `prunable` and is removed. A
backup of the previous state is at `/tmp/state.json.bak`.

## Merged after this order was written

| PR   | Merged    | What it is                                                                                                                                                                                                                                          |
| ---- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #604 | 08:09:41Z | Tier 0 item 1. Encrypts the OAuth credential vault at rest. Envelope encryption, one KEK that wraps per-secret DEKs, no schema change and no migration. Amends ADR-0038. Deploy failed on the missing KEK. **Deployed clean on 2026-07-31T05:25Z.** |
| #605 | 08:09:12Z | Not on this order. Collapses 10 `extends ApiError` subclasses into one class behind an `Errors` namespace in `@alfred/contracts`, and adds a `hand-built-api-error` rule to `scripts/consolidation-rules.mjs`.                                      |

PRs #606 to #610 merged after that. They are in "State, 2026-07-31" below.

`.claude/worktrees/backlog-tier0-20260730-01` still holds the item 1 worktree at
`5e9b2a24`. `git worktree list` reports it as `prunable`, and the branch is
merged. Remove it. **Done: the worktree is gone.**

---

# State, 2026-07-31T10:27Z

Five PRs merged after the 07-30T08:33Z amendment: **#606, #607, #608, #609 and
#610**. Every claim below was checked against `main` at `945937bb`, or against
GitHub and Railway, not read off a PR title.

The order does not change. Three things about the _state_ do.

## 1. Tier 0 reconciliation is finished

The original five-item reconciliation is complete. The broad #232 claim was
already fixed in code; #232 remains open only for the narrower Calendar invite
hole that the reconciliation isolated.

| Item                    | Phase                                                | Receipt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · #453 vault          | **rolled out. #453 closed 05:26:58Z.**               | `OAUTH_CREDENTIAL_KEK` is set on the Railway `server` service and in `apps/server/.env`. Deployment `a7957d0e` is SUCCESS on `70ba61e9`, `api.alfred.beauty` answers 200, and the boot gate passed. The conversion pass was a **no-op**: `account` and `integration_credentials` both held 0 rows, and `db:encrypt-credentials:check` reported 0 plaintext and 0 unopenable before the deploy. So the runbook ran, but no ciphertext exists yet. The first Google sign-in writes the first sealed row, and that write is the real test of the vault. |
| 2 · #455 better-auth    | **merged. #455 closed 2026-07-30T10:01Z.**           | PR #606. Live in production from `a7957d0e`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3 · #457 Gmail webhook  | **closed 2026-07-30T08:37Z** as a duplicate of #291. | No code change. The 07-30 correction was right.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4 · #232 outbound floor | **re-scoped 2026-07-31; invite floor remains open.** | #232 now covers only `calendar.create_event` with non-empty `attendees`: resolve it as `high`, then let the existing floor require approval under `autonomy`. Events without attendees keep the current policy behavior. The Calendar item is no longer in #163, and #134 stays separate for Gmail allow-list and draft-first work.                                                                                                                                                                                                                  |
| 5 · #533 outbox reaper  | **merged. #533 closed 2026-07-30T10:01Z.**           | PR #606. `a7957d0e` logs `[outbox-reaper] started`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

PR #606 is also the **first PR of the campaign era to carry a closing keyword**.
It closed two issues at once. Finding 2 of this order said no body had one. That
is no longer true, and #602 (`Closes #551`) preceded it on 07-29. The habit is
recoverable.

The retained-window detection gap that #533 uncovered is unchanged. It still
belongs in the one later slice with #192 and #532.

## 2. Tier 1 started, and #555 is complete

PR #610 merged at 08:52Z. It is the substrate and the service:

- `workflow_revisions`, `workflows.current_revision_id` /
  `published_revision_id` / `blocked`, and `agent_runs.workflow_revision_id`,
  in additive migration `0090_nappy_owl.sql`.
- `packages/api/src/modules/workflows/revisions.ts` — create-draft, revise,
  validate, activate, status and blocker writers.
- `workflowUpdate` no longer writes `workflows`. It routes through the service.
- A committed backfill that mints revision 1 for existing user-authored rows.
- `toolNameSchema` moves to `@alfred/contracts`; both former copies re-export it.

The PR body says `Refs #555` on purpose, because the four acceptance cases were
probed against a real database but not committed as tests. The follow-up commit
`be0e7aac` then committed `packages/api/test/workflows/revisions.test.ts` (the
suite now lives at `packages/http/test/workflows/revisions.test.ts`) with
**two** of the four:

- covered: the active-edit / published-pin case, and the typed `row_version`
  conflict.
- still missing at merge: pause / blocker independence, and canonical
  `content_hash` behavior across processes.

PR #611 merged the remaining acceptance coverage in commit `4ef7866d`:

- pausing preserves `blocked`, and clearing the blocker preserves the user's
  `paused` status;
- two separate Node processes hash the same definition identically despite
  different object-key and set ordering.

All five checks on #611 passed, including `api-tests`. **#555 closed at
10:41Z.** The next workflow slice is #556.

The remaining six slices keep their authored order:
`#556 -> #557 -> #558 -> #559 -> #560 -> #561`.

The worktree `.claude/worktrees/workflow-revisions-555` still exists at
`be0e7aac`. The branch is merged into `main` and the lock names pid 67061, which
is gone. Remove the worktree and the lock.

## 3. `main` is green again, but nothing stops a red merge

`ci.yml` failed on the `#610` merge commit `945937bb`. One test fails:

```
not ok 1 - active edits stay visible as drafts while new runs pin the published revision
  test/workflows/revisions.test.ts
  error: 'No system tools are registered for the kernel surface'
  systemToolKernel (src/modules/agent/tool-surface.ts:33:11)
  Object.initialState (src/modules/agent/workflows/user-authored-brief.ts:623:24)
  createRun (src/modules/agent/service.ts:150:33)
```

This was a **harness defect, not a revision defect.** The test calls `createRun`,
which builds the user-authored brief's initial state, which asks for the system
tool kernel. Nothing registered the kernel surface in that test process. The
same case passed on the branch, where the file ran under a different entry set.
Commit `fb1b058d` registered the built-in tool surface in the test. CI passed on
that commit at 10:36Z, and passed again on PR #611's merge commit `24a27b3f`.
`main` is green.

It matters because of what landed 2.5 hours earlier. **PR #608 removed the**
`required` **job**, and `main` has no branch protection:

```
gh api repos/99Yash/alfred/branches/main/protection
→ 404 Branch not protected
```

That trade was deliberate and it is the repo owner's call. State the consequence
plainly: `main` had **no** gate on 07-31, a red PR merged into it the same day,
and it stayed red until `fb1b058d`. The 27-of-40 red history that #608 set out to
fix came from exactly this mechanism. #608 fixed the three _causes_ it found. It
did not remove the _path_.

Two of #608's other effects are worth recording against the campaign:

- `api-unit-tests` and `api-db-tests` are now one `api-tests` job. All 201 files
  no longer run twice per CI, so a timing-sensitive test gets one chance to
  flake, not two. A glob split was rejected on purpose.
- The `hedge budget` flake is fixed by counting concurrent hedges rather than
  cumulative ones.

**The immediate red is fixed.** The missing required aggregate gate is not.

## 4. A second line of work now takes most of the merges

Three of the last four PRs are MCP: **#607**, **#609**, and #608 partly, because
two of its three red causes were MCP tests. Both #607 and #609 say `Refs #547`.

This order named #553 as the one big bet and froze the other five epics. **#547
is not one of those five.** It is the MCP connection-and-OAuth slice, the
follow-up to the closed #540, and this order never ranked it. So it is not a
violation of the freeze. It is a gap in the order: the order describes one live
line and the repo runs two.

What the two PRs actually did:

| PR   | Merged | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #607 | 05:20Z | Migrates the production adapter from `@modelcontextprotocol/sdk@1.29.0` to `@modelcontextprotocol/client@2.0.0`. Negotiates the modern `2026-07-28` protocol era with a `2025-11-25` fallback behind an explicit allowlist. Keeps Alfred's immutable catalog as the authority: no SDK list cache is promoted, MRTR fulfillment is off, and `tools/call` is never auto-replayed. This is **not** on #547's deferred list. It is a new item the SDK release forced. |
| #609 | 08:05Z | OAuth discovery, credential handling, insufficient-scope recovery and durable connection routes, plus the GitHub MCP status / reconnect / consent UI, plus trace context through connect, catalog and invoke. Migration `0089_true_dust.sql`.                                                                                                                                                                                                                     |

Two facts about #609 to carry forward:

- The MCP credential store **uses the vault**: `mcp/oauth.ts:2` imports
  `credentialVault` from `@alfred/db/credential-vault`. So #453's KEK covers the
  Alfred-to-MCP-server bearer too, and #547's own "plaintext-token concerns
  apply here" note is satisfied by construction rather than by a second design.
- Its body says **"Testing: Not run (not requested)"**. The 26 files include
  `test/mcp/oauth.test.ts` (+193) and `test/mcp/manager-lifecycle.test.ts`
  (+62), so tests were _written_. They were not _run_ before merge, into a
  branch with no gate, on the same day the gate was removed.

**#547 is not close to done.** The production endpoint authorizer is still the
placeholder: `manager.ts:96` still reads "Placeholder endpoint authorization for
the default factory. Enforces https and…". SSRF hardening, the connection-trust
nonce, and the reviewed-downgrade write path are all still open, and so is the
ADR that amends ADR-0018.

**The call this order will not make for you:** either rank #547 beside #553 and
say so, or stop merging it. Two unranked live lines is how six specified epics
came to sit with none in flight.

## 5. What did not move

- **Tier 2 is untouched.** #210, #353, #354, #573 and #478 are all open, and no
  PR since 07-30 references any of them. These are still the four you feel every
  morning.
- **Tier 3 is untouched.** Every one of the 10 items to land is still `design`
  in `.campaign/arch-20260727/state.json`: 37, 38, 34, 25, 44, 11, 46, 33, 06,
  1. The 16 to drop are still `design` too, not `skipped`. Nobody marked them.
- **Item 46 survives #608.** `ci.yml` now runs `static`, `api-tests`,
  `ai-unit-tests` and `web-unit-tests`. It still does **not** run
  `@alfred/integrations`.
- **#570 drifted further.** `packages/api`, `ai`, `db`, `integrations`,
  `contracts` and `sync` all still declare `"include": ["src"]`.
  `apps/web/tsconfig.test.json` is still the only test tsconfig. The test file
  count is now **236**, not the 225 this order corrected it to, and not the 201
  the issue claims. Campaign item 11 still closes it.
- **The ~20 residue issues are all still open.** Tier 4 did not run. The one
  extraction is complete: #232 now owns the Calendar invite floor, and #163
  contains only its two remaining tool-dispatch reliability findings.
- **#580, #159 and #532** are still real, exactly as the "Four that look done"
  section says.

## The live queue, 2026-07-31

Tier 0 has no remaining reconciliation work. #232 stays open as a precisely
scoped outbound-safety implementation issue.

1. **Decide about #547** before its next PR. Rank it or pause it.
2. Then **#556**, and the rest of #553 in order.
3. Remove the `workflow-revisions-555` worktree.

---

# State, 2026-08-01T02:54Z

PR **#612** merged at 02:51:52Z as `71d50384` and closed **#556** one second
later. The open issue count is now **123**. The authored workflow epic #553
remains open.

## 1. #556 is complete

The merge contains the chat authoring and exact activation path:

- `system.author_workflow` saves an inactive immutable draft and returns the
  server-canonical activation proposal.
- `system.activate_workflow` is `riskTier: "high"`, so ADR-0069 forces the
  existing approval gate even under autonomy.
- The activation input carries the workflow and base-revision identity, full
  definition, schedule preview, resolved capability display, assumptions and
  external-effect categories. It is not an opaque-id approval.
- Approval-card edits append a new immutable revision and publish that exact
  definition. Stale revision, content-hash, approval-input and row-version
  checks fail closed.
- Authoring is limited to an interactive boss caller. The v1 trigger surface is
  concrete cron plus IANA timezone, manual, and Gmail `message_received`.
- Runtime dispatch rejects a tool outside the revision's exact `allowed_tools`
  envelope instead of widening an unattended workflow.

Four review-fix commits followed the original implementation before merge:
`d2ceac98`, `509917be`, `2e52305f` and `a25970c1`. They added more than #556's
initial two-tool surface: activation-time capability and Gmail-event readiness,
account binding, exact approval persistence/resume, event account isolation,
and the supporting readiness tests. This is real substrate for **#557**, but
#557 is still open. Do not close it from #612: its full acceptance still owns
the pure resolver contract, every named recovery state, reconnect-to-the-same-
draft behavior, and the complete blocked-draft matrix.

## 2. `main` is red after the merge

The merge checks report `static`, `ai-unit-tests`, `web-unit-tests` and both
React Doctor checks green. `api-tests` failed: **2,173 passed and 8 failed**.
The failures are:

- the full tool schema is 80,029 bytes, 29 bytes above its 80,000-byte budget;
- two #556 authoring/activation acceptance cases;
- three event-dispatch duplicate/account-isolation cases;
- two #555 revision-invariant cases.

This is not a pre-merge failure: the job was still pending when #612 merged.
The branch still has no required aggregate gate, so the same path recorded in
the 2026-07-31 state section remains open.

## The live queue, 2026-08-01

1. Restore `main` to green after #612.
2. Reconcile #612's readiness work against **#557**, then finish and close the
   remaining #557 acceptance contract.
3. Continue the authored order: `#558 -> #559 -> #560 -> #561`.
4. Decide whether **#547** is ranked beside #553 or paused before another MCP
   PR merges.
5. Remove the still-locked `workflow-revisions-555` worktree.

---

# State, 2026-08-01T05:26Z

PR **#615** merged at 05:22:08Z as `379212a3`. Its `main` push CI completed at
05:26:20Z with `static`, `api-tests`, `ai-unit-tests`, `web-unit-tests` and
React Doctor green. The first item in the 02:54Z live queue is complete:
`main` is green again.

The last failure was the full tool-schema budget. A follow-up edit had restored
a longer `system.author_workflow` description, leaving the full surface at
80,029 bytes against the unchanged 80,000-byte ceiling. #615 removed 33 bytes
without changing the tool contract. The full surface is now 79,996 bytes.

## 1. #557 has real substrate, but is not complete

PR **#613** merged at 04:44:34Z as `547598e0`; PR **#614** merged at 05:07:17Z
as `7a41741c`. Together they landed:

- a pure `resolveWorkflowCapabilities` over caller-supplied availability and
  tool-catalog state;
- deterministic exact tool and integration envelopes, including the event
  trigger source;
- account canonicalization, account/resource blockers, Gmail trigger health,
  and `no_tool_surface` for unsupported tools;
- the existing runtime `capability_mismatch` enforcement with no silent
  widening; and
- database-backed fixture repairs for the immutable-revision rules from #612.

This does **not** close #557. The remaining contract is concrete:

- `WorkflowReadinessProblem` still carries only `code`, `message` and `field`;
  it does not return the issue's typed, truthful recovery action;
- no connect or reauthorize return boundary reruns readiness for the original
  immutable draft and presents its activation proposal;
- resource access is still fail-closed as unverifiable instead of being
  resolved from supplied resource facts; and
- the resolver acceptance matrix still needs direct cases for `needs_reauth`,
  `missing_scope`, `feature_disabled`, and Gmail write on a read-only account.

## The live queue, 2026-08-01T05:26Z

1. Finish and close **#557**: typed recovery actions, same-draft recovery,
   resource facts, and the remaining resolver acceptance matrix.
2. Continue the authored order: `#558 -> #559 -> #560 -> #561`.
3. Decide whether **#547** is ranked beside #553 or paused before another MCP
   PR merges.
4. Remove the still-locked `workflow-revisions-555` worktree.

---

# State, 2026-08-01T08:03Z

PR **#617** merged at 07:58:31Z as `88e14465` and closed **#557** one second
later. The merge-commit `ci` and React Doctor runs completed green at 08:02Z.

## 1. #557 is complete

The merge finishes the capability and blocked-draft recovery contract that the
05:26Z state section left open:

- `WorkflowReadinessProblem` now carries typed recovery actions for connect,
  reauthorize, account choice, resource grant, feature enablement and retry.
  `no_tool_surface` deliberately carries no action, so an unsupported Slack
  request cannot masquerade as a fixable OAuth problem.
- The resolver accepts caller-supplied facts for one exact tool, account and
  resource boundary. A missing or denied fact stays fail-closed, while an exact
  grant satisfies readiness. Connection recovery takes precedence over a
  resource action when both are missing.
- The direct resolver matrix now covers `needs_reauth`, `missing_scope`,
  `feature_disabled`, Gmail write on a read-only account, and resource access.
- Google connect / reauthorize can carry the workflow and immutable revision
  identity in signed, single-use OAuth state. The callback revalidates that
  exact draft, refuses a revision that changed while OAuth was open, and returns
  to the workflow instead of losing the user's authored intent.
- Recovery canonicalizes newly available account facts into the activation
  proposal without mutating the base revision. Approval remains the only path
  that can append and publish the canonical definition.
- `POST /api/workflows/:id/recovery` returns the fresh blocked state or the
  server-owned activation proposal. The workflow page validates that proposal
  at the browser boundary and presents its schedule, account-bound capabilities
  and external effects.
- Repeating the same blocked recheck is idempotent, so the OAuth callback and
  page handoff do not increment `row_version` twice for one unchanged blocker.

PR CI passed `static`, `api-tests`, `ai-unit-tests`, `web-unit-tests` and React
Doctor before merge. The merge commit passed the same `ci` and React Doctor
workflows after merge.

## The live queue, 2026-08-01T08:03Z

1. Start **#558**: durable occurrence identity and the async
   `check-readiness` first step.
2. Continue the authored order: `#559 -> #560 -> #561`.
3. Decide whether **#547** is ranked beside #553 or paused before another MCP
   PR merges.
4. Remove the still-locked `workflow-revisions-555` worktree.

---

## State, 2026-08-01T10:59Z

## 1. #558 is complete

PR #619 merged at 10:57Z and closed #558. It adds database-unique occurrence
keys for cron, provider-event and manual runs. Cron run creation and cursor
advance now commit in one transaction, while the queue is delivery only. A
pending claim survives an enqueue failure for the recovery sweep to find.

User-authored workflows now start with an asynchronous `check-readiness` step.
Transient provider-health failures defer with a bounded retry schedule, while
credential loss and other terminal readiness failures block the run before its
first model turn. The run lifecycle, worker recovery and event contracts now
carry the new `deferred` and `blocked` states.

The merged PR passed `api-tests`, `ai-unit-tests`, `web-unit-tests` and React
Doctor. The `static` job failed in `server#check-types`: server built-ins,
backfills, QA and smoke scripts still call `createRun` without the new manual or
event occurrence identity. This is a merge regression and must be fixed before
starting the next workflow slice.

## The live queue, 2026-08-01T10:59Z

1. Restore `main` to green by updating every remaining server-side `createRun`
   caller to provide durable occurrence identity.
2. Start **#559**: logical effect identity, unknown write outcomes and
   cancellation fencing.
3. Continue the authored order: `#560 -> #561`.
4. Decide whether **#547** is ranked beside #553 or paused before another MCP
   PR merges.
5. Remove the still-locked `workflow-revisions-555` worktree.

---

## State, 2026-08-01T12:36Z

## 1. The #558 `static` regression is repaired

PR #620 merged at 12:24:56Z as `62211993`. It updates every remaining
server-side `createRun` caller for the occurrence contract that #619 made
required:

- backfill, operations, QA and smoke callers now mint a durable manual request
  identity for each invocation; and
- the learn-skill documentation handoff uses a stable event occurrence derived
  from the parent run.

The merge commit passed `static`, `ai-unit-tests`, `web-unit-tests` and React
Doctor. The exact `server#check-types` failure recorded at 10:59Z is gone.

## 2. Full merge CI is green

PR #620's pull-request `api-tests` check completed successfully at 12:27:32Z.
PR #621 merged one second earlier, and its new `main` push superseded #620's
still-running post-merge workflow through `cancel-in-progress: true`. GitHub
therefore cancelled the older run after its last printed test; that was not a
failed assertion.

PR #621's successor `main` workflow completed at 12:32:02Z with `static`,
`api-tests`, `ai-unit-tests` and `web-unit-tests` green. React Doctor is green
too. Because #621 descends from #620, the successor run covers the occurrence
repair plus the later editor-configuration commit. `main` is green.

## 3. Why `main` keeps going red

The repeated red merges are not one flaky test. `main` has no branch protection
and no required status checks. PRs #610, #612, #613 and #614 all merged while a
later-failing check was still running. PR #619 merged after `static` had already
failed. CI is finding real integration defects, but only after the commits are
on `main`, so each defect becomes a separate repair PR.

The cancellation setting adds noise during rapid merges, but it is not the
cause of the real failures: a newer `main` run tests a descendant commit and
supersedes the older run by design. The prevention is to require the full PR CI
set before merge, not to keep repairing `main` after each result arrives.

## The live queue, 2026-08-01T12:36Z

1. Start **#559**: logical effect identity, unknown write outcomes and
   cancellation fencing.
2. Continue the authored order: `#560 -> #561`.
3. Decide whether **#547** is ranked beside #553 or paused before another MCP
   PR merges.
4. Remove the still-locked `workflow-revisions-555` worktree.
