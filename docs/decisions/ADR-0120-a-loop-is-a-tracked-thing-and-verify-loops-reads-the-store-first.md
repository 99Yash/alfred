# ADR-0120 — A loop is a tracked thing, and `verifyLoops` reads the store first

**Status.** Proposed. Slices 1 and 2 are built: the `gmail/email_interpretation` link at triage with its backfill, and `verifyLoops` with the `list_loops` composer tool. Slices 3 to 7 are not built. Amended 2026-11-07 after the review of PR #1690: decisions 1, 4, 5, 6, 7, and 8 each have a dated amendment. Defines the `verifyLoops` seam of ADR-0118 decision 9. Amends ADR-0092 (a thing that only mail tracks can have a state, and the `about` observation is the input of `verifyLoops`), ADR-0062 (a mail from the service itself is a provider fact), and ADR-0048 (the store holds the state of a loop, not the briefing). The design comes from a grilling session with the owner on 2026-11-04.

**Decision.** A loop is not a new record. A loop is a **thing**, an `integration_objects` row, in the state `active` or `failed`, that touches the user. Each integration activity can open a loop, and the closure of a loop is the change of state of its thing. The link from a mail to its thing is the ADR-0092 `about` observation, which triage writes one time. `verifyLoops` selects the things in a bounded set, uses the stored state as the verdict, and runs a live read only when the stored state is ambiguous. It folds each fact through `applyEvent` in one transaction. The briefing reads one list with three verdicts: `open`, `closed`, and `unverified`.

## Why

