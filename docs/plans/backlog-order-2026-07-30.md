# Backlog order, 2026-07-30

> **Status.** Live. This file is the single priority order for the repo as of
> 2026-07-30. It replaces two orders that never met: the tier artifact (rev 26,
> 2026-07-13) and the `arch-20260727` campaign queue. Supersede it with a new
> dated file, do not edit it in place.
>
> **Amended 2026-07-30T08:33Z**, same day, to record what landed and to correct
> two Tier 0 claims that were read off an issue instead of the code. The order
> itself does not change. See "Tier 0 status" and "Prod deploys are blocked".

135 issues were open when this order was written. 26 of them are newer than the
last tier artifact. The campaign holds 26 more items that are not issues at all.

**Six closed the same day** (see "Closed 2026-07-30" at the end), so the live
count is 129.

## Three findings that change the shape, not only the order

### 1. Six epics are fully specified. None is in flight.

| Epic | Slices | Blocked children |
| --- | --- | --- |
| #553 user-authored workflows v1 | 7 (#555 to #561) | **0** |
| #554 composable automation substrate | 6 (#562 to #567) | 4 |
| #422 Context Fabric | 9 (#423 to #431) | 9 |
| #397 chat to memory capture | 4 (#399 to #402) | 4 |
| #236 reply drafting | 7 (#237 to #243) | 6 |
| #218 briefing slices | 5 (#416 to #420) | 5 |

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
test trees into `check-types`) is campaign items 11, 12, 33 and 46.** Item 12
landed and put `web test` into CI. Item 07 added
`apps/web/tsconfig.test.json`. #570 still says "201 test files" and still says
nothing is typechecked. The real count is 225, and `packages/api`, `ai`, `db`,
`integrations` and `contracts` all still declare `"include": ["src"]`.

### 3. About 20 issues are review residue, not work

#145, #162 to #167, #176 to #179, #183 to #185, #204 to #209. Most describe
themselves as low severity and "acceptable at current single-user scale; filed
for awareness". Five carry the `duplicate` label. They inflate the count by 15%
and they hide the real order.

Close them as a batch. **One exception first:** #163 names an unguarded calendar
invite channel, a sibling of #134. Lift that item out before you close #163.

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
5. **#533 add a retention reaper to `events_outbox`.** No delete, reap,
   retention or prune path exists for the highest-volume table in the system.
   This one is a clock that runs in production.

## Tier 0 status, 2026-07-30T08:33Z

**Tier 0 is not done. One of the five is built. Two were already fixed before
this order was written. Two are unstarted.**

`.campaign/backlog-tier0-20260730/state.json` is the machine record. Every line
below was re-checked against `main` at `932dd8e7`.

| Item | Phase | Receipt |
| --- | --- | --- |
| 1 · #453 vault | **landed, not rolled out** | PR #604, merged 08:09Z. `packages/db/src/credential-vault.ts`, `credential-envelope.ts`, `credential-vault-maintenance.ts` and `docs/runbooks/oauth-credential-vault-rollout.md` are on `main`. The PR body says `Refs #453`, not `Closes`, on purpose: the rollout is a maintenance window. See the next section. |
| 2 · #455 better-auth | **built, on a branch** | The catalog floor moves `^1.3.28` -> `^1.6.11`, the lockfile resolves 1.6.25, and `auth()` sets `account.accountLinking.disableImplicitLinking`. 4 tests in `packages/api/test/auth/account-linking.test.ts`. |
| 3 · #457 Gmail webhook | **closed as a duplicate of #291** | PR #320 fixed it on 2026-06-28. `assertGmailPushOidcConfigured` (`gmail-push-config.ts:33`) throws when the audience is unset, and `verifyPubSubOidcForGmailWebhook` (`gmail-webhook.ts:88-93`) calls it before it returns. The skip survives only when `NODE_ENV !== "production"` **and** no push topic is set. |
| 4 · #232 outbound floor | **already enforced. Re-scope the issue.** | The floor is `toolRequiresApproval` (`dispatch/index.ts:933`): `policyMode === "gated" \|\| riskTier === "high"`. A `high` tool gates under `autonomy` too. `gmail.send_draft` is `high` (`tools/gmail.ts:270`), and `registry.ts:372-396` refuses a `fast_path` tool that could ever gate. PR #577 preserved that contract. |
| 5 · #533 outbox reaper | **built, on a branch** | `packages/api/src/events/outbox-reaper.ts` deletes published rows past `OUTBOX_RETENTION_MS` in bounded id pages, hourly, and exempts `published_at IS NULL`. 3 database-backed tests. |

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
  to lift out of #163 before closing it. Re-scope #232 to "outbound *invite*
  floor" and keep it.
