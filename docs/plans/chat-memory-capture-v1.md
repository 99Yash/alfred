# Chat → memory capture v1 — implicit learning from conversations

Status: **design grill-locked 2026-07-04; tightened 2026-07-04**. This is the build spec for the **chat→memory** path of **ADR-0057 §4**, re-grounded on the **ADR-0067** observation-log substrate (which post-dates the original ADR-0057 plan). Builds on **ADR-0056** (autonomous-write + tiered-notify + always-reversible), **ADR-0060** (standing instructions), **ADR-0079** (#330 capture gate), **ADR-0080** (identity-fact projection). Record as an **amendment to ADR-0057** + a pilot note on **ADR-0067**, not a new ADR — the substrate already made the architectural decision.

Related: [long-term-memory-v1.md](./long-term-memory-v1.md) (P5 chat→memory), [multi-source-user-model-v1.md](./multi-source-user-model-v1.md) (the observation log), [memory-capture-hardening.md](./memory-capture-hardening.md) (#330 gate this reuses).

---

## Why this exists

The boss chat has a **read** path (`system.read_user_context`, `packages/api/src/modules/tools/system.ts:153`) but **no implicit learning**. Nothing durable is captured from a conversation unless the model explicitly calls a tool mid-turn, and the only durable user-model write reachable from chat today is the narrow sender-suppression standing instruction (`system.remember`, `system.ts:247`). No async pipeline reads finished threads into memory — `memory-extraction.ts` reads `documents` only, and its own header defers chat extraction ("End-of-thread / event-triggered (ADR-0019) wire in once chats … exist (m9+)", `apps/server/src/builtins/workflows/memory-extraction.ts:45`).

**Evidence (prod thread `61943b8b`, "DVD's Role At Oliv", 2026-07-03).** Over 4 turns the user established, and Alfred confirmed: dvd = Venkata Deepankar Duvvuru, **co-founder of Oliv** (ex-Rocket Fuel); Ishan Chhabra = CEO; and — after the user corrected it — **"Oliv is not ~6 people."** None of it was captured. The next session re-derives from scratch and can repeat the "6 people" error. That is the gap this closes.

## The model in one screen

```
                     ┌─ user says it            → source=user / alfred_chat   (rank 0/1, authoritative)
 chat transcript ──▶ ├─ Alfred infers (web)     → source=enrichment          (rank 3, provisional → decays)
 (idle-debounced)    └─ Alfred confirms (integ.) → deterministic check         (no tokens)
        │
        ▼  end-of-thread extractor (cheap model)  — CRISP propositions only
   [ observations ]  append-only system of record (insertObservation HARD GATE, ADR-0067 P1)
        │              kinds: user_correction | user_confirmation | user_rejection | enrichment_fact
        ▼  fact projection (chat = pilot)          — verification + source-rank precedence + decay
   [ user_facts ]  (subject=user, via proposeFact, #330 gate; source.kind=agent + chat provenance) ─┐
   [ entities.metadata ] (subject=entity, e.g. "dvd: co-founder"; row_version bump)                  ─┴─▶ read_user_context (UNCHANGED)
        │
        ▼  review surface (FACT sync + live /memory wiring + new chat-shell entry point)
   proposed = visible to YOU, invisible to the boss   ·   confirmed = readable by the boss
   3-day TTL = corroborate-or-expire projected row (soft, never delete observations) · diffuse signal = deterministic projection, never extracted
```

---

## Resolved decisions (the grill)

**D1 — Both mechanisms; end-of-thread (A) first, in-band tool (B) second.** A is the *implicit* path the user is asking for and it **structurally owns the correction case** — a fresh extractor reading the closed thread sees "user asserted X, contradicting Alfred's claim Y"; the in-band model that was just wrong won't volunteer its own correction. B (generalize `system.remember` beyond suppression, with the timed-toast auto-commit UX) is slice 2. Both are wanted long-term.

**D2 — Reuse the existing `proposed`/`confirmed` status machine; do not invent a parallel one.** `read_user_context` reads `status='confirmed'` only (`user-context.ts:327`), while Replicache syncs `status IN ('proposed','confirmed')` (`replicache/entities.ts:195`). So **a `proposed` fact is visible to the user for review but invisible to the boss**. Confirmed = readable. Caveat: current FACT sync does not filter `valid_until`, so expiry must either move the row out of the synced status set or tighten the sync query in the same slice.

**D3 — 3-day TTL = expire, not auto-commit; and expiry is projection-only.** An uncorroborated **inferred** (`enrichment`-rank) `proposed` fact that accrues no supporting evidence within 3 days leaves the review/read surfaces by updating the projected row to an inactive existing status (`superseded` in v1) plus `valid_until=now` and a lifecycle reason. Do **not** write `rejected_inferences`; user rejection and passive expiry are different. The append-only observation row stays, so a later corroboration can project a fresh row without losing audit history. TTL never auto-downgrades user/`alfred_chat` corrections.

**D4 — Decay is conditioned on the fact's epistemic character, not on authorship.** (The user rejected blanket "user-asserted = exempt": headcount is volatile — layoffs could make "Oliv > 6" false, which the user can't anticipate; and some user assertions should be verified if cheaply possible.) Two orthogonal axes per proposition:
- **Verification route** — `self_evident` (no source needed) · `integration_checkable` (Alfred confirms against connected data, no user needed) · `external_checkable` (needs web/authoritative outside source) · `user_only` (subjective/private, only the user attests).
- **Volatility** — `stable` (name, co-founder-of) · `volatile` (headcount, title, current company) → carries `valid_until` + re-verification, using the existing `user_facts` bi-temporal columns.

Conflict **precedence is already law in the contract**: `OBSERVATION_SOURCE_RANK` = `user:0 > alfred_chat:1 > integrations:2 > enrichment:3`, with "a projection may propose facts from integrations, but must never overwrite a user-authoritative correction" (`packages/contracts/src/user-model.ts:61`).

**D5 — Verification is *active* and hybrid, budget-gated, deterministic-first.** Mirrors ADR-0057's significance-gated, budget-capped web enrichment. Active-verify the cheap-and-authoritative (`integration_checkable`, via **deterministic SQL/API — zero tokens**) and *significant* `external_checkable` facts (one `web_search`); passive-hold the long tail; `user_only` trusted-with-validity-window plus a light deterministic sanity-check when one is cheaply available. The verification outcome sets confidence + `valid_until`.

**D6 — Extract CRISP propositions only; diffuse/countable signal is a deterministic projection, never LLM-articulated.** The boss must **never** articulate "Oliv has ~12 people." That truth is `COUNT(DISTINCT sender@oliv.ai)` over ingested mail — free, exact, no tokens — i.e. an observation-log aggregate. Crisp, nameable, checkable claims (dvd is a co-founder; his name is Venkata; I prefer morning standups) get extracted; diffuse signal (headcount, who-you-talk-to-most, activity level, org membership) is computed on demand. Fuzzy/aggregate *extraction* deferred.

**D7 — Substrate = the ADR-0067 observation log (contract already models chat).** Sources already include `alfred_chat` + `user`; kinds already include `user_correction` / `user_confirmation` / `user_rejection` / `user_standing_instruction` / `enrichment_fact` (`user-model.ts:37,87`). `alfred_chat` and `user` share the full user-authored kind set ("the same correction/confirmation can arrive from a /settings edit or from chat"). Chat capture writes observations through the `insertObservation` P1 hard gate (`packages/api/src/modules/user-model/observations.ts:87`).

**D8 — Build the fact projection now, with chat as its pilot; project into today's read surface (A1).** There is no fact projection yet (the Gmail reducer projects `entity_profiles`/significance, not propositions). Build it, chat-first. **A1:** `subject=user` facts → `user_facts` via `proposeFact` (canonicalized through #330's keys, gate applies); `subject=entity` facts (dvd co-founder) → the entity's readable record (`entities.metadata`, what `read_user_context` reads). Use the existing `MemorySource` schema for projected rows: `source.kind="agent"`, `source.id=<runId>`, and `source.meta={workflow:"chat-memory-capture", threadId, observationIds, observationSources, verificationClass, volatility, rationale}`. Do not add `source.kind="projection"` in v1. The boss read path is **untouched**. The observation log remains the system of record (provenance, precedence, decay all live there). Unifying `read_user_context` onto `entity_profiles` and retiring the legacy graph stays the separate ADR-0067 P4/P5 migration. **Relation-edges (dvd founded Oliv) deferred — v1 = attribute facts only.**

