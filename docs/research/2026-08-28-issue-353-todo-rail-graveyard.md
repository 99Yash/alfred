# Research: #353 Todo rail is a graveyard — why it persists after DB nuke + re-signup

**Date:** 2026-08-28
**Issue:** [#353 Product: todo rail is a graveyard — producer has no user-model (2.4% accept)](https://github.com/99Yash/alfred/issues/353)
**Parent epic:** [#218 evolving user-model spine](https://github.com/99Yash/alfred/issues/218) · Siblings: [#210 triage over-tagging](https://github.com/99Yash/alfred/issues/210), [#351 ClickUp status-change leak](https://github.com/99Yash/alfred/issues/351), [#354 alarm gate](https://github.com/99Yash/alfred/issues/354)
**Method:** primary sources — ADRs, `packages/assistant/src/triage/*` source, handoffs, prod probe scripts. No secondary summaries.

## 1. Summary

#353 reports `142 suggested / 4 done / 18 dismissed` (all-time, `yash.k@oliv.ai`) and `94 suggested, 1 done` in last 14d — **~2.4% accept rate** (`gh issue view 353`). Root cause is not rubric wording but the **producer (rule 16 on flash-lite) has no user-model** and is blind on three axes: **audience/envelope**, **recurrence**, **closure** (`packages/assistant/src/triage/classify.ts:304` rules 16a–16e, `SYSTEM_PROMPT:15`).

Nuking the dev DB and re-signing up **re-enters the cold-start path**: empty `email_triage` priors, empty `entity_profiles` projection, no `observations` history. The classifier then leans on `senderPrior`/`senderKind` hints that are absent, so flash-lite latches onto imperative subjects again. The fix is not a wipe but **shipping the missing deterministic signals + projection activation**.

Current code **already ships most of the deterministic floor** (`packages/assistant/src/triage/floors/sender-kind.ts:12` + `packages/assistant/src/triage/floors/index.ts:58`), yet prod probes (`.handoff/2026-07-07T082543Z.md:15`) show the floor fired **9/676 on work, 35/540 on personal in last 30d** — so headline numbers still move on old rows and the residual leaks (ClickUp tail, SNS alarms) are gated on predicates that were absent until recently.

## 2. Failure taxonomy (from prod rows, issue body)

From `gh issue view 353` Failure taxonomy, corroborated in `.handoff/2026-07-03T105607Z.md:40`:

1. **ClickUp watch-activity → todos (~35, dominant)** — `Review status change on Deal Ownership task`, `Review merged task: Conservice deal views` (`packages/assistant/src/triage/classify.ts:295` rule 12e). Reason: `senderKind` collapsed classes 1 & 2 at once, but `recipientPosition` is NOT discriminative for ClickUp (`clickup:to=88/88` — all `To: yash.k@oliv.ai`).
2. **Internal monitoring alarms → todos (~15)** — `Baserow response time alarm ×9`, `ElastiCache ×5` via `no-reply@sns.amazonaws.com` to `To: engineering@oliv.ai` (broadcast, user not addressed).
3. **Completed-action / closure events → forward todos** — paid receipts, `Review merged task`, `Review status change` — tracked on #258.
4. **Recurrence / dedup blindness** — 9 separate `Baserow response time alarm` todos; `suggestTodo` dedups only on `(provider, kind=thread, id)` (`packages/assistant/src/tasks/suggest.ts:44` `todoSourcesOverlap`), so a new Gmail thread per recurrence mints anew.
5. **Rubric leaks already forbidden** — `Verify GitHub device sign-in` (rule 15/16c), update nudges, persistent `Review…`/`Address…` hedges despite `sanitizeTodoName` (`packages/assistant/src/triage/classify.ts:744`).
6. **Correct todos (~5–10%)** — `Add receipts to 4 Brex expenses`, `Help Sakshi with Conservice issue` — drowned in the above.

## 3. ADR-0066 / ADR-0067 pivot (what the design actually says)

- **ADR-0066** `docs/decisions/ADR-0066-triage-user-model-the-category-becomes.md:3` reverses ADR-0059: **category becomes significance-weighted** (routine/cold/broadcast → `fyi`; `urgent`/`action_needed` reserved for real stake or significant source). ADR-0064's separate attention axis is subsumed. Three new deterministic signals pre-model: **envelope/audience**, **"You" block**, **standing instructions (ADR-0060)**.
- **ADR-0066:15** envelope/audience — `to`/`cc` vs known addresses emits `recipientPosition` + `audienceSize`; category = soft signal, entity projection = HARD gate (distribution alias projected as `group`/`service`, never `person`).
- **ADR-0067** `docs/decisions/ADR-0067-multi-source-user-model-substrate-an-event.md:7` — substrate is built through P1 A–D; **activated projection NOT built** at epic write, but `.handoff/2026-07-03T105607Z.md:18` notes **projection activated on both users on 2026-07-03** (requires `ENTITY_ID_NAMESPACE` on Railway, `packages/assistant/src/knowledge/namespace.ts:1`).
- **Why nuking didn't help:** ADR-0066:21 auto-update loop reads `user_facts.confirmed` via `getUserContext()`; a wiped DB has `entity_nodes`/`entity_profiles`/`observations` empty, so `resolveSenderKind` (`packages/assistant/src/triage/sender-kind.ts:47`) returns `null`, `userModelReader` has nothing, and the "You" block is empty — the classifier is intentionally gated to **never demote on absent data** (`ADR-0066:12` demotion floor, `TRIAGE_SENDER_KIND_CONFIDENCE_THRESHOLD = 0.8`).

## 4. Current code coverage (line-precise)

### 4.1 Sender-kind floor (the #218 spine consumer)

- **Signal:** `packages/assistant/src/triage/sender-kind.ts:47` `resolveSenderKind(userId, senderAddress)` → `userModelReader.getProfileByIdentity({kind:"email", value})` → `senderKindSignalFromProfile` (`sender-kind.ts:62`) gates `kind ∈ {group, service}`, `confidence >= 0.8`, `kind == classification.kind`.
- **Floor:** `packages/assistant/src/triage/floors/sender-kind.ts:73` `applySenderKindDemotionFloor(classification, senderKind, context)` — PURE. Hard veto: ownership `collabActivity` keeps category (`sender-kind.ts:81` `isOwnershipCollabActivity`).
- **Sequence:** `packages/assistant/src/triage/floors/index.ts:99` `FLOOR_SEQUENCE = [override, senderKind, meeting]` — `override` (secret escalation) first, then `senderKind` demotion, then `meeting` gate. Call-site `packages/assistant/src/triage/classify.ts:989` `applyFloors(working, {senderKind, ...})`; `model` tags `+kindfloor` appended.

**Reasons (expanded from 3 → 5 on this branch):**

| Reason | Gate | Prod bucket |
|---|---|---|
| `collab_state_transition` `sender-kind.ts:138` | regex `COLLAB_STATE_TRANSITION_RE` + vetoes `COLLAB_DIRECT_OWNERSHIP_RE`/`COLLAB_INTRINSIC_STAKE_RE` + group/service | ClickUp status changes (now drained to 0, `.handoff/2026-07-07T082543Z.md:28`) |
| `collab_passive_activity` `sender-kind.ts:174` | `isPassiveCollabActivity(collabActivity)` where `collabActivity ∈ {state_change, other_activity, digest}` + `matchesExposedSecret`/`intrinsicStake` vetoes | ClickUp passive tail (requires `collabActivity` field from model) |
| `github_passive_pr_or_ci` `sender-kind.ts:215` | `notifications@github.com` + `PASSIVE_GITHUB_REASON_ALIASES` + PR thread | `author/ci_activity/state_change@noreply.github.com` (39 cc'd GitHub rows, handoff 2026-07-03) |
| `broadcast_auth_signin_confirmation` `sender-kind.ts:233` | `group` + `new sign-in` + `if this was you, no action is needed` | `Sudo email verification code` |
| `monitoring_alarm` `sender-kind.ts:263` | `(sns.amazonaws|pagerduty|...)` or `ALARM:` subject + `matchesExposedSecret` veto + `isBroadcastAudience` | `ALARM: Baserow/ElastiCache` via SNS to `engineering@oliv.ai` |

`sender-kind.ts:119` `senderKindCanDemoteDemand` — `group` always; `service` only on `email:local:service_strong` or `gmail:auto_submitted` (so `support@`/`billing@` still ask for reply).

`sender-kind.ts:126` `senderKindFloorShouldDemoteCategory` — `awaiting_reply` always demoted; `urgent` only on `broadcast_auth_signin_confirmation|monitoring_alarm`; `action_needed` on any non-null reason.

**Audience gate:** `sender-kind.ts:302` `isBroadcastAudience` — parses `To`/`Cc` via `recipientAddresses` (`packages/assistant/src/triage/sender-context.ts`), exact address + plus-tag normalized via `canonicalizeEmailForMatch`; proves user **not** in To/Cc. Missing `accountEmail` or empty recipients = no-op (conservative).

### 4.2 Todo rail suppression (why category ≠ rail)

- `packages/assistant/src/triage/classify.ts:878` `todoSuppressionReason({sender, subject, signalText, collabActivity, category, isColdContact})` returns `alfred_approval | pre_merge_advisory | tracker_owned | cold_sender`. `tracker_owned` (`classify.ts:895`) fires when `collabActivity != null` (any ClickUp/Linear/Jira notification) **or** `TASK_TRACKER_SENDER_RE` matches **and** no `matchesExposedSecret` — even assigned/@-mention items lose the rail todo (rule 16c: tracker already re-notifies; `tracker_owned` keeps `action_needed` category but drops the rail duplicate). This collapses ~35 ClickUp classes at once **on the rail** regardless of floor.
- `packages/assistant/src/triage/classify.ts:733` `sanitizeTodoName` strips `Look into|Investigate|View` hedges; `packages/assistant/src/triage/classify.ts:707` `sanitizeAssist` drops URL/relative-date prose; `packages/assistant/src/tasks/suggest.ts:77` `sanitizeVoice` at `suggestTodo` boundary.
- `packages/assistant/src/tasks/suggest.ts:38` `todoSourcesOverlap` + `RESUGGEST_SUPPRESSION_WINDOW_DAYS = 30` dedups on `(provider, kind, id)` with merge-then-suppress semantics; recurrence blindness remains because a new Gmail thread → new `id`.

### 4.3 Model-judgment nets (cheap-model leaks past rubric)

- `packages/assistant/src/triage/classify.ts:540` `detectConflict` — `under_classification` (security keyword + passive), `over_classification` A (bulk prior ≥80% + `IMPORTANT` false) and B (`#351` service-loop: `service` prior ≥50% `action_needed` across ≥8, re-asks rule 12e). B is the explicit #351 mitigation until sender-prior decay ships.

### 4.4 Model-emitted `collabActivity`

- Schema `packages/assistant/src/triage/classify.ts:120` `collabActivity: assigned_to_user | mentioned_user | comment_to_user | state_change | other_activity | digest | null` (prompt rule 19, `classify.ts:315`). Floor reads it via `context.collabActivity` (`floors/index.ts:108`) to drive `collab_passive_activity` deterministically — generalizes across ClickUp/Linear/Jira without per-vendor regex.

## 5. Residual after shipped slices (measured on live prod)

Via `.handoff/2026-07-07T082543Z.md:20` read-only `psql` on Railway Postgres (post-`d0e44bf4`/`a4a28585`/`298666a4`):

- **Demanding share:** work `yash.k@oliv.ai` 18.6% (126/676, 30d) vs 26% at #210 filing, 23.5% after Tier 0 — awaiting_reply floor moved it but still high. Personal 12.4%.
- **Floor hit rate:** work 9/676, personal 35/540 — barely fires where worst noise is (sender-kind gates pass, reason predicate missing).
- **ClickUp residual 72× `action_needed`** (45d, `notifications@tasks.clickup.com` → service 0.92): state_change = 0 (drained), tail = assignments + @-mentions + comments (`Sanyam: pls merge` = keep; `Akshay: yes good catch` = demote) — un-regexable, needs `collabActivity` field.
- **SNS residual 22× `urgent`** (`no-reply@sns.amazonaws.com` → group 0.99): `ALARM: baserow-response-time/ElastiCache` broadcast `To: engineering@oliv.ai` — user not in To/Cc, so `monitoring_alarm` shape + audience predicate is now **addressable**.

## 6. Fresh-DB / re-signup analysis (why "its still bad" is expected)

| Layer | What wipe does | Why "still bad" |
|---|---|---|
| `email_triage` + priors | Clears `senderPrior` histograms | Cold sender has no bulk/action_needed histogram → `detectConflict` bulk/service nets don't fire; flash-lite latches onto subject imperative |
| `entity_nodes`/`entity_profiles` | Clears activated projection | `resolveSenderKind` returns `null`; `sender-kind` floor never fires (threshold 0.8 requires corpus). Requires replay: `project-user-model-gmail-shadow-committed.ts` + `observations` backfill + `activateProjectionVersion` (ADR-0067 P1–J) — empty after wipe until re-run |
| `observations`/`projection_runs`/`projection_cursors` | Clears source-ranked observations | No audience/role/standing-instruction signals; "You" block (`readTriageUserContext`) still orphaned from first-pass (`classify.ts:444` only has `identity.name/email`) |
| `integration_credentials` + Gmail docs | Re-created on reconnect (Google OAuth), but fresh Gmail ingest starts from now | First mails are cold — the corpus that would teach `engineering@oliv.ai → group 0.99` hasn't been observed yet |
| `todos` | Cleared | Recurrence blindness unchanged — `suggestTodo` dedup is structural only; same alarm tomorrow mints a new `threadId` |
| Onboarding / GitHub App | Patched in `83d2e53d fix(github): reconcile already-installed App after DB wipe` + `41502498 fix(onboarding): per-user gate` | Tile now recovers via App-JWT `GET /app/installations/:id` when callback has `installation_id` but no `code`; honest `GET /credentials` outside `requireOnboarded` (`packages/http/src/connections/google-routes.ts`, `github-routes.ts`). These fix the **blank tile** after wipe, not the triage quality |

**Dev vs prod:** wiping **dev** Postgres doesn't affect `alfred/production` on Railway (`railway status` shows `alfred/production`); prod `yash.k@oliv.ai` rows (142 suggested/4 done) remain. A new **prod** signup creates a new `userId` with the same cold-start physics.

## 7. What is still unbuilt (blocked / deferred)

- **Envelope `recipientPosition` wired into first-pass** — ADR-0066 design exists, but `observations.ts` does not emit `recipientPosition`/`audienceSize`; `classify.ts:444` only renders `From/To/Cc` as prompt text.
- **"You" block / role ownership** — `readTriageUserContext` orphaned (handoff 2026-07-03:24); role-escalation (`who fixes baserow?` IS `action_needed` if user owns baserow) would need projection facts.
- **Standing instructions** (`user_facts key=standing_instruction`, ADR-0060) — Chat-recognized directives → projection; `/settings` queue for `proposed→confirmed`.
- **Recurrence dedup beyond thread id** — needs entity-level dedup key (real-world alarm entity, not Gmail `threadId`) + decay for no-reply-needed senders.
- **Closure blindness** — `Review Anthropic receipt for $1,000.00` (paid receipt) → todo leaks; payment-shape #258.
- **Single committing re-triage backfill** (`scripts/backfills/backfill-triage-committed.ts` / `dry-run-triage-recategorize-committed.ts`) — merged floors only affect new mail; headline demanding share + todo accept are stale until a full re-stamp + prod re-measure.

## 8. Verification gaps

- No `dry-run-triage-recategorize-committed` checksum read across the current branch on prod — so demanding-share movement cannot be attributed.
- `collabActivity` schema landed (`classify.ts:120`) but **floor coverage on the tail** requires eval cases both directions: MUST-demote (`state_change/other_activity/digest` + service/group → `fyi`) and MUST-NOT-demote (19 `assigned_to_user` + `Sanyam: pls merge this` ask; `matchesCollabIntrinsicStake`/`matchesExposedSecret` vetoes).
- `monitoring_alarm` audience gate needs negative case: user directly `To`/`Cc`'d on OWN alarm (on-call) keeps `urgent`/`action_needed`; `plus-addressed` recipient (`u+alerts@`) must count as addressed (`recipientAddresses` already does).

## 9. Recommended next levers (data-backed, one-PR-at-a-time)

1. **Alarm demotion — closes #354, lowest blast-radius.** Deterministic `monitoring_alarm` (already in `sender-kind.ts:263` on this branch: shape `ALARM:`/SNS + `isBroadcastAudience`) + evals both directions. Fixes the 22-row `urgent` trust violation. Deploy → `dry-run` → backfill → re-measure urgent share.
2. **`collabActivity` passive tail — drains the 72-row ClickUp bulk.** Model already prompted to emit it; floor `collab_passive_activity` demotes `state_change/other_activity/digest` to `fyi` (keeping `assigned_to_user/mentioned_user/comment_to_user`) + `tracker_owned` already kills their rail todos. Needs `triage-classify.eval.ts` coverage + read-only recategorize dry-run before commit.
3. **Auth-echo / CI-failure quick wins.** `Sudo email verification code → action_needed` (rule 15) via `broadcast_auth_signin_confirmation` (group); `PR run failed` CI failures → `fyi` via `github_passive_pr_or_ci`.
4. **Re-triage backfill + metrics.** After whichever PR ships: `dry-run-triage-recategorize-committed` review of old→new matrix + false-demotion samples → one `backfill-triage-committed --commit` → re-query `urgent+action_needed share` + `todo done/total agent-suggested`. This is the only way #353 headline numbers move (merged slices are new-mail-only today).
5. **Defer until signals exist:** `recipientPosition` isn't the ClickUp lever (handoff 2026-07-03:31 `clickup:to=88`), wire it for alarms/GitHub cc (≈39 rows). "You"/role block and standing instructions are second-order after the passive tail is drained.

## 10. Sources

- `gh issue view 353/218/351/210` (taxonomies, counts, root-cause statements)
- `docs/decisions/ADR-0066-triage-user-model-the-category-becomes.md:3,13,15,21` and `docs/decisions/ADR-0067-multi-source-user-model-substrate-an-event.md:7`
- `packages/assistant/src/triage/classify.ts:252,295,315,399,540,602,707,733,744,878,989,120` and `packages/assistant/src/triage/floors/sender-kind.ts:12,47,73,81,119,126,138,174,215,233,263,302`
- `packages/assistant/src/triage/floors/index.ts:58,99` · `packages/assistant/src/triage/sender-kind.ts:11` · `packages/assistant/src/triage/sender-context.ts` · `packages/assistant/src/tasks/suggest.ts:38,77`
- `.handoff/2026-07-03T105607Z.md:15,18,24,28,31,40` and `.handoff/2026-07-07T082543Z.md:15,20,28` (prod query recipe: `.lessons/prod-adhoc-query-recipe.md`)

## 11. Minimal fix checklist for a new assignee

- [ ] Confirm projection has replayed for this user (else `resolveSenderKind` is a no-op): `project-user-model-gmail-shadow-committed.ts --dry-run` checksum, then `activateProjectionVersion` if needed
- [ ] Verify `collabActivity` eval and `todoSuppressionReason:tracker_owned` cover the ClickUp tail without burying 19 assignments / `pls merge`
- [ ] Land one PR (alarm OR passive-tail), run `dry-run-triage-recategorize-committed` read-only, review false-demotion samples, then the single committing backfill
- [ ] Re-measure prod: `urgent+action_needed share` and `todos done/total agent-suggested` — these are the acceptance criteria, not code presence

