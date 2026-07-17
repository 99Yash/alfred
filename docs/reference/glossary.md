# Glossary

Domain terms used across Alfred's design. New terms land here as ADRs/grills mint them. One definition each; link to the ADR that owns the decision.

## Memory & user-model

- **Object-state memory** — A deterministic projection of the *lifecycle state* of external work objects (GitHub PRs, ClickUp tasks, Claude Code runs). The structured, exact-keyed, reducer-computed sibling of semantic user-memory. Lives on Postgres; no vector/LLM in its closure path. (ADR-0062)
- **Semantic user-memory** — LLM-proposed, confidence-gated, vector-recalled knowledge *about the user* (`user_facts`, `entities`, `memory_chunks`). The fuzzy half. (ADR-0056/0057)
- **Integration object** — One external work object tracked in object-state memory, identified by `(user_id, provider, kind, external_id)`. (ADR-0062)
- **`state_category`** — The normalized lifecycle bucket every provider's native state maps into: `active | resolved | failed | abandoned`. Provider-agnostic consumers read this; native state is retained for display. (ADR-0062)
- **Native state** — A provider's own state string (`open`/`merged`/`closed`, `in_progress`/`done`, …), retained on the object row for fidelity + audit alongside the normalized `state_category`. (ADR-0062)
- **Key sidecar / key-resolution** — `integration_object_keys`: a `(provider, key_kind, key_value) → object_id` table so heterogeneous identities (`head_sha`, `run_id`, `task_id`) all resolve to an object uniformly. Raw branch names are repo-scoped, so they are not a v1 key. (ADR-0062)
- **Reducer** — A per-provider, pure, idempotent, replayable function `applyEvent(provider, event)` that folds webhook/event deliveries into object-state. The irreducibly per-provider part — there is no generic reducer. (ADR-0062)
- **Awareness layer** — Informal name for object-state memory: the maintained, durable view of "what's happening across my integrations" that the prod recon proved a gather-time recompute can't provide. (ADR-0062)

## Invariants & contracts

- **Propose / dispose** — The boundary that keeps extraction safe: the LLM/boss *proposes* candidate keys + work-signals (fallible); the deterministic reducer *disposes* authoritative object state. A hallucinated key resolves to nothing — it can't fake a state. (ADR-0062/0063)
- **Absence never closes** — A loop closes only on a *positive* terminal signal (e.g. PR `merged`); a missing signal (no webhook, unknown key, API gap) leaves the loop **live**, never inferred-closed. The ADR-0048 source-availability contract; pinned by a contract test. (ADR-0048-D, ADR-0062)
- **Demote, never bury** — Across the user-model epic: a false "needs you" is recoverable noise; a false "doesn't need you" is near-fatal. Ranking demotes; it never re-stamps an immutable triage category or silently drops. (epic #218)

## Pipeline & surfaces

- **Agent output purpose** — A required, closed classification of model-authored output: `assistant_response`, `audience_content`, `source_faithful`, or `internal`. The purpose selects presentation defaults without making low-level model and metering APIs aware of Alfred's product voice.
- **Voice policy** — The typed `default | none` presentation choice derived from an agent output purpose, with an explicit override for exceptional calls. Custom personas and audience guidance remain in validated request context rather than being promoted into a generic system-prompt constructor.
- **Mechanical voice sanitization** — Field-aware deterministic cleanup applied at an owning stream or typed-output boundary. It is deliberately separate from prompt composition so quotations, code, URLs, identifiers, citations, and exact-copy content are not transformed indiscriminately.

- **Extraction front-door** — The propose-only capture layer that turns inbound emails/docs into typed candidate keys (→ object-state) and work-signals (→ user-memory). One front-door, two sinks. Architecture deferred. (ADR-0063)
- **Loop reconciliation** — Computing, at briefing-gather time, whether an open loop (e.g. a CI-failure email) is actually closed by consulting object-state, and demoting/recapping accordingly. (#212, ADR-0048/0062)
- **Loop-opener** — The inbound item that starts an open loop in the briefing (v1: a GitHub Actions CI-failure email). Carries a matching key (`head_sha`) but often no direct object id. (ADR-0062)
- **Registry (`IntegrationObjectDef`)** — The typed, per-provider source of truth (`@alfred/contracts`) declaring a provider's object kinds, key kinds, state normalization, and readable surfaces. Enforces at the type/API layer the constraints Postgres can't. Generalizes the ADR-0053 tool catalog. (ADR-0062, ADR-0053)
