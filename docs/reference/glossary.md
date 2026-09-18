# Domain glossary — invented terms

One place to look up the invented vocabulary that code, plans, and ADRs use.
Each entry is one sentence plus the module that owns the definition. Where two
registries reuse a word for different things, the entry names each sense.

Product/domain nouns ("sender prior", "account persona") live in
[`../../CONTEXT.md`](../../CONTEXT.md); this file covers the implementation
vocabulary those entries assume.

## Triage

**floor** — A deterministic post-classification step that guarantees a rule the
prompt only asks for as judgment, folding a fixed sequence over the model's
category. Owner: `packages/assistant/src/triage/floors/floor.ts` (sequence in
`floors/index.ts`). *Reused:* the tool registry calls the always-confirm `high`
risk tier a "one-way floor" (`packages/assistant/src/tool-runtime/internal/registry.ts`).

**hedge** — A second, cancellable duplicate of the classify request sent only
after a healthy call would already have answered, where the first draw to land
wins; it is not a retry. Owner: `packages/assistant/src/triage/hedge.ts`.

**verdict** — The closed outcome a floor returns (`keep`/`demote`/`escalate`)
that `applyFloorVerdict` alone turns into a classification, so a floor cannot
express an illegal edit. Owner: `packages/assistant/src/triage/floors/floor.ts`.

**closure** — In triage, the outcome that the user's underlying request or loop
is resolved (the `done` category); a workflow run's client-facing ending is a
separate, execution-level closure. Owner:
`packages/assistant/src/triage/classify.ts`; execution sense:
`packages/assistant/src/execution/types.ts` (`Workflow.closure`).

**observation** — A single persisted, source-attributed fact (for example one
Gmail message); triage additionally assembles a deterministic pre-model
observation layer to focus the cheap classifier. Owner:
`packages/assistant/src/triage/observations.ts` (substrate side:
`packages/assistant/src/knowledge/observations.ts`, shape in
`packages/contracts/src/user-model.ts`).

**standing (instruction)** — A durable, behavior-changing directive the user
states in plain language, stored as a `user_facts` row whose registered
`effects` consumers branch on. Owner:
`packages/contracts/src/standing-instructions.ts`; readers in
`packages/assistant/src/knowledge/standing-instructions.ts`. *Reused:* a
"standing watch" is a recurring read-only script, not an instruction.

## User model / knowledge

**observation fold** — The deterministic replay of observations into
materialized entity profiles for one projection run. Owner:
`packages/assistant/src/knowledge/gmail-kind-fold.ts`.

**projection** — A versioned, materialized read model built from observations
and activated before any consumer reads it. Owner:
`packages/assistant/src/knowledge/projection.ts`. *Reused:* the integration
registry calls each slug-keyed table derived from its record a "projection"
(`packages/contracts/src/integrations/projections.ts`).

**refold** — Re-running the fold over newer observations behind a frozen-logic
gate that auto-activates only when the current fold still reproduces the active
run's checksum. Owner: `packages/assistant/src/knowledge/refold.ts`.

## Registries and retrieval

**registry** — A boot-time map that owns one closed key space and the facts
keyed by it. Three registries reuse the word: the tool registry
(`packages/assistant/src/tool-runtime/internal/registry.ts`), the context-source
registry (`packages/assistant/src/context-search/registry.ts`), and the
integration registry (`packages/contracts/src/integrations/registry.ts`).

**bind** — To hand a tool a call-scoped, already-authenticated dependency at
dispatch (the provider bind and corpus bind). Owner:
`packages/assistant/src/tool-runtime/internal/registry.ts`. *Reused:* the
connected-account lifecycle calls binding a provider credential to an account
"credential binding" (`packages/assistant/src/connections/index.ts`); the
integration registry declares one `credential` per slug
(`packages/contracts/src/integrations/registry.ts`).

**manifest** — A retrieval source's own declaration of what it can answer and
how it can be read, validated at registration and consulted only by the read
boundary. Owner: `packages/contracts/src/source-manifest.ts`; reader
`packages/assistant/src/context-search/manifest.ts`.

**evidence card** — The single cross-integration shape every Context Search
source adapter returns and the packer renders for the model. Owner:
`packages/contracts/src/evidence-card.ts`.
