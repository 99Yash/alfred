# Long-term memory v1 — grounding + persistent memory foundation

Status: design locked 2026-06-11 (grill-with-docs); **vertical slice 1 locked 2026-06-15** (grill-with-docs). Decisions: **ADR-0056** (governance) + **ADR-0057** (capture + significance + chat→memory) + **ADR-0058** (store: Postgres over a graph DB; build the intelligence, don't buy the store). Glossary terms in [CONTEXT.md](../../CONTEXT.md) under _Long-term memory_ + _Run grounding_ (incl. _Suppression standing instruction_, _Resolve-at-write_, _Recurrence-decay_). Backlog rows `GROUND-001/002/003`, `MEM-002` in [june-demo-triage.md](./june-demo-triage.md).

## Why this exists

The trigger was a demo-killer: the boss asked "how many meetings in October 2026" and replied "which year?" — it had no date. Investigation found the boss is blind on **three** channels: no ambient date, no list of connected tools, and **no access to the user-memory substrate at all** (`system.read_user_context` was specced but never registered). Meanwhile the storage layer is mature and well-built — the problem is everything *around* it: the read surface, capture quality (prod `entities` = 0), lifecycle policy, and an organizing taxonomy.

**The substrate is frozen, not redesigned.** `user_facts` (confidence·status·source·valid_from·valid_until·supersedes_id), `entities` + `entity_relations`, `memory_chunks` (pgvector), `style_profiles`, `rejected_inferences` are adopted as-is. We extend with two additive columns; no table redesign.

## The model in one screen

- **Three channels the boss perceives the world through:** **Run grounding** (ambient prompt facts: date, connected summary, standing instructions), **declared tool schemas**, **`read_user_context`** (durable memory, pull-on-demand).
- **Knowledge organized by kind, not table** (lifecycle is per-kind, no global TTL): identity · standing instructions · people & relationships · episodic facts · style · episodic memory.
- **Governance (ADR-0056):** autonomous-write + tiered-notify + always-reversible. Confidence gates *notification cadence* and the `proposed`/`confirmed` *review label*, not the write. History append-only. User correction is authoritative (Loop 1) and a training signal (Loop 2 → eval lane, no auto-tuning).
- **Capture (ADR-0057):** fully passive — integrations + significance-gated web-search enrichment, plus proactive chat→memory. No onboarding interrogation.
- **Significance score:** one computed signal over `entities`, four consumers (enrichment gate · todo D1 · triage priority · meeting-prep).

## Vertical slice 1 — the suppression loop (the "Ben Book" slice)

The horizontal P0–P6 below builds the whole foundation. **This slice is the thin vertical cut that closes one real prod loop end-to-end** and proves the architecture on the way. It touches P0 (grounding), P1 (read surface), P2 (write tools), and P5 (chat→memory) on the narrowest path — *not* P3/P4 (significance, team graph), which the loop doesn't need.

### The incident it closes (prod, 2026-06-13)

User told Alfred in chat: *"can you stop emailing me about replying to ben book. i don't want it. that was spam."* It didn't stop. The next briefing (evening, 18:55Z — **after** the chat and after the user manually dismissed the todo) still **led** with Ben Book. "Ben Book" = `ben@anyipswift.com`, a **cold sales email** about the user's repo. Four independent breakages, each sufficient alone:

| # | Failure | This slice |
|---|---------|-----------|
| A | Cold sales email escalated to `awaiting_reply` (triage root miss) | **Out of slice** — a sender-prior/rubric improvement; the suppression is the user's *override on top*, not a substitute |
| B | Briefing escalated by **persistence** ("survived every briefing") | **In** — recurrence-decay principle |
| C | Boss had **no resolve/dismiss tool**; said "I marked it resolved" but only called `suggest_todo` (kept the todo alive) | **In** — `system.resolve_todo` |
| D | **Nothing** captured "stop / that's spam"; triage + briefing read no user signal | **In** — the suppression standing instruction + the non-boss read path |

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
- **Sender-scoped, cross-account by default** (`target.accountId: null`) — the user is suppressing *the sender*, not one mailbox instance; the field exists so a future per-account scope is expressible without a reshape. **Persist-until-revoked** (`valid_until=null`; a later "surface Ben again" supersedes). Topic-scope (fuzzy → prompt-inject) and time-boxed snooze (`valid_until`=grounded-now+window) are deferred variants of the same shape.
- **Resolve-at-write:** consumers match on `target.email` (lowercased) / read `directive`; **never parse `phrasing`**. See CONTEXT _Resolve-at-write_.

### Capture path (chat → memory)

Boss recognizes durable intent ("stop", "that's spam", "I don't want it" → durable; "ignore that for now" → run-scoped ADR-0035 directive, dies with the run) and performs **two** writes — the incident needed both and had neither:

1. **`system.remember`** — writes the row above under ADR-0056 governance.
2. **`system.resolve_todo`** — closes the live loop. **Source/sender-based resolution, not just `todoId`** (the boss usually doesn't know the id): input accepts `{ todoId? | senderEmail? | source? }`, mirrors `suggest_todo`'s source-overlap matching, and returns `ambiguous` + candidates when >1 matches (boss disambiguates rather than guessing). Uses **`dismissed`** for spam/suppression — *not* `done` (`done` implies completed and trips the 7-day done-sync/Gmail-label window per `todos.ts`). The missing tool behind failure C.

**Canonical resolution is a precondition of the write:** the boss resolves `"ben book"` → `ben@anyipswift.com` from the open thread; if it can't resolve confidently, it asks a one-line clarifying question rather than guessing (the antidote to the original "searched ben book, found its own reminder emails" confusion).

### Enforcement path (the part that makes it *stop*) — defense-in-depth

**One reader, not two ad-hoc JSON checks.** A single shared helper owns the zod parse, `proposed|confirmed` status filter, `valid_until` filter, and lowercased-email matching — `listActiveSuppressionInstructions(userId)` + `isSenderSuppressed(userId, senderEmail)`. Triage and briefing both call it; the `value` JSON is never hand-inspected at a call site. This is the concrete realization of the "non-boss read path."

An **orthogonal suppression check** (NOT a category bend — category stays the honest classification), in **both** consuming surfaces, because "a fix in triage is not a fix everywhere":

- **Triage `classify.ts`** — `isSenderSuppressed` as one more deterministic sender signal; on hit (effect `block_todo_suggestion`) → **block the `todoSuggestion`** (hard veto, no flash-lite relitigation). **Audit breadcrumb:** log `suppressedByInstruction: { factId, target }` alongside the existing `triage.sender_extraction` trace, so a future debugger doesn't see "model proposed → nothing minted" with no reason.
- **Briefing `gather`** (`gatherBriefingDigest`, `briefing/gather.ts`) — filter the priority-bucket rows through the same reader (effect `exclude_briefing_priority`) before compose. (This is the gap that let the 18:55 briefing still lead with Ben after the todo was dismissed — gather read no user signal.) **Audit breadcrumb:** log dropped count + fact ids.
- **Briefing prompt (failure B) — generalize, don't bolt on.** The prompt already has a stale-repeat rule scoped to PRs ("Don't re-surface stale PRs", `briefing/prompt.ts`). **Generalize that paragraph** into the **recurrence-decay** principle — *un-acted-upon recurrence decays salience, never escalates it* — covering any recurring item, not just PRs. Make it an **eval-backed prompt change** (ADR-0055 lane), **not a build blocker** for the slice: the deterministic suppression check above is what actually closes the loop; recurrence-decay is the defense-in-depth that stops *un-suppressed* items from self-escalating.

The boss's `system.resolve_todo` closes the live todo, so we **don't** need a forced re-triage of stale rows to close this loop (correcting the Gmail label is a deferred nice-to-have).

### Time grounding — a hard prerequisite

The whole failure class is **relative-time reasoning** ("days overdue", "since Monday", "another night"). **GROUND-001 (P0) is a prerequisite of this slice**, not a parallel effort. Split:
- **Reasoning** ("is this overdue?") → today's date + `IanaTimezone` ambient in **Run grounding** (recover `grounding.ts`/`user-timezone.ts`/`date-grounding.eval.ts` from `fix/briefing-too-long` `c3ba3433`).
- **Rendering** ("show *June 26*, not *tomorrow*") → resolve relative→absolute in the deterministic gather/compose layer; instruct the prompt to render absolute dates.
- **No bash/`date` tool on the boss** — breaks cache-stable Run grounding, returns the *server's* UTC clock (not the user's tz — the historical briefing bug), and is wildly overscoped. The fact's own temporal fields (`valid_from=now`, any `valid_until`) are stamped server-side **at insert**, never asked of the model later.

### Honest chat copy (product)

"Stop emailing me" *sounds* like a request to mutate the mailbox (a Gmail filter). This slice does **not** touch Gmail — it stops Alfred's *own* surfacing. So the boss's reply must be explicit and reversible:

> "I'll stop surfacing reminders and briefing items about Ben Book. The emails will still arrive in Gmail unless you'd like me to create a filter."

This keeps the slice honest (no implied mailbox mutation) and leaves "create a Gmail filter" as a separate, explicit action for later.

### Notification

- **In-app: the row is Replicache-visible and revocable through the existing memory mutation path.** A `standing_instruction` is a `user_facts` row with `status ∈ {proposed, confirmed}`, so it syncs to the client today via the `FACT` fetcher — no new sync work. A *polished* changelog/revoke UX is a **separate surface, not in this slice**.
- **Revocation mechanism (explicit, in-slice):** reversal = **reject the fact** via the existing reject mutation → `status='rejected'` + `cause='user'` (ADR-0056). The shared reader filters to `proposed|confirmed`, so a rejected instruction is **inert by construction** — no separate "disable" flag. (A *positive* "always surface Ben" allow-rule — a superseding standing instruction — is a deferred variant, not how v1 reversal works.) The implementation task is: *the reject path must be reachable for a `standing_instruction` row and the reader must exclude rejected rows* — both already true, so this is a verification task, not new code.
- **Email notification: skipped for a user-initiated, same-session write** — the user just said it in chat; don't email to confirm what they witnessed. Refines ADR-0056 tiering: *notification informs the user of things they didn't already witness.* The critical email tier still governs background/passive writes.

### Acceptance test (the demo)

1. In chat, "stop emailing me about replying to Ben Book" → boss resolves the sender, replies with the honest copy above, calls `system.remember` (row syncs to the client) **and** `system.resolve_todo` (the live todo flips to `dismissed`).
2. A new email from `ben@anyipswift.com` → triage classifies honestly **but mints no todo** (breadcrumb logged).
3. The **next briefing does not lead with — or mention — Ben Book**, even though it recurred in prior briefings.
4. **Reject** the `standing_instruction` fact ("surface Ben again") → `status='rejected'` → the shared reader (filtering `proposed|confirmed`) no longer matches → Ben can surface again.

### Slice scope boundary

**In:** date+tz grounding recovery (GROUND-001); `system.remember` + source-resolving `system.resolve_todo`; the suppression row + the single shared reader + the dual-surface check + audit breadcrumbs; the honest chat copy; recurrence-decay **as an eval-backed prompt generalization** (defense-in-depth, not the load-bearing fix). **Out (deferred):** failure A (cold-outreach mis-classification — sender-prior/rubric); topic-scoped suppression; time-boxed snooze; a polished memory changelog/revoke UI (rely on the existing `factEdit`/reject mutation in-slice); eager connected tool declaration + dispatch floor (rest of P0); Gmail-filter creation (real mailbox mutation — a separate explicit action); confidence-decay sweep (D2); forced re-triage of stale rows; the significance score + team graph (P3/P4).

## Phases

Ordered by dependency. P0–P1 = Track 1 (the screenshot unblock, days). P2–P5 = Track 2 foundation. P6 = post-demo. **Vertical slice 1 (above) cuts across P0/P1/P2/P5** — build it as the first end-to-end thread, then generalize into the full phases.

### P0 — Run grounding + recovery envelope (`GROUND-001`, `GROUND-003`)
- Recover the stranded date commits from `fix/briefing-too-long` (`c3ba3433`): `grounding.ts`, `user-timezone.ts`, `date-grounding.eval.ts`.
- **Connected summary already exists** (`agent/connected-summary.ts`, ADR-0053) — snapshotted into `agent_runs.state` at run start and injected into the boss/chat prompt. The **remaining** P0 work is eager connected *tool declaration* + the dispatch floor (chat still initializes `activeIntegrations: []` and lazy-loads — `chat-turn.ts`). **For the suppression slice this is mostly deferrable:** the slice adds always-on `system.*` tools, which don't ride `allowed_integrations`/lazy-load; the slice's real P0 dependency is the **date + tz grounding recovery** above, not the tool-declaration work.
- Inject date + connected summary into **both** boss and chat prompts as one run-start snapshot.
- Recovery envelope (`dispatch/index.ts`): an unknown action on an allowed+connected integration returns that integration's **real action list**; `integrationActionSuggestion` handles qualified names (today bails on any `.`).
- **Accept:** date eval passes + a connected-summary assertion; inventing `github.list_pull_requests` returns "github exposes: `search_pull_requests`…".

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

### P3 — Significance score (ADR-0057, builds ADR-0050 D1)
- Computed signal over `entities`: frequency + recency + reply-reciprocity + same-org-domain + explicit relation edges. Start simple; weights tunable.
- Expose as the shared primitive consumed by the P4 enrichment gate, todo significance (D1), triage priority, meeting-prep.
- **Accept:** one query returns ranked significant people; todo/triage/meeting-prep read it instead of local heuristics.

### P4 — Passive capture + web enrichment (ADR-0057; MEM-001)
- Extend extraction to build the **team graph** from Gmail/Calendar (attendees, senders, recurring threads) → `entities` + `entity_relations`.
- Build **`person_profiles`** (ADR-0042, unbuilt) with `identity_confidence`-tier TTL.
- Significance-gated, budget-capped **web-search dossier** enrichment (Perplexity Sonar, cold-start tooling) for above-threshold entities; corroboration raises confidence.
- First-run "still learning about you" state (steal dimension's live-progress pattern).
- **Accept:** prod `entities` is no longer 0; the boss can name the user's top collaborators with roles + citations.

### P5 — chat→memory (ADR-0057)
- In-band proactive `system.remember` on durable intent; end-of-thread extraction (ADR-0019 trigger) for passing statements.
- Durable-vs-run-scoped classifier ("from now on" → persist; "for this conversation" → ADR-0035 `user_directives`).
- Standing instructions persisted + injected into **Run grounding** (ambient).
- **Accept:** "from now on ignore Dependabot" persists, notifies (critical), and biases later triage; "just for now…" does not persist.

### P6 — Post-demo
- Confidence-decay sweep (ADR-0050 **D2**).
- Loop-2 misses dataset → eval lane (ADR-0055) wiring; no auto-tuning.
- Hybrid retrieval: Postgres tsvector FTS + pgvector fused (RRF) — no new infra; better recall for names/IDs. (Not turbopuffer.)

## Schema deltas (additive only)
- `rejected_inferences.cause` (+ cause on the superseded `user_facts` row's `source` or a sibling).
- `rationale` on the memory write path (`user_facts` column or its `source` jsonb — decide in P2).
- `person_profiles` table (P4; extends the ADR-0042 spec).
- Standing-instruction storage shape — **decided (slice 1):** a `user_facts` row, `key="standing_instruction"`, structured `value` (see slice); no new table, no migration (JSONB `value`). Chosen over `user_preferences` for `supersedes_id` + `status` + `valid_until` + the Replicache changelog `row_version`.

## Open questions (settle from data/build, not now)
- Significance weights + threshold + enrichment budget.
- Confidence floor (0.7) + whether any surface excludes `proposed` facts.
- Exact critical-vs-subtle notification set + digest count-threshold.
- `person_profiles` final columns. (Standing-instruction storage now decided — see Schema deltas.)

## References
- ADR-0056, ADR-0057 (this design). Amends/builds on ADR-0019, ADR-0020, ADR-0031, ADR-0035, ADR-0042, ADR-0050 (D1/D2/D3), ADR-0053, ADR-0055.
- [cold-start.md](../reference/cold-start.md), [triage.md](../reference/triage.md), [briefing.md](../reference/briefing.md).
