# ADR-0056 — Memory governance: autonomous-write + tiered notification + always-reversible; supersedes ADR-0019's confidence-gated HIL

**Decision.** Alfred mutates its own long-term memory **autonomously, via tool calls**, and stays trustworthy through **transparency + reversibility**, not pre-write gating. This replaces ADR-0019's posture (sub-0.85 facts blocked as `proposed` awaiting explicit accept). **Confidence stops gating the _write_ and starts gating the _notification cadence_ and the review _label_.** The boss/extractor writes; the user is **told** (tiered) and can **correct anytime**; the correction is simultaneously the authoritative contradiction signal (Loop 1) and a learning signal (Loop 2). The storage substrate (ADR-0019's `user_facts` status machine + `supersedes_id` chains + `rejected_inferences`, `entities`/`entity_relations`, `memory_chunks`, `style_profiles`) is **adopted as-is** — this ADR changes the _governance_, not the schema (modulo two additive columns).

**Knowledge taxonomy (the organizing spine).** Memory is reasoned about by _knowledge-kind_, not by table; each kind has its own capture source and lifecycle:

- **Identity** (`user_facts`, canonical keys) — onboarding + cold-start; stable, supersede on role/job change.
- **Standing instructions** (first-class; `user_preferences` + a directive notion) — say-it-in-chat + settings; persist until revoked.
- **People & relationships** (`entities` + `entity_relations`, the team graph) — onboarding + cold-start + email/calendar extraction; supersede on role change.
- **Episodic facts** (`user_facts` w/ `valid_until`) — extraction; TTL/decay (deferred → D2).
- **Style** (`style_profiles`) — sent-mail distillation; re-distilled.
- **Episodic memory** (`memory_chunks`) — thread summarization; window-pruned.

There is **no global TTL — lifecycle is per-kind.**

**Micro-decisions.**

1. **Autonomous write, no explicit-accept gate.** Facts at/above the existing floor (≥0.7; <0.7 still dropped, unchanged) are **written and live** — usable immediately. `proposed`/`confirmed` becomes a **review label** (UI emphasis + notification), not a write lock. The agent **hedges on low-confidence** facts in user-facing prose ("I think Alice is your manager — correct me if wrong"). Supersedes ADR-0019's "below 0.85 stays `proposed`, requires explicit accept."

2. **Writes go through `system.*` memory tools.** The boss mutates memory in-band via tool calls (`system.remember` / `system.update_fact` / `system.forget` / relationship-link tools — exact set in the plan). Background extraction calls the **same write functions**, so criticality classification, rationale capture, and notification fire uniformly regardless of caller. `system.*` → autonomy (ADR-0053); memory writes are reversible, so no HIL staging.

3. **Tiered, batched notification — two surfaces.** _In-app:_ `user_facts` is Replicache-synced (already carries `row_version`); changes appear **one-by-one** in a memory changelog/review surface in real time. _Email (via `notify()`, ADR-0020):_ **critical** changes batch on a **~5-min debounce** (multiples in the window collapse into one email — reuses the approval-debounce mechanism); **subtle** changes accumulate into a **digest flushed on count-threshold OR weekly, whichever fires first**. **Criticality** (principle; set tunable): identity change, key-relationship change, superseding a ≥0.85 fact, retracting a confirmed fact = critical; new low-stakes/low-confidence facts + additive aliases = subtle.

4. **Self-correction — two triggers in v1.** (i) **Write-time contradiction check** — a proposed fact is compared against existing facts on the same key/entity; on conflict it **supersedes** the prior (extends `proposeFact`/`supersedeFact`). (iii) **Behavioral/feedback** — user `confirm`/`edit`/`reject` is **authoritative and instant**. (ii) **Confidence-decay sweep** is **deferred → D2** (post-demo; needs real fact volume to tune).

5. **History is append-only — never hard-delete.** The `supersedes_id` chain + `status` (`edited | superseded | rejected`) + `valid_from`/`valid_until` preserve full chronological provenance. Retraction = a status flip + `valid_until`, never a row delete.

6. **Rejection provenance — new `cause` field.** Every fact death records _who/what_ caused it: the rejection record gains **`cause ∈ {user, write_time_contradiction, decay, superseded_by_newer}`** alongside the existing freeform `reason`. This is what lets Loop 2 separate _user corrections_ (high-value signal) from _system self-corrections_.

7. **Store the "why" — cheap-model terse rationale.** Every write persists evidence pointers (`source` jsonb, exists) **+ a rationale**: a **cheap-model ~2-sentence, telegraphic note (grammar-optional, token-frugal)** justifying the inference. This is the substrate for "justify our actions," surfaced through the **SEARCH-001** evidence layer — memory-justification and cited-outputs become **one mechanism, not two**. (ADR-0019 mandated a `source_id`; this adds the human-readable rationale, which extraction computes today but drops on write.)

8. **Loop 2 feeds the eval lane, never auto-tunes.** User corrections (especially `cause='user'`) accumulate as a **labeled misses dataset** routed to the eval lane (ADR-0055). **No prompt mutates automatically** — humans gate prompt/rubric changes (consistent with ADR-0050/0051's "principles over exemplars, tuned from logs"). `rejected_inferences` is the seed of this dataset.

**Schema delta (additive only).** `rejected_inferences.cause`, and a `rationale` on the write path (on `user_facts` or its `source` jsonb — settle during P2 implementation). No table redesign.

**What this amends / builds on.**

- **ADR-0019** — supersedes the confidence-gated HIL posture (no explicit-accept gate; `proposed` is a review label). Keeps its status machine, supersession chains, `rejected_inferences`, extraction triggers, and the memory page UX.
- **ADR-0020** — tiered/batched email rides the existing `notify()` fan-out + the approval-debounce mechanism; adds a `learned_fact` digest cadence.
- **ADR-0050 (D1/D2/D3)** — this is the build-out of the parked self-evolving-memory seeds; D2 (decay) stays deferred.
- **ADR-0055** — the eval lane is Loop 2's consumer.
- **ADR-0053** — memory write tools ride the dispatch floor + `system.*` autonomy.

**Alternatives.**

- (a) **Approve-before HIL for critical kinds.** Rejected: contradicts "Alfred has complete control," and the unattended review queue is exactly what rots today (ADR-0019's `proposed` facts with no surface). Reversibility + fast critical-notify is the lower-friction equivalent.
- (b) **Hybrid (autonomous high-confidence, approve-before low-confidence critical).** Rejected for v1 as needless complexity; hedge-on-low-confidence + 5-min critical email cover the risk. Revisit if a bad-write incident shows otherwise.
- (c) **Auto-tune prompts from corrections.** Rejected: silent self-modification of agent/classifier prompts is unsafe and unauditable; humans gate, evals measure.

**Deferred / Open.**

- **Confidence floor (0.7) + whether some surfaces exclude `proposed` facts** — tune from data.
- **Exact critical-vs-subtle set + digest count-threshold** — tune from notification-volume data.
- **Decay sweep (D2)** — post-demo.
- **The `system.*` memory write-tool surface** (names, schemas) — settle during P2 implementation in `docs/plans/long-term-memory-v1.md`.
- **Capture implementation details** — ADR-0057 locks the posture; concrete thresholds, budgets, and exact schemas tune during the phased build.