**D9 — Trigger = idle debounce (~10–15 min after the last message).** Each new message pushes the timer out (delayed BullMQ job with a per-thread replace key, reusing the `memory.extract` pattern). It sees the *whole* conversation, so the correction arc resolves *before* extraction runs — you capture the final state, never the mid-thread wrong turn. One cheap pass per thread; v1 reads role + content only (tool-call details out).

**D10 — Notification: two surfaces matched to presence.** The async A path writes low/med to `proposed` **silently**; they wait in a durable, Replicache-synced review surface. FACT sync and mutators exist, but `/memory` is currently fixture/local-state UI, so v1 includes wiring `/memory` to Replicache subscribe + `factConfirm`/`factReject`/`factEdit` and adding a **new chat-shell top-right entry point** (global not per-thread, grouped by source thread, showing commit time). The **timed-toast auto-commit** UX (write on non-objection after a short countdown) belongs to the **in-band B** path where presence is guaranteed — slice 2. High-confidence / authoritative writes skip `proposed` → `confirmed` only when source precedence and verification allow it; confidence alone is not enough for volatile/external facts.

**D11 — Supersede authority + auto-confirm come from the observation source-rank, NOT the projected fact's writer tag.** (Closes a collision that D8/fix-#3 + fix-#4 otherwise create.) `proposeFact` today derives both from the *written row*: `userDriven = source.kind === "user"` (`facts.ts:178`) is the only thing that gates single-valued supersession (`:229` `heldByConflict = conflict && !userDriven`; `:234` the retire-and-supersede branch), and `confidence ≥ AUTO_CONFIRM_THRESHOLD` alone flips status to `confirmed` (`:175`). With chat facts tagged `source.kind="agent"` (D8), a **user in-chat correction would be treated as autonomous → held `proposed` → the stale `confirmed` value keeps winning and stays the only thing the boss reads** — silently reintroducing the evaporating-correction bug this plan exists to kill. Resolution, mirroring the identity-affiliation projection (`identity-affiliation.ts:341` — "authority is read from rank, NOT the flat `source.kind` writer tag"): the projection derives an **explicit `authority` signal from the contributing observation's `OBSERVATION_SOURCE_RANK`** (`user`/`alfred_chat` → authoritative-supersede; `enrichment` → provisional-hold) and an **explicit `status`/`autoConfirm=false`** control, passing both to the write path. `source.kind` stays the pure `"agent"` writer tag. **Confidence alone never confirms a volatile/external fact** — the projection sets status from authority × verification outcome, not from the model's confidence number. Impl choice (open): extend `proposeFact`'s signature with `authority`/explicit-status, or give the projection its own supersession path that calls `proposeFact` only for additive, non-conflicting writes.

