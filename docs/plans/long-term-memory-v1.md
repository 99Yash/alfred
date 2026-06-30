# Long-term memory v1 — grounding + persistent memory foundation

Status: design locked 2026-06-11 (grill-with-docs); **vertical slice 1 locked 2026-06-15** (grill-with-docs). Decisions: **ADR-0056** (governance) + **ADR-0057** (capture + significance + chat→memory) + **ADR-0058** (store: Postgres over a graph DB; build the intelligence, don't buy the store) + **ADR-0059** (directional triage significance — un-defers D1, **reorders P3 + P4a ahead of vertical slice 1**, splits P4 into P4a/P4b, 2026-06-15 grill-with-docs) + **ADR-0060** (standing-instructions generalization — prose-first central store + deterministic-enforcement carve-out, 2026-06-17 grill-with-docs; build order under _Standing instructions — generalization build order_). Glossary terms in [CONTEXT.md](../../CONTEXT.md) under _Long-term memory_ + _Run grounding_ (incl. _Suppression standing instruction_, _Resolve-at-write_, _Recurrence-decay_). Backlog rows `GROUND-001/002/003`, `MEM-002` in [june-demo-triage.md](./june-demo-triage.md).

## Build status (reconciled against code 2026-06-28)

Most of the foundation shipped between 2026-06-11 and now (PR #128 memory base, #131 read surface, #545a9310 standing-instruction management + briefing suppression, #6d2820be search-before-ask sender resolution, P3/P4a 2026-06-16). The phase bodies below are the original design narrative; this ledger is the source of truth for what's left.

| Item                                            | State                     | Evidence / gap                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Vertical slice 1** (suppression loop)         | 🟢 **Shipped** — close it | `system.remember`/`resolve_todo`/`list`/`forget`/`edit_instruction` (`tools/system.ts`), v1 `standing-instructions.ts`, suppression readers, briefing `gather`/`read` filter, honest chat copy, `sender-suppression-grounding.eval.ts`. **Caveat:** enforcement landed on chat-capture + briefing only — _not_ the planned triage hard-veto (item 21).                                     |
| **P0** — date/tz grounding                      | 🟢 Shipped                | `agent/grounding.ts`, `user-timezone.ts`, `date-grounding.eval.ts`; injected into both boss + chat prompts.                                                                                                                                                                                                                                                                                |
| P0 — recovery envelope + eager tool declaration | 🟡 Partial                | `integrationActionSuggestion` lists the static action enum, not a live toolkit probe; eager connected-tool declaration + dispatch floor still deferred (chat lazy-loads).                                                                                                                                                                                                                  |
| **P1** — `read_user_context`                    | 🟢 Shipped                | Registered boss/chat/sub-agents (`tools/system.ts`); `readTriageUserContext` is the shared reader.                                                                                                                                                                                                                                                                                         |
| **P2** — governance plumbing                    | 🔴 Mostly open            | Only the standing-instruction write tools exist. **Absent:** `system.update_fact` + relationship-link tool, `rejected_inferences.cause` enum, persisted `rationale`, `notify()` tiering (debounce/digest), in-app memory changelog/review UI.                                                                                                                                              |
| **P3** — significance + directional triage      | 🟢 Shipped                | `memory/significance.ts` (`computeSignificance`/`runSignificancePass`), `triage/sender-relationship.ts`, 16b rubric rewrite, **16a founder/CEO carve-out deleted**.                                                                                                                                                                                                                        |
| **P4a** — team-graph backfill                   | 🟢 Shipped                | `memory/team-graph.ts`, `backfill-team-graph-committed.ts`, `memory/entity-metadata.ts`.                                                                                                                                                                                                                                                                                                   |
| P4b — onboarding seed + dossier                 | ⚪ Deferred (as planned)  | Gated on unbuilt run-scoped autonomy override; `person_profiles` unbuilt.                                                                                                                                                                                                                                                                                                                  |
| **P5** — chat→memory                            | 🟡 Partial                | Boss does `system.remember` on _explicit_ request only — no automatic durable-vs-run classifier; standing instructions read on-demand via the tool, **not** injected into ambient Run grounding.                                                                                                                                                                                           |
| **SI-1→SI-6** (ADR-0060 v2 generalization)      | 🔴 Open                   | Contract still `schemaVersion:1`, sender-suppression only. Unbuilt: schema v2 (`directive`/`target`/`enforcement`), `getRelevantInstructions(context)`, triage `force_category`/`force_todo` override layer + breadcrumb, prose-first compose application, `/settings` review panel, SI eval suite. (`list`/`forget`/`edit_instruction` tools cover a thin slice of SI-5 via chat, no UI.) |
| P6 — decay/eval-lane/hybrid retrieval           | ⚪ Deferred (as planned)  | —                                                                                                                                                                                                                                                                                                                                                                                          |

**What to close now:** Vertical slice 1, P0 (core grounding), P1, P3, P4a. **What's genuinely left:** the triage-side suppression veto (item 21, partly subsumed by P3 for cold senders), P2 governance plumbing, P5's auto-capture classifier + ambient injection, and the whole ADR-0060 v2 generalization (SI-1→SI-6). These are the remaining backlog — track under epic #218 / a fresh ADR-0060 build issue rather than this plan.

### Consumer wiring lives in the ADR-0067 substrate, not here (read before extending P3/P4)

**P3 (significance + directional triage) and P4a (team-graph) shipped against the _legacy single-source_ graph** — `memory/significance.ts` (`computeSignificance`/`runSignificancePass`) + `memory/team-graph.ts` over the `entities`/`entity_relations` tables, read by triage through `isKnownContact` + `resolveSenderRelationship`. That graph is **the polluted substrate ADR-0067 rebuilds** ([multi-source-user-model-v1.md](./multi-source-user-model-v1.md)): single-source (Gmail-headers-only), no cross-source identity, unrecomputable significance, dist-lists outranking humans. So the directional-triage _machinery_ is built and correct, but it reads the wrong data — which is why the #218 symptom issues (#210 over-tag, #212 dist-list, todo bloat) are still open even though P3/P4a are "Shipped."

**The destination for all consumer wiring is ADR-0067 P5 (consumer cutover), not new work in this plan.** The seam is already the right shape: triage reads the graph through `isKnownContact` + `resolveSenderRelationship`, briefing through `gather` priority, todo through D1. ADR-0067 P5 **swaps what those resolvers read from** — legacy `entities`/`findPersonMetadataByAddress` → `userModelReader` (active projections) — keeping the rubric and resolver APIs unchanged. **Gated on the ADR-0067 Gmail fold (P1 E–G) landing and being activated** — until then there are no `entity_profiles` to read. Do not build a parallel significance/relationship reader here; extend the ADR-0067 reader and re-point these resolvers. This plan's P3/P4a are the consumer-side _logic_; ADR-0067 is the _data_ they will read.

## Why this exists

The trigger was a demo-killer: the boss asked "how many meetings in October 2026" and replied "which year?" — it had no date. Investigation found the boss is blind on **three** channels: no ambient date, no list of connected tools, and **no access to the user-memory substrate at all** (`system.read_user_context` was specced but never registered). Meanwhile the storage layer is mature and well-built — the problem is everything _around_ it: the read surface, capture quality (prod `entities` = 0), lifecycle policy, and an organizing taxonomy.

**The substrate is frozen, not redesigned.** `user_facts` (confidence·status·source·valid_from·valid_until·supersedes_id), `entities` + `entity_relations`, `memory_chunks` (pgvector), `style_profiles`, `rejected_inferences` are adopted as-is. We extend with two additive columns; no table redesign.

## The model in one screen

- **Three channels the boss perceives the world through:** **Run grounding** (ambient prompt facts: date, connected summary, standing instructions), **declared tool schemas**, **`read_user_context`** (durable memory, pull-on-demand).
- **Knowledge organized by kind, not table** (lifecycle is per-kind, no global TTL): identity · standing instructions · people & relationships · episodic facts · style · episodic memory.
- **Governance (ADR-0056):** autonomous-write + tiered-notify + always-reversible. Confidence gates _notification cadence_ and the `proposed`/`confirmed` _review label_, not the write. History append-only. User correction is authoritative (Loop 1) and a training signal (Loop 2 → eval lane, no auto-tuning).
- **Capture (ADR-0057):** fully passive — integrations + significance-gated web-search enrichment, plus proactive chat→memory. No onboarding interrogation.
- **Significance score:** one computed signal over `entities`, four consumers (enrichment gate · todo D1 · triage priority · meeting-prep).

## Vertical slice 1 — the suppression loop (the "Ben Book" slice)

The horizontal P0–P6 below builds the whole foundation. **This slice is the thin vertical cut that closes one real prod loop end-to-end** and proves the architecture on the way. It touches P0 (grounding), P1 (read surface), P2 (write tools), and P5 (chat→memory) on the narrowest path — _not_ P3/P4 (significance, team graph), which the loop doesn't need.

### The incident it closes (prod, 2026-06-13)

User told Alfred in chat: _"can you stop emailing me about replying to ben book. i don't want it. that was spam."_ It didn't stop. The next briefing (evening, 18:55Z — **after** the chat and after the user manually dismissed the todo) still **led** with Ben Book. "Ben Book" = `ben@anyipswift.com`, a **cold sales email** about the user's repo. Four independent breakages, each sufficient alone:

| #   | Failure                                                                                                                | This slice                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | Cold sales email escalated to `awaiting_reply` (triage root miss)                                                      | **Now in scope via ADR-0059** (was out-of-slice) — the LinkedIn-recommendation complaint (2026-06-15) is the same root miss; fixed at the root by directional significance (P3 + P4a + rubric rewrite), pulled _ahead_ of this slice. The per-sender suppression here remains the user's _override on top_, not the substitute |
| B   | Briefing escalated by **persistence** ("survived every briefing")                                                      | **In** — recurrence-decay principle                                                                                                                                                                                                                                                                                            |
| C   | Boss had **no resolve/dismiss tool**; said "I marked it resolved" but only called `suggest_todo` (kept the todo alive) | **In** — `system.resolve_todo`                                                                                                                                                                                                                                                                                                 |
| D   | **Nothing** captured "stop / that's spam"; triage + briefing read no user signal                                       | **In** — the suppression standing instruction + the non-boss read path                                                                                                                                                                                                                                                         |

### The data primitive (resolve-at-write)

One `user_facts` row — no new table (ADR-0058):

```jsonc
key:   "standing_instruction"
value: {
  schemaVersion: 1,
  action:        "suppress",
  surface:       "open_loop",  // product/display term (the human intent) — NOT what consumers branch on
  target:        { kind: "sender_email", email: "ben@anyipswift.com", label: "Ben Book", accountId: null },
  effects:       ["block_todo_suggestion", "exclude_briefing_priority"],  // the OPERATIONAL contract consumers check
  directive:     "Do not surface or remind about email from Ben Book <ben@anyipswift.com>; user marked it spam.",
  phrasing:      "stop emailing me about replying to ben book"            // verbatim, provenance/UI only — never parsed
}
// confidence / status / supersedes_id / valid_until(null) / row_version — all already on the table
```

- **`effects` is the contract, `surface` is the label.** Each consumer checks `effects.includes("block_todo_suggestion")` / `"exclude_briefing_priority"` — it never has to ask "does `open_loop` include me?". `surface` stays as the human-readable product term for UI/`directive` generation. `schemaVersion` lets the reader evolve the shape without ambiguity. **Defined as a closed enum + the full `value` zod schema in `@alfred/contracts` (`standing-instructions.ts`, `SUPPRESSION_EFFECTS` / `standingInstructionValueSchema`)** — one source the `user_facts` column type, the `system.remember` write tool, and the readers all agree on; a new consumer registers its effect there first.
- **`user_facts`, not `user_preferences`** — facts carries `supersedes_id` (revoke/change over time), `status`, `valid_until`, and the Replicache `row_version` that already syncs `proposed`/`confirmed` facts to the client (`replicache/entities.ts` `FACT` fetcher). (Closes the plan's open "user_preferences vs sibling table" question for the standing-instruction kind.)
- **Sender-scoped, cross-account by default** (`target.accountId: null`) — the user is suppressing _the sender_, not one mailbox instance; the field exists so a future per-account scope is expressible without a reshape. **Persist-until-revoked** (`valid_until=null`; a later "surface Ben again" supersedes). Topic-scope (fuzzy → prompt-inject) and time-boxed snooze (`valid_until`=grounded-now+window) are deferred variants of the same shape.
- **Resolve-at-write:** consumers match on `target.email` (lowercased) / read `directive`; **never parse `phrasing`**. See CONTEXT _Resolve-at-write_.

### Capture path (chat → memory)

Boss recognizes durable intent ("stop", "that's spam", "I don't want it" → durable; "ignore that for now" → run-scoped ADR-0035 directive, dies with the run) and performs **two** writes — the incident needed both and had neither:

1. **`system.remember`** — writes the row above under ADR-0056 governance.
2. **`system.resolve_todo`** — closes the live loop. **Source/sender-based resolution, not just `todoId`** (the boss usually doesn't know the id): input accepts `{ todoId? | senderEmail? | source? }`, mirrors `suggest_todo`'s source-overlap matching, and returns `ambiguous` + candidates when >1 matches (boss disambiguates rather than guessing). Uses **`dismissed`** for spam/suppression — _not_ `done` (`done` implies completed and trips the 2-day done-sync/Gmail-label window per `todos.ts`). The missing tool behind failure C.

**Canonical resolution is a precondition of the write:** the boss resolves `"ben book"` → `ben@anyipswift.com` from the open thread; if it can't resolve confidently, it asks a one-line clarifying question rather than guessing (the antidote to the original "searched ben book, found its own reminder emails" confusion).

### Enforcement path (the part that makes it _stop_) — defense-in-depth

**One reader, not two ad-hoc JSON checks.** A single shared helper owns the zod parse, `proposed|confirmed` status filter, `valid_until` filter, and lowercased-email matching — `listActiveSuppressionInstructions(userId)` + `isSenderSuppressed(userId, senderEmail)`. Triage and briefing both call it; the `value` JSON is never hand-inspected at a call site. This is the concrete realization of the "non-boss read path."

An **orthogonal suppression check** (NOT a category bend — category stays the honest classification), in **both** consuming surfaces, because "a fix in triage is not a fix everywhere":

- **Triage `classify.ts`** — `isSenderSuppressed` as one more deterministic sender signal; on hit (effect `block_todo_suggestion`) → **block the `todoSuggestion`** (hard veto, no flash-lite relitigation). **Audit breadcrumb:** log `suppressedByInstruction: { factId, target }` alongside the existing `triage.sender_extraction` trace, so a future debugger doesn't see "model proposed → nothing minted" with no reason.
- **Briefing `gather`** (`gatherBriefingDigest`, `briefing/gather.ts`) — filter the priority-bucket rows through the same reader (effect `exclude_briefing_priority`) before compose. (This is the gap that let the 18:55 briefing still lead with Ben after the todo was dismissed — gather read no user signal.) **Audit breadcrumb:** log dropped count + fact ids.
- **Briefing prompt (failure B) — generalize, don't bolt on.** The prompt already has a stale-repeat rule scoped to PRs ("Don't re-surface stale PRs", `briefing/prompt.ts`). **Generalize that paragraph** into the **recurrence-decay** principle — _un-acted-upon recurrence decays salience, never escalates it_ — covering any recurring item, not just PRs. Make it an **eval-backed prompt change** (ADR-0055 lane), **not a build blocker** for the slice: the deterministic suppression check above is what actually closes the loop; recurrence-decay is the defense-in-depth that stops _un-suppressed_ items from self-escalating.

The boss's `system.resolve_todo` closes the live todo, so we **don't** need a forced re-triage of stale rows to close this loop (correcting the Gmail label is a deferred nice-to-have).

### Time grounding — a hard prerequisite

The whole failure class is **relative-time reasoning** ("days overdue", "since Monday", "another night"). **GROUND-001 (P0) is a prerequisite of this slice**, not a parallel effort. Split:

- **Reasoning** ("is this overdue?") → today's date + `IanaTimezone` ambient in **Run grounding** (recover `grounding.ts`/`user-timezone.ts`/`date-grounding.eval.ts` from `fix/briefing-too-long` `c3ba3433`).
- **Rendering** ("show _June 26_, not _tomorrow_") → resolve relative→absolute in the deterministic gather/compose layer; instruct the prompt to render absolute dates.
- **No bash/`date` tool on the boss** — breaks cache-stable Run grounding, returns the _server's_ UTC clock (not the user's tz — the historical briefing bug), and is wildly overscoped. The fact's own temporal fields (`valid_from=now`, any `valid_until`) are stamped server-side **at insert**, never asked of the model later.

### Honest chat copy (product)

"Stop emailing me" _sounds_ like a request to mutate the mailbox (a Gmail filter). This slice does **not** touch Gmail — it stops Alfred's _own_ surfacing. So the boss's reply must be explicit and reversible:

> "I'll stop surfacing reminders and briefing items about Ben Book. The emails will still arrive in Gmail unless you'd like me to create a filter."

This keeps the slice honest (no implied mailbox mutation) and leaves "create a Gmail filter" as a separate, explicit action for later.

### Notification

- **In-app: the row is Replicache-visible and revocable through the existing memory mutation path.** A `standing_instruction` is a `user_facts` row with `status ∈ {proposed, confirmed}`, so it syncs to the client today via the `FACT` fetcher — no new sync work. A _polished_ changelog/revoke UX is a **separate surface, not in this slice**.
- **Revocation mechanism (explicit, in-slice):** reversal = **reject the fact** via the existing reject mutation → `status='rejected'` + `cause='user'` (ADR-0056). The shared reader filters to `proposed|confirmed`, so a rejected instruction is **inert by construction** — no separate "disable" flag. (A _positive_ "always surface Ben" allow-rule — a superseding standing instruction — is a deferred variant, not how v1 reversal works.) The implementation task is: _the reject path must be reachable for a `standing_instruction` row and the reader must exclude rejected rows_ — both already true, so this is a verification task, not new code.
- **Email notification: skipped for a user-initiated, same-session write** — the user just said it in chat; don't email to confirm what they witnessed. Refines ADR-0056 tiering: _notification informs the user of things they didn't already witness._ The critical email tier still governs background/passive writes.

### Acceptance test (the demo)

1. In chat, "stop emailing me about replying to Ben Book" → boss resolves the sender, replies with the honest copy above, calls `system.remember` (row syncs to the client) **and** `system.resolve_todo` (the live todo flips to `dismissed`).
2. A new email from `ben@anyipswift.com` → triage classifies honestly **but mints no todo** (breadcrumb logged).
3. The **next briefing does not lead with — or mention — Ben Book**, even though it recurred in prior briefings.
4. **Reject** the `standing_instruction` fact ("surface Ben again") → `status='rejected'` → the shared reader (filtering `proposed|confirmed`) no longer matches → Ben can surface again.

### Slice scope boundary

**In:** date+tz grounding recovery (GROUND-001); `system.remember` + source-resolving `system.resolve_todo`; the suppression row + the single shared reader + the dual-surface check + audit breadcrumbs; the honest chat copy; recurrence-decay **as an eval-backed prompt generalization** (defense-in-depth, not the load-bearing fix). **Out (deferred):** failure A (cold-outreach mis-classification — sender-prior/rubric); topic-scoped suppression; time-boxed snooze; a polished memory changelog/revoke UI (rely on the existing `factEdit`/reject mutation in-slice); eager connected tool declaration + dispatch floor (rest of P0); Gmail-filter creation (real mailbox mutation — a separate explicit action); confidence-decay sweep (D2); forced re-triage of stale rows. **Note (ADR-0059):** failure A and the significance score + team graph are **no longer deferred behind this slice** — P3 + P4a are reordered _ahead_ of it as the root fix; the slice's per-sender suppression is the override on top, not the substitute.

## Phases

Ordered by dependency. P0–P1 = Track 1 (the screenshot unblock, days). P2–P5 = Track 2 foundation. P6 = post-demo. **Vertical slice 1 (above) cuts across P0/P1/P2/P5** — build it as the first end-to-end thread, then generalize into the full phases. **ADR-0059 reorder:** P3 + P4a are pulled **ahead** of vertical slice 1 (the root fix for failure A); P4b stays deferred behind the run-scoped autonomy override.

### P0 — Run grounding + recovery envelope (`GROUND-001`, `GROUND-003`)

- Recover the stranded date commits from `fix/briefing-too-long` (`c3ba3433`): `grounding.ts`, `user-timezone.ts`, `date-grounding.eval.ts`.
- **Connected summary already exists** (`agent/connected-summary.ts`, ADR-0053) — snapshotted into `agent_runs.state` at run start and injected into the boss/chat prompt. The **remaining** P0 work is eager connected _tool declaration_ + the dispatch floor (chat still initializes `activeIntegrations: []` and lazy-loads — `chat-turn.ts`). **For the suppression slice this is mostly deferrable:** the slice adds always-on `system.*` tools, which don't ride `allowed_integrations`/lazy-load; the slice's real P0 dependency is the **date + tz grounding recovery** above, not the tool-declaration work.
- Inject date + connected summary into **both** boss and chat prompts as one run-start snapshot.
- Recovery envelope (`dispatch/index.ts`): an unknown action on an allowed+connected integration returns that integration's **real action list**; `integrationActionSuggestion` handles qualified names (today bails on any `.`).
- **Accept:** date eval passes + a connected-summary assertion; inventing `github.list_pull_requests` returns "github exposes: `search`…".

### P1 — Wire `read_user_context` (`GROUND-002`)

- Promote `readTriageUserContext` to a shared reader; register `system.read_user_context` (always-on, autonomy, `no_risk`) for boss/chat/sub-agents.
- Returns profile + `valid_until`-filtered facts (with confidence so the boss can hedge) + entities + preferences + recent memory; bounded.
- Prompt instructs reaching for it on people/relationship/personal-context questions.
- **Accept:** boss answers "who's my manager" by reading memory, not guessing. (Near-no-op over empty prod tables until P4 — that's expected; ship the wiring.)

### P2 — Governance plumbing (ADR-0056)

- `system.*` memory write tools: `system.remember`, `system.update_fact`, `system.forget`, relationship-link tool. Background extraction calls the **same write functions** so criticality/rationale/notification fire uniformly.
- Persist the **rationale** (cheap-model ~2-sentence telegraphic "why") on write — extraction computes it today but drops it. Pair with `source` evidence pointers (→ SEARCH-001).
- Add `rejected_inferences.cause ∈ {user, write_time_contradiction, decay, superseded_by_newer}`.
- Notification tiering via `notify()`: critical → ~5-min debounce + batch (approval-debounce mechanism); subtle → digest on count-threshold OR weekly.
- In-app **memory review/changelog surface**: `user_facts` Replicache-synced (has `row_version`), changes appear one-by-one; confirm/edit/reject affordances (extends ADR-0019's memory-page intent).
- **Accept:** an autonomous fact write lands live, fires the right notification tier, shows in the changelog, and a reject records `cause='user'`.

### P3 — Significance score + directional triage resolver (ADR-0057 + ADR-0059, builds ADR-0050 D1)

**Reordered ahead of vertical slice 1 (ADR-0059)** — this is the root fix for failure A (the LinkedIn-recommendation complaint).

- **Significance score (scalar, unchanged contract):** computed signal over `entities` — frequency + recency + reply-reciprocity + same-org-domain + explicit relation edges. Start simple; weights tunable. Stays a **scalar**; the four consumers (enrichment gate, triage sender priority, meeting-prep, todo D1) are unchanged.
- **`Sender relationship` resolver (triage-local, ADR-0059):** composes the scalar score + the sender's `entities` row (org/designation) + the user's identity `user_facts` (`company`/`job_title`) + a shared-org-domain test → `{ relationType, direction, theirDesignation, yourRole }`. **No self-entity** — direction is derived; `user_facts` stays the source of truth for who the user is. Lives in the triage module, not the shared primitive (only D1 needs the edge).
- **Rubric rewrite (`classify.ts`):** inject the resolver output as deterministic context (alongside sender priors/persona/observations); 16b flips from "judge the stake from the email ALONE" to "judge stake from the email **plus the `Sender relationship` block**; never infer beyond it" — **degrades to today's intrinsic-only when the graph is empty** (additive, safe). **Delete** the founder/CEO/CTO LinkedIn carve-out in 16a. Gate the **todo**; `awaiting_reply` **stays the honest category**; low-significance cold asks deprioritize within the bucket via the `triage sender priority` consumer. Eval-backed (ADR-0055): cold recommendation-seeker → `awaiting_reply`, no todo; significant person's ask → todo.
- **Accept:** one query returns ranked significant people; a cold LinkedIn recommendation-seeker → `awaiting_reply` + **no** todo; a real report/investor ask → todo; with an empty graph, behavior == today.

### P4 — Passive capture + web enrichment (ADR-0057; MEM-001) — split along the autonomy seam (ADR-0059)

Population is **passive-capture only — never cold-start** (cold-start is account-holder-scoped and has nothing ingested to read at callback). `upsertEntity`/`linkEntities` exist with **zero call sites today** — the missing code is the extractor.

**P4a — backfill over already-ingested correspondence (build now, ahead of slice 1):** _(built 2026-06-16)_

- Standalone extraction job over the existing `documents` + calendar → `entities` + `entity_relations` (attendees, senders, recurring threads; designation + org-domain into `metadata` — typed-column decision deferred to build).
- First significance pass over the populated graph.
- **No autonomy-override or cold-start dependency** — the existing single user is already connected under watcher-approved autonomy; this is the path that unblocks failure A / P3's resolver.
- **Accept:** prod `entities` is no longer 0; `isKnownContact` + the `Sender relationship` resolver return real data for known senders.

  **Implementation (2026-06-16):**
  - `memory/team-graph.ts` — `backfillTeamGraph(userId, userEmail, opts)` + `aggregateCorrespondence`. Header-level, **no LLM/network**: parses `from`/`to`/`cc` + `isSent` into `person` entities (email in `aliases` → `isKnownContact` matches; correspondence aggregate in `metadata`), `organization` entities per **non-consumer** domain (reuses cold-start's `isConsumerEmailDomain`), and `works_at` edges. Person inclusion reuses triage's `extractSenderContext` (`fromKind === 'person'`) — humans incl. cold one-way senders captured, `noreply`/role/service dropped.
  - `memory/significance.ts` — `computeSignificance` (pure scalar in `[0,1]`) + `runSignificancePass`. Blend: **activity = frequency × recency** (a fresh cold blast must not score like a relationship), reply-reciprocity, same-org-domain. Weights are named constants (`DEFAULT_SIGNIFICANCE_WEIGHTS`), tunable per the open item.
  - `memory/entity-metadata.ts` — zod source-of-truth for the `person`-entity metadata bag (`correspondence`, `significance`).
  - **Storage decision (was deferred to build):** designation/org-domain/score go in the `metadata` bag, **not** new typed columns — additive, matches `upsertEntity`'s metadata-merge; revisit only if a query needs to index them.
  - `apps/server/src/scripts/backfill-team-graph-committed.ts` — committed, **dry-by-default** (`--commit`), bundled as a tsdown entry for `railway ssh -s server`. Idempotent.
  - **v1 limits (honest, not gaps):** **email-only** (no `gcal` ingest path yet → no attendee edges); **no `theirDesignation`** (not in headers → waits on P4b web enrichment); user-domain set = the `user.email` domain only. Unit-tested in `test/memory/team-graph.test.ts`.

**P4b — onboarding-time seeding for new users (deferred):**

- Header-level `gmail.search`/`calendar.list_events` seed (senders, attendees, frequencies) at onboarding, **gated on the unbuilt run-scoped autonomy override** (v2.1) since new users default to `gated`.
- Build **`person_profiles`** (ADR-0042, unbuilt) with `identity_confidence`-tier TTL.
- Significance-gated, budget-capped **web-search dossier** enrichment for above-threshold entities; corroboration raises confidence.
- First-run "still learning about you" state (steal dimension's live-progress pattern).
- **Accept:** a fresh signup populates a header-level graph without manual interrogation; the boss can name top collaborators with roles + citations.

### P5 — chat→memory (ADR-0057)

- In-band proactive `system.remember` on durable intent; end-of-thread extraction (ADR-0019 trigger) for passing statements.
- Durable-vs-run-scoped classifier ("from now on" → persist; "for this conversation" → ADR-0035 `user_directives`).
- Standing instructions persisted + injected into **Run grounding** (ambient).
- **Accept:** "from now on ignore Dependabot" persists, notifies (critical), and biases later triage; "just for now…" does not persist.

### P6 — Post-demo

- Confidence-decay sweep (ADR-0050 **D2**).
- Loop-2 misses dataset → eval lane (ADR-0055) wiring; no auto-tuning.
- Hybrid retrieval: Postgres tsvector FTS + pgvector fused (RRF) — no new infra; better recall for names/IDs. (Not turbopuffer.)

## Standing instructions — generalization build order (ADR-0060)

The shipped suppress-sender slice is one corner of a 3-axis space (action × target × effect). ADR-0060 generalizes it into **one central store + one retriever + prose-first application + a deterministic-enforcement carve-out**. This is **one coherent ship, ordered by dependency — not staged scope** (no V1/V2). Each step lands behind the next; the existing slice keeps working throughout (the suppression row is the `enforcement`-bearing special case of schema v2).

### SI-1 — Schema v2 + generalized reader/retriever (foundation)

- `@alfred/contracts/standing-instructions.ts` → `schemaVersion:2`: `directive` (always) + `target?` (`kind: sender_email|sender_domain|person|category|topic`, resolved-at-write key) + `enforcement?` (`{effect, params?}`, registered set). **Drop `action`/`surface`.** Reader parses v1 **and** v2 (near-free migration; prod has a handful of rows).
- Generalize `listActiveSuppressionInstructions`/`findSenderSuppression` into **`getRelevantInstructions(context)`** — inject-all-active behind a context-aware signature (the semantic-filter swap lives behind this later, no call-site change).
- **Accept:** v1 suppression rows still match; a v2 row round-trips; the retriever returns active instructions for a given context.

### SI-2 — Deterministic enforcement generalization (triage classify + briefing gather)

- Triage: generalize today's veto into a **post-classification override layer** — `block/force_todo_suggestion`, `force_category{category}` (the override **logs `overriddenByInstruction:{factId,from,to}`** — non-negotiable), consumed alongside the existing security override-floor.
- Briefing gather: add `include_briefing_priority` symmetric to today's `exclude_briefing_priority`.
- **Precedence resolver** (shared): specificity (`sender_email`/`person` > `sender_domain` > `category` > `topic`) then recency; the **protective floor beats a user down-rank, never an up-rank**; `enforcement` authoritative over intrinsic judgment for the touched dimension.
- **Accept:** "tag Priya urgent" force-stamps + logs; "always track X" forces a todo; the security floor still wins over a `force_category:fyi` down-rank.

### SI-3 — Prose-first application (briefing compose + chat + meeting-prep)

- Each pulls `getRelevantInstructions(context)` and applies the `directive` by judgment; **no-double-application** (skip any instruction already honored by an `enforcement` this consumer owns).
- Boss/chat keeps ambient delivery via Run grounding; compose/meeting-prep inject at compose time.
- **Accept:** a prose-only topic rule ("don't dwell on the Q3 launch in my brief") changes compose output; a suppressed sender never appears in compose (already dropped by gather).

### SI-4 — Generalized capture (`system.remember` + conflict + disambiguation)

- Generalize `system.remember` from sender-suppression to the full taxonomy: boss resolves `target`, decides prose-only vs `+enforcement`, writes schema v2.
- **Structural conflict detection in the tool** → `status:"conflict"` + conflicting fact(s) (extends `already_exists`); **never overwrite a contradiction**. Boss prompt: **semantic/counterproductive** check via `read_user_context`; **multi-candidate disambiguation** ("which Ben"); **offline conflict → hold `proposed`**.
- **Accept:** "always surface Ben" against an existing "suppress Ben" returns `conflict` and the boss asks; "mute @oliv.ai" warns about the manager; an ambiguous name asks which.

### SI-5 — Review surface (`/settings` Standing instructions panel)

- Read-only list of active rules (plain-English `directive`) + **undo/reject** + **edit**, over the already-synced facts (`row_version`) + existing reject/edit mutations. No new sync.
- **Accept:** every active instruction is visible; reject makes it inert (reader filters `proposed|confirmed`); edit supersedes.

### SI-6 — Evals (ADR-0055 lane)

- Deterministic-scorer cases: `force_category` override + breadcrumb; block/force todo; include/exclude briefing; structural-conflict detection; precedence (specificity, recency, floor-vs-down-rank); no-double-application.
- **Accept:** the suite pins the override/conflict/precedence contracts before they regress.

## Schema deltas (additive only)

- `rejected_inferences.cause` (+ cause on the superseded `user_facts` row's `source` or a sibling).
- `rationale` on the memory write path (`user_facts` column or its `source` jsonb — decide in P2).
- `person_profiles` table (P4; extends the ADR-0042 spec).
- Standing-instruction storage shape — **decided (slice 1), generalized (ADR-0060):** a `user_facts` row, `key="standing_instruction"`, JSONB `value` — **`schemaVersion:2`** = `directive` (always) + `target?` + `enforcement?`, `action`/`surface` dropped (reader handles v1; near-free in-place migration, no new table). Chosen over `user_preferences` for `supersedes_id` + `status` + `valid_until` + the Replicache changelog `row_version`. See _Standing instructions — generalization build order_ above.

## Open questions (settle from data/build, not now)

- Significance weights + threshold + enrichment budget.
- Confidence floor (0.7) + whether any surface excludes `proposed` facts.
- Exact critical-vs-subtle notification set + digest count-threshold.
- `person_profiles` final columns. (Standing-instruction storage now decided — see Schema deltas.)

## References

- ADR-0056, ADR-0057, ADR-0058 (slice), ADR-0059 (directional significance), **ADR-0060 (standing-instructions generalization)**. Amends/builds on ADR-0017, ADR-0019, ADR-0020, ADR-0027, ADR-0031, ADR-0035, ADR-0042, ADR-0050 (D1/D2/D3), ADR-0051, ADR-0053, ADR-0055.
- [cold-start.md](../reference/cold-start.md), [triage.md](../reference/triage.md), [briefing.md](../reference/briefing.md).
