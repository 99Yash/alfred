# ADR-0057 — Passive memory capture + the significance-score primitive + chat→memory write path

**Decision.** Memory **capture is fully passive**. The team graph + identity facts are inferred from integration signal (Gmail/Calendar) and **enriched/corroborated via web search**, written autonomously under ADR-0056, kept fresh by continuous extraction + Loop-1 supersession — **no active onboarding interrogation, no prompted confirmation card**. Web-search enrichment is gated by a new first-class **significance score** over `entities`, which is _also_ the single source for todo personal-relevance (ADR-0050 **D1**), triage sender priority, and meeting-prep attendee prioritization. Direct user statements become durable memory through a two-path **chat→memory** write, with a durable-vs-run-scoped intent split. Companion to ADR-0056; the two together are the long-term-memory foundation. Build sequence + file detail in [docs/plans/long-term-memory-v1.md](../plans/long-term-memory-v1.md).

**Micro-decisions.**

1. **Pure passive capture.** Onboarding stays minimal (connect only). The team graph + identity facts are inferred post-connect; correction is **unprompted** via the ADR-0056 review surface. No re-interrogation when teams change — the change surfaces in an integration and Loop-1 supersession catches it. First run shows a "still learning about you" state until ingestion + extraction land.

2. **Web-search enrichment, significance-gated + budget-capped.** Only entities **above a significance threshold** get a web-search dossier → a `person_profile` (builds ADR-0042's specced-but-unbuilt table); the long tail stays name + email. Web search both **enriches** (role, company) and **corroborates** a passively-inferred fact — corroboration raises confidence, feeding ADR-0056's confidence→notification tier. Reuses cold-start's Perplexity Sonar tooling + per-run cost ceiling (ADR-0011/0022, attachment-budget pattern).

3. **Significance score = first-class shared primitive.** A computed signal over `entities` (person/org): correspondence frequency + recency + reply-reciprocity + same-org-domain + explicit relationship edges. **One source, four consumers** — the enrichment gate, ADR-0050 **D1** todo significance, triage sender priority, meeting-prep attendee prioritization. Replaces four drifting "who matters" heuristics. This is the concrete build-out of the parked D1.

4. **chat→memory write path — two paths + an intent split.** (i) **In-band proactive:** the boss recognizes durable intent mid-conversation (not just literal "remember") and calls `system.remember`. (ii) **End-of-thread extraction** (ADR-0019's existing trigger) mines the closed thread for durable facts/prefs stated in passing. Capture is **proactive** (low write bar) because ADR-0056 reversibility + critical-tier notification make over-capture cheap to undo and under-capture the worse failure for an assistant. **Durable vs run-scoped split:** "for the rest of this conversation" → run-scoped directive (ADR-0035 `user_directives`, dies with the run); "from now on" → durable standing instruction (persisted). Only durable hits long-term memory.

5. **Standing instructions are a first-class knowledge-kind**, persisted (`user_preferences` + a directive notion — shape settled in the plan), and **ambient via Run grounding** (they bias every turn; relevance-filter if the set grows large).

**What this amends / builds on.**

- **ADR-0031** — supersedes "review before durable memory writes" for person dossiers (now autonomous + reversible per ADR-0056); keeps citation-grounding + the confidence-tier TTL cache.
- **ADR-0042** — **builds** `person_profiles` (the dossier cache, currently unbuilt); the `identity_confidence`-tier TTL stays.
- **ADR-0011 / ADR-0022** — extends cold-start web research from the user to the user's _significant people_, same tooling + budget posture.
- **ADR-0050 D1** — the significance score **is** the deferred personal-relevance primitive.
- **ADR-0056** — every write rides that governance; web-corroboration feeds confidence→notification.
- **ADR-0019 / ADR-0035** — chat→memory reuses end-of-thread extraction; the durable-vs-run-scoped directive split.

**Alternatives.**

- (a) **Active onboarding interrogation.** Rejected: friction on a sub-minute flow, half-filled forms, and teams change anyway (integrations re-capture).
- (b) **Confirm-card hybrid.** Rejected: prompted confirmation is friction; ADR-0056 reversibility + the review surface make _unprompted_ safe.
- (c) **Web-enrich every contact.** Rejected: cost/latency; significance gate + budget cap instead.
- (d) **Per-feature "who matters" heuristics.** Rejected: four drifting copies; one shared significance score.
- (e) **Conservative chat capture (explicit "remember" only).** Rejected: under-capture is the worse failure for an assistant; reversibility makes proactive capture safe.

**Deferred / Open.**

- Significance score exact inputs/weights + threshold + enrichment budget — tune from data.
- `person_profiles` schema finalization (extends the ADR-0042 spec).
- Storage shape for standing instructions (`user_preferences` vs a sibling directive table) — settle during P5 implementation.
- First-run "still learning" UX.
- Confidence-decay sweep (D2) — still deferred (post-demo).
