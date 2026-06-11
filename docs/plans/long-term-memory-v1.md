# Long-term memory v1 — grounding + persistent memory foundation

Status: design locked 2026-06-11 (grill-with-docs). Decisions: **ADR-0056** (governance) + **ADR-0057** (capture + significance + chat→memory). Glossary terms in [CONTEXT.md](../../CONTEXT.md) under _Long-term memory_ + _Run grounding_. Backlog rows `GROUND-001/002/003`, `MEM-002` in [june-demo-triage.md](./june-demo-triage.md).

## Why this exists

The trigger was a demo-killer: the boss asked "how many meetings in October 2026" and replied "which year?" — it had no date. Investigation found the boss is blind on **three** channels: no ambient date, no list of connected tools, and **no access to the user-memory substrate at all** (`system.read_user_context` was specced but never registered). Meanwhile the storage layer is mature and well-built — the problem is everything *around* it: the read surface, capture quality (prod `entities` = 0), lifecycle policy, and an organizing taxonomy.

**The substrate is frozen, not redesigned.** `user_facts` (confidence·status·source·valid_from·valid_until·supersedes_id), `entities` + `entity_relations`, `memory_chunks` (pgvector), `style_profiles`, `rejected_inferences` are adopted as-is. We extend with two additive columns; no table redesign.

## The model in one screen

- **Three channels the boss perceives the world through:** **Run grounding** (ambient prompt facts: date, connected summary, standing instructions), **declared tool schemas**, **`read_user_context`** (durable memory, pull-on-demand).
- **Knowledge organized by kind, not table** (lifecycle is per-kind, no global TTL): identity · standing instructions · people & relationships · episodic facts · style · episodic memory.
- **Governance (ADR-0056):** autonomous-write + tiered-notify + always-reversible. Confidence gates *notification cadence* and the `proposed`/`confirmed` *review label*, not the write. History append-only. User correction is authoritative (Loop 1) and a training signal (Loop 2 → eval lane, no auto-tuning).
- **Capture (ADR-0057):** fully passive — integrations + significance-gated web-search enrichment, plus proactive chat→memory. No onboarding interrogation.
- **Significance score:** one computed signal over `entities`, four consumers (enrichment gate · todo D1 · triage priority · meeting-prep).

## Phases

Ordered by dependency. P0–P1 = Track 1 (the screenshot unblock, days). P2–P5 = Track 2 foundation. P6 = post-demo.

### P0 — Run grounding + recovery envelope (`GROUND-001`, `GROUND-003`)
- Recover the stranded date commits from `fix/briefing-too-long` (`c3ba3433`): `grounding.ts`, `user-timezone.ts`, `date-grounding.eval.ts`.
- Build ADR-0053's **connected summary** (never built): `slug — actions — short desc` + `(needs reauth)`, from connected ∩ allowed integrations, **snapshotted into `agent_runs.state` at run start**, concatenated by the `AlfredAgent` system resolver. No live DB reads mid-turn (cache-stable).
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
- Standing-instruction storage shape (`user_preferences` vs a sibling directive table — decide in P5).

## Open questions (settle from data/build, not now)
- Significance weights + threshold + enrichment budget.
- Confidence floor (0.7) + whether any surface excludes `proposed` facts.
- Exact critical-vs-subtle notification set + digest count-threshold.
- `person_profiles` final columns; standing-instruction storage.

## References
- ADR-0056, ADR-0057 (this design). Amends/builds on ADR-0019, ADR-0020, ADR-0031, ADR-0035, ADR-0042, ADR-0050 (D1/D2/D3), ADR-0053, ADR-0055.
- [cold-start.md](../reference/cold-start.md), [triage.md](../reference/triage.md), [briefing.md](../reference/briefing.md).