These facts are from the code on 2026-11-04 (issue #1684, and a map of the gather):

- **No record holds a loop or its closure.** Each gather matches each mail to an object again (`proposeReconcileCandidates`, `reconcileEvidence`). It then decides closure again (`dropClosedLoops`) and relevance again (`assessLoopRelevance`). The result is only a snapshot in `briefings.closed_loops` (`packages/db/src/schema/briefings.ts:52`).
- **Four steps decide part of the state of a loop.** These are the Vercel and Railway verified pulls, the GitHub merged read, the approved MCP health reads, and the closure and relevance passes. Each has its own cap of 5.
- **The same thing is read two times.** In one gather, the verified pull and the relevance pass each open a Railway session for the same `deployment_target`. The GitHub merged read and the relevance pass each read the state of the same pull request.
- **Old rows are read on each run (#1683).** The Vercel pull reads every `failed` row, also a row from 2025-04-08, because nothing limits the set. Only an `absent` read demotes a row, so these rows never leave the rotation.
- **A Vercel verdict never reaches its mail.** Vercel has a pull, but no relevance reader and no closing kind.
- **The glossary already says where a thing lives.** A thing with a lifecycle is its `integration_objects` row, only a provider fact sets its state, and the work of the user is a todo ([context-graph glossary](../theory/context-graph.md)). An "ask" row with a state from inference would copy the thing and break that rule.

## Decisions

### 1. A loop is a thing in an open state

A loop is an `integration_objects` row whose `state_category` is `active` or `failed`, and that a priority mail or an open todo points to (decision 4). There is no `loops` table and no "ask" kind. Each integration activity that sets a thing to `active` or `failed` can open a loop: a webhook, a poll, a verified pull, or a mail from the service itself (decision 2). The loop closes when its thing becomes `resolved` or `abandoned`. The store already holds that change, with its time and its version.

**Amended 2026-11-07.** Only a kind with a non-empty `closesAskOn` is a loop kind. The slice 2 build added this rule in a build note, and this amendment records it as a change. Why: `closesOpenAsk` gives the only `closed` verdict. Thus a thing of a kind with no closing state would stay `open` on each run. An attempt never resolves, so it is never a loop. `vercel.deployment_target` declares an empty `closesAskOn` (#1357), so a Vercel thing is not a loop. It stays a non-loop until a later decision (owner decision, 2026-11-07).

### 2. A mail from the service itself is a provider fact (amends ADR-0062 and ADR-0092)

Some things have a lifecycle, but no connected provider tracks them. Examples are a failed payment at Voyage AI, and an SNS alarm that sends an ALARM mail and later an OK mail. Each such thing is an `integration_objects` row. The mail of the service itself is the provider fact that sets its state: "payment failed" sets `failed`, and a later receipt sets `resolved`. The row is keyed by the domain of the sender and the identity of the referent. A mail from a person, or from a relay that quotes the service, is not a provider fact, so it cannot set a state.

A referent (`entity_nodes`, ADR-0092) stays only for a thing with no lifecycle, for example a newsletter issue. A referent never copies an `integration_objects` row.

### 3. The link from a mail to a thing is stored one time (amends ADR-0092)

Triage writes the ADR-0092 `about` observation for each mail: the `documentId`, the triage category of the message, the keys that the mail names, and the provider links of the sender's own service. One mail can be about more than one thing. `verifyLoops` reads these rows through `observations_document_idx`. It does not read the mail text again. It resolves the stored keys and links against `integration_objects` when it reads, because a resolution from the time of triage goes stale. Thus it also finds a thing whose row did not exist at triage (case 3 of decision 5). The first slice builds only the object half of the `about` observation. The referent half and the significance half of ADR-0092 come later.

### 4. The verify set is bounded

`verifyLoops` reads each thing in `active` or `failed` that one of these points to:

- an `about` observation from a mail in a priority category (`urgent`, `action_needed`, or `follow_up`) inside the window, or
- an open todo, with no time limit. "Remind me in a week" is a todo with a `due_date`. It needs no new state.

The `category` field of each `about` observation holds the triage verdict of its message. The priority filter reads that field, not the triage row of the thread.

The window is 30 days on the first run. Each later run starts at the last successful run, with a minimum of 3 days. Thus a gap in the briefings, for example a holiday or a broken credential, does not lose a loop. A thing outside the set keeps its state. It is not read and not shown. Expiry never sets `abandoned`, because only a provider fact sets a state. A new priority mail about the thing puts it back in the set.

**Amended 2026-11-07 (owner decision).** The verify set stays bounded to the three priority categories above. Before slice 2, the gather also dropped a mail in `awaiting_reply`, `meeting`, or `payment` when its object was closed. That drop is deliberately gone. These mails now stay in the briefing when their thing closes. Why: this decision bounds the set, so it also bounds the live reads of each run.

### 5. The store is the verdict, and a live read runs only when the state is ambiguous

The evidence order for a loop is:

1. **A receipt mail from the service.** Triage folds it at ingest (decision 2), so it is in the store before `verifyLoops` runs.
2. **Stored object state.** This is the verdict when it is not ambiguous.
3. **A live read.** It runs only in the three ambiguous cases below.
4. **The word of the user.** A todo that the user marks done, or a statement in chat, closes the work item only. It never sets the state of the thing.

The stored state is ambiguous in exactly three cases:

1. **The mail is newer than the fact.** A mail that points to the thing arrived after the newest stored fact. Example: a "Run failed" mail at 10:05 and a stored success from 09:50.
2. **The source was blind.** The ADR-0118 coverage of the source is not `live` between the stored fact and now (`silent`, `not_delivered`, or `record_incomplete`). On 2026-10-27, the store missed 27 merges in this way.
3. **No stored row.** The `about` link names a key, but no row for the thing exists.

A thing that is closed and not ambiguous is never read again. One cap applies to each run, and the things with the newest evidence come first. It replaces the three caps of 5.

**Amended 2026-11-07.** The slice 2 build changed case 2 and the evidence tier. A build note held these changes, and this amendment records them as decisions:

- **Case 2 reads the coverage first.** A silent gap counts only when it ends after the stored fact. A provider with no activity source (Railway, Vercel, MCP) can never show that it was not blind. Thus a stored fact from before this run is always ambiguous for its thing, and the thing gets a live read.
- **A fold of this run is a live read of this run.** The verified pull and the approved MCP health read fold their facts in the gather, before `verifyLoops`. A thing whose stored fact came from such a fold gets no second read. Its evidence is `live_read`, so its closing proof is `live_confirmation`. Why: the slice 2 build gave such a thing the evidence `stored_state`. A Railway target closes only from `live_confirmation`, so a Railway recovery stayed `unverified`.

### 6. One verifier registry

The registry is keyed by the provider and the kind of the thing, and it is typed from `INTEGRATION_OBJECT_DEFS`. A new kind does not compile until it names a verifier or an explicit `null`. The first entries are the GitHub pull request read (one REST batch call), the Railway target read, the Vercel target read, and the approved MCP health reads. For a deploy, the thing is the target, not the attempt, because an attempt never resolves.

**Amended 2026-11-07 (owner decision).** The approved MCP health reads are not in the registry yet. They stay a fold in the gather before `verifyLoops`, and their registry entry is `null`. The key of each read points the mail at the folded thing, also when the mail has no stored row. Slice 7 moves these reads into the registry. Why: a health read makes its key from the subject and the sender of the mail. `verifyLoops` reads only the stored `about` rows, and these rows do not hold that key (decision 3).

### 7. Read all, then one commit

All provider reads run first, outside any transaction, because they are slow network calls. Each read gives a provider fact. Then one transaction folds every fact through `applyEvent` and records the time of the run, which decision 4 uses. A repeated run folds the same facts as `duplicate` no-ops, and the recency guard refuses an older fact. Thus the commit is idempotent with no extra compare-and-set. A failed read writes nothing. It is the `unverified` verdict of decision 8 for that thing in that run, never a state.

**Amended 2026-11-07.** Two rules make the commit more exact:

- **Each fact carries the time when its read returned, not the time of the commit.** Why: a webhook can land between the read and the commit. With the commit time, an older read can replace that newer webhook fact in the recency guard.
- **A read earns the evidence `live_read` only when the store kept its fact.** The recency guard or an absorbing state can refuse the fact of a read. Then the row after the commit does not hold the state that the read saw, and the thing keeps the evidence `stored_state`. Why: a refused read did not set the state that the briefing shows.

### 8. The briefing reads one list with three verdicts

One composer tool replaces `list_closed_loops` and `list_loop_relevance`. It gives one item for each loop:

| Verdict | Meaning |
| --- | --- |
| `open` | The thing is `active` or `failed`. The state is from this run or from a fresh stored fact. |
| `closed` | The thing became `resolved` or `abandoned` in the window. The item carries the time of the fact, for the one-line recap. |
| `unverified` | A live read failed in this run. The item shows the last stored state and its time. The briefing never shows it as closed. (Amended 2026-11-07: more causes, see below.) |

Each item carries `stateCategory`, `nativeState`, the evidence tier of decision 5, the `SourceIdentity`, the title and the URL, and the `documentId` of each mail that points to the thing. `stale-but-open` is removed: it existed because closure needed a proof apart from the state, and the live read of decision 5 is now that proof. The loop-state tiers in the prompt map one to one: Verified-closed is `closed`, live is `open`, and couldn't-verify is `unverified`.

**Amended 2026-11-07.** Three rules make this decision more exact:

- **`unverified` has more causes than a failed read.** A thing is `unverified` when its live read failed or the cap stopped the read. It is also `unverified` when no reader exists for it, when the commit failed, or when a closing state failed its proof. `verifyLoops` logs the count of each cause.
- **A `closed` item comes only from a thing that closed in the window.** A thing that closed before the window gives no item. Why: an open todo can point to a thing that closed long ago, and the recap would show it again on each run. The drop rule below still counts that thing as `closed`.
- **The gather drops a priority mail only when every thing that the mail points to is `closed`.** The mail must point to at least one thing. Every thing counts, also a thing that has no item in the list because a cap or a schema check left it out. Before slice 2, the gather dropped a mail when one of its objects closed. Why: one mail can ask about two things, and the ask about the open thing stays open. Absence never closes a loop (ADR-0048 decision D), so a thing with no item cannot count as `closed`.

### 9. Code Mode gets the same three steps

The Code Mode runtime (`run` with `hostFunctions`, ADR-0087) gets three host functions:

- `loops.open({ since? })` gives the verify set as object handles.
- `loops.verify(handles)` runs the reads and gives the facts. It writes nothing.
- `loops.commit(facts)` folds the facts through `applyEvent`.

A script cannot write a state directly. It can only commit a fact that a verifier returned, so the rule that only a provider fact sets a state holds inside Code Mode too. The briefing gather runs the same procedure in code, with no model.

### 10. The deploy failures that no mail reported are activity

The Vercel and Railway pulls also find deploy failures that no mail reported. These are acts, not loops. Until ADR-0118 slice 6 adds ingest routes for deployments, a bounded live deploy read gives them to `readActivity` as an activity source. The pull leaves the loop path.

## Implementation slices

1. The object half of the ADR-0092 `about` observation at triage, with a 30-day backfill. **Built.** The row is a `gmail/email_interpretation` observation, one family for each message. It holds the triage category, the keys that the mail names, and the provider links of the sender's own service. It holds no resolution (decision 3). The family dedups against its head only, so the head always holds the latest triage result for the message. The backfill writes a row only for a message with a triage verdict in the run history, with that verdict. A failed classify stores `fyi`, which is not a priority category. The backfill is `apps/server/src/scripts/backfills/backfill-mail-object-links-committed.ts`.
2. `verifyLoops`: the set, the ambiguity rule, the registry (the live readers move out of `briefings/relevance.ts`), the commit and the run record, and the merged composer tool. It replaces `dropClosedLoops` and `assessLoopRelevance` in the gather, and it removes the `relevance.ts` disable lines of #1684. **Built.** `verifyLoops` is in `packages/assistant/src/knowledge/loops.ts`. The registry is `LOOP_VERIFIERS` in `connections/verified-pull/loop-verifiers.ts`. `objectStateStore.applyEvents` folds all the facts and inserts the `loop_verification_runs` row in one transaction. The composer tool is `list_loops`, and the gather input is `loops`. The 2026-11-07 amendments of decisions 1, 5, 6, 7, and 8 record the points of the build that change a decision. These other points make the decisions above more exact:
   - **The Vercel verifier has no thing yet.** Its verifier is in the registry, but a Vercel thing is not a loop (decision 1 amendment).
   - **An absorbing state is never ambiguous.** No later fact can move a merged pull request, so it is never read again.
   - **Case 2 reads the coverage before the merged-read proof.** The decision 5 amendment gives the rule for a provider with no activity source, and for a fold of this run.
   - **Case 3 mints the row.** The GitHub read gives a `pull_request_read` fact for an open, a closed, or a merged pull request. It holds the full identity (the GitHub id, the URL, the repository, and the number), so it mints the row that no webhook minted (amends ADR-0062). Railway and Vercel read no key, so they have no case-3 read.
   - **A closing state passes its proof.** A thing closes only through `closesOpenAsk` with the proof that the run holds: `live_confirmation` after a live read of this run, else `stored_projection`. The amendments of decisions 5 and 7 say which reads count. A closing state that fails its proof is `unverified`.
   - **One cap of 10 live reads for each run.** A soft edge (`nomination`) points to nothing.
   - **The gather drops a priority mail only when every thing that it points to is `closed`.** See the decision 8 amendment. The mails in `awaiting_reply`, `meeting`, and `payment` are outside the verify set, so a closure no longer drops them (decision 4 amendment).
   - **The soft-edge count of ADR-0109 moves into `verifyLoops`.** It now counts the mails of the verify set.
3. The Vercel and Railway pulls move into the registry, and the deploy failures with no mail become a live read behind `readActivity` (decision 10). This closes #1683. The owner deferred #1683 from slice 2 to this slice on 2026-11-07.
4. Things that only mail tracks (decision 2), with the Voyage AI case as the first proof.
5. The Code Mode host functions (decision 9).
6. The GitHub merged read becomes only the silence proof behind `readActivity` (#1684 rows 1 to 4).
7. The approved MCP health reads move into the registry (decision 6 amendment, 2026-11-07).

## Preserved behavior

- Absence never closes a loop (ADR-0048 decision D). A failed read gives `unverified`, never `closed`.
- Only a deterministic reducer sets object state, and only a provider fact feeds it (ADR-0062, ADR-0109). `applyEvent` stays the one writer.
- A custom MCP row cannot override the verdict of a built-in provider.
- The triage tag path reads no activity search and no embeddings (ADR-0113).
- `integration_objects` keeps its versions (`valid_from`, `valid_until`, `supersedes_id`).
- Postgres stays the only store (ADR-0058).

## Residual risk

- **The store can be wrong without being ambiguous.** A provider can change a state without a mail and without a webhook, while the coverage still reads `live`. The briefing then shows the old state until a new mail arrives. The coverage rule of ADR-0118 decision 4 is the guard, and it is only as good as the silence proof of each source.
- **The first run reads 30 days only.** A loop opened by a mail older than 30 days, with no open todo, is not in the set.
- **The service-mail rule depends on the sender.** A relay that copies the domain of the service could set a state. Decision 2 needs the same sender gate that the reconcile adapters use.
- **Old failed Vercel rows are still read on each run (#1683).** Slice 2 does not change the Vercel verified pull. The owner deferred this fix to slice 3 on 2026-11-07.
- **A run with a failed read still moves the window.** Each committed run records its time, also when a read failed. Thus an `unverified` thing whose mails are all older than the next window leaves the set. A new priority mail or an open todo puts it back.
- **Slice 1 changes triage.** A fault in the `about` writer loses the link of each new mail. The write is non-fatal, so triage continues. The backfill is idempotent, and a new run writes the lost links again.

## Rejected alternatives

- **(a) A `loops` table, or a `gmail`/`ask` kind for each thread.** It copies the thing, and its state would come from inference, not from a provider fact.
- **(b) A live read for each thing on each run.** Each verdict is fresh, but the reads grow with the set, and a closed thing is read again each day.
- **(c) A fixed 3-day window.** A week with no briefing would lose the loops of that week.
- **(d) A `gmail_thread` key on the thing as the link.** A key states the identity of a thing, not evidence that a mail is about it, and it cannot keep the time of each mail.
- **(e) One transaction for each thing.** A partial run keeps part of its facts, and the time of the run is not clear.
- **(f) A model-written Code Mode script on each gather.** It adds model cost to each briefing, and the runs are less repeatable.