- **#134** keeps a separate, smaller residual. The send path gates, so the mail
  cannot leave without approval, but no recipient allow-list exists anywhere in
  `packages/api/src` or `packages/integrations/src`. #134 is about the
  allow-list, not about the gate.

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

Work it in its authored order:

```
#555 -> #556 -> #557 -> #558 -> #559 -> #560 -> #561
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

| Item | Why it survives |
| --- | --- |
| 37, 38 | The replay barrier release does not match the run lifecycle. The 07-28 handoff traced a chain to a bubble that can never complete. |
| 34 | A replayed older `chat.message/started` can blank the live turn. |
| 25 | Union hole in the thread-scoped kind derivation. |
| 44 | `writeFrame` does not send every envelope field the contract declares. |
| 11 | **Closes #570.** Typechecks the test dirs in api, ai, integrations. |
| 46 | `ci.yml` runs api twice, db, ai and web. It does not run integrations. |
| 33 | jsdom in `apps/web`, but only if item 34 needs it. |
| 06 | The briefing gather to compose seam. |
| 30 | The staging-store port insert door. |

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

| Issue | Receipt |
| --- | --- |
| #191 parallel tool dispatch | `chat-turn.ts:677` dispatches the batch concurrently. Gated writes stay serial by design. PR #200. |
| #195 dispatch round-trips | `staging-store.ts:190-207` is one `onConflictDoUpdate` with a no-op set and `xmax = 0`. The `SELECT`-back branch is gone. 3 round-trips to 2. PR #200. |
| #184 diverged workflow helpers | `toolResultMessage` and `dispatchResultToToolOutput` are one copy in `dispatch/result-routing.ts:29,46`. `resolveSdkTools` no longer exists. `runToolRound` serves both workflows. PR #536. |
| #137 "zero runtime tests" | The premise is false. 12 test files: 9 on compaction, 2 on lease, plus `commit-cancel-race.test.ts` on `(runId, stepId, attempt)`. |
| #529 general invocation tier v1 | `request` is registered on 8 integrations plus Railway GraphQL. `assertReadableRequest` at `gate.ts:235`. 11 test files plus `passthrough-honesty.eval.ts`. Flags default off per the PRD's own rollout. |
| #287 show a doc inline | `ExternalFileBody` at `artifact-sidebar.tsx:511` cites #287 by number: trusted-host Drive `/preview` iframe with `allow-downloads`. |

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

| PR | Merged | What it is |
| --- | --- | --- |
| #604 | 08:09:41Z | Tier 0 item 1. Encrypts the OAuth credential vault at rest. Envelope encryption, one KEK that wraps per-secret DEKs, no schema change and no migration. Amends ADR-0038. Deploy failed on the missing KEK. |
| #605 | 08:09:12Z | Not on this order. Collapses 10 `extends ApiError` subclasses into one class behind an `Errors` namespace in `@alfred/contracts`, and adds a `hand-built-api-error` rule to `scripts/consolidation-rules.mjs`. |

`.claude/worktrees/backlog-tier0-20260730-01` still holds the item 1 worktree at
`5e9b2a24`. `git worktree list` reports it as `prunable`, and the branch is
merged. Remove it.