---

## Lifecycle mapping (mostly existing columns — not a new schema)

| User-requested field | Existing home |
|---|---|
| `active` | `user_facts.status = 'confirmed'` + (`valid_until` null or future) |
| review-visible proposal | `user_facts.status = 'proposed'` + (`valid_until` null or future); enforce this in FACT sync or by moving expired rows to an inactive status |
| `expired_at` | `user_facts.valid_until`; expired uncorroborated proposals leave `proposed`/`confirmed` (`superseded` v1, no `rejected_inferences`) |
| `overridden_at` | `supersedes_id` (pointer) + `updated_at` (when) |
| `reason` | v1: `source.meta.lifecycleReason` / projection metadata; later: first-class string if expiry/override queries need it indexed |
| source integration | observation `source`; a projected fact's provenance = **union of contributing observations' sources** (multi-source corroboration is derivable) |

---

## v1 vertical slice (smallest end-to-end proof of the loop)

1. **Trigger** — idle-debounce BullMQ job per thread (D9), reuse `memory.extract` infra.
2. **Extractor** — cheap-model pass over the transcript → crisp propositions, each tagged `{subject: user|entity, key, value, verificationClass, volatility, attribution, confidence, rationale}` (D4/D6).
3. **Write observations** — via `insertObservation`: user assertions → `user`/`alfred_chat` + `user_correction`/`user_confirmation`; web-inferred → `enrichment` + `enrichment_fact` (D7).
4. **Verify (hybrid, deterministic-first, budget-capped)** — `integration_checkable` → SQL/API check; significant `external_checkable` → one `web_search`; `user_only` → trust + `valid_until`; skip the tail (D5).
5. **Project (chat pilot)** — `subject=user` → `user_facts` via `proposeFact` (#330, `source.kind="agent"` + chat provenance); `subject=entity` → `entities.metadata` with a row-version bump. **Authority from observation source-rank, not the writer tag (D11):** `user`/`alfred_chat` corrections carry authoritative-supersede + may promote to `confirmed`; `enrichment_fact` is provisional → `proposed`. Status is set from authority × verification, never from confidence alone.
6. **Decay sweep** — piggyback the daily memory cron: `enrichment`-rank `proposed` facts older than 3d with no corroborating observation family → `status='superseded'`, `valid_until=now`, lifecycle reason, no `rejected_inferences` (D3).
7. **Review UI** — wire `/memory` to real FACT Replicache data + mutators; add the chat-shell entry point (D10).
8. **Read** — unchanged (`read_user_context`).

**Acceptance test (re-run the dvd thread):** after the thread idles, the boss's *next* session, on "what do we know about dvd", surfaces "co-founder of Oliv" from memory without re-searching; and "Oliv is ~6 people" is never asserted (the count-projection or the captured correction refutes it).

### Deferred (explicitly out of v1)
- In-band tool B (generalized `system.remember` + timed-toast auto-commit) — slice 2.
- Relation-edge facts; fuzzy/aggregate *extraction*.
- Migrating `read_user_context` onto `entity_profiles` / retiring the legacy graph (ADR-0067 P4/P5).
- Non-chat sources (their own reducers) and the doc-extractor's migration onto the log.

---

## Open questions (settle from build/data, not now)
- Idle-debounce window (10 vs 15 min) + max transcript size fed to the extractor.
- Verification budget ceiling per thread (tokens + tool calls); which `integration_checkable` predicates get a deterministic checker in v1.
- Corroboration threshold for reviving/keeping an `enrichment` proposal (reuse `PROMOTION_THRESHOLD`/`MIN_FAMILIES`?).
- Expiry implementation: tighten FACT sync to filter inactive validity windows, or rely on moving expired rows out of `proposed`/`confirmed` only.
- D11 mechanism: extend `proposeFact` with an explicit `authority`/`status` control, or give the projection its own supersession path (proposeFact only for additive writes)? Either way `source.kind` stays `"agent"` and authority is read from `OBSERVATION_SOURCE_RANK`.
- Does the chat-shell entry point warrant its own component, or extend the `/memory` route with a `?source=chat` filter/grouping?

## References
- Substrate contract: `packages/contracts/src/user-model.ts` (sources/kinds/rank/`FACT_SUBJECT_KINDS`/`FACT_ONTOLOGY`).
- Write gate: `packages/api/src/modules/user-model/observations.ts:87`.
- Read surface: `packages/api/src/modules/memory/user-context.ts` · tool `packages/api/src/modules/tools/system.ts:153`.
- #330 fact gate: `packages/api/src/modules/memory/fact-policy.ts`, `proposeFact`.
- Doc extractor to mirror: `apps/server/src/builtins/workflows/memory-extraction.ts`.
- Review UI: `apps/web/src/routes/memory.tsx`, `-memory/proposed-fact-card.tsx`, `packages/sync/src/mutators/facts.ts`.
