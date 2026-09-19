# ADR-0089 — Name HTTP and assistant packages by ownership

**Status.** Accepted. Migration in progress.

**Amendment 2026-08-16.** The module named `conversations` in the module-structure plan keeps the name `chat`. The module is chat-only (threads, messages, turn admission, compaction), and the schema (`chat_threads`, `chat_messages`), the contracts, the sync adapters, and the web routes already use `chat`. The plan's "Phase 6 renamed `chat` to `conversations`" is reversed for this module only; the `workflows` → `automation` rename stands.

**Amendment 2026-09-19 (#1148).** The system-tool `bootPort` seams in
`packages/assistant/src/tool-runtime/index.ts` return named result types, not
`unknown`. Every adapter is a thin forward to an owner function whose result
type already exists (execution sub-agent and scratch operations, chat history
retrieval, knowledge reads and instruction writes, task resolution, workflow
authoring and revisions), so naming the seam type lifts an existing contract
instead of inventing one. The seam keeps its direction: `tool-runtime`
imports no owner module, not even with `import type`, because
`scripts/check-module-architecture.mjs` reads a type-only import as an edge
too. Each seam type is therefore declared in `tool-runtime/index.ts` and
states in its doc comment which owner type it mirrors — the same precedent
`SystemToolContextSearchAdapter` already sets with `ContextSearchToolResult`.
The compiler holds the two halves together at the install site: the adapter
object is annotated with the seam interface, so a removed or retyped owner
field fails `check-types`. A field the owner ADDS is the residual risk: it
reaches the model at run time but stays unnamed at the seam. The fix, when
that cost grows, is to move the owner type into `@alfred/contracts` and let
both sides import one declaration. The `unknown`-as-design alternative is
rejected:
`internal/tools/system.ts` returns each adapter result straight into a
model-facing tool result, so an erased seam contract propagates into the model
surface. Honest `unknown` stays where the value is genuinely untyped at the
boundary (`safeJsonParse`, `getPath`, `parseBody`, `pruneToBudget`) and where
an external contract demands it (BullMQ `Processor`), each covered by a named
scope exemption rather than a seam-wide widening. The six-method
`SystemToolKnowledgeAdapter` grab-bag is split by product owner (knowledge
reads, instruction writes, web search) as part of the typing.

**Decision.** Alfred will separate HTTP adaptation from assistant behavior and
name both packages for what they own:

- `@alfred/http` owns Elysia routes, middleware, SSE, webhooks, and Replicache
  HTTP adapters.
- `@alfred/assistant` owns Alfred's product behavior and runtime composition.
- `apps/server` remains the process entrypoint and composition root.

The current `@alfred/api` package is a temporary mixed package. It keeps its
name while cycles are removed in place. Phase 6 moves product behavior into
`@alfred/assistant`, moves transport into `@alfred/http`, switches callers, and
then deletes `@alfred/api`. It does not rename mixed code and call the migration
complete.

The assistant package contains deep modules with one supported interface per
module. Cross-module callers must use that interface. They must not import
another module's implementation files. The target modules, their ownership,
and the migration order are recorded in
[`agent-friendly-module-structure.md`](../plans/agent-friendly-module-structure.md).

The target dependency direction is:

```text
apps/server -> @alfred/http -> @alfred/assistant
apps/server -> @alfred/assistant/runtime
@alfred/assistant -> db, ai, contracts, integrations, corpus
apps/web -> contracts, sync
```

`@alfred/assistant` must not import `@alfred/http`, legacy `@alfred/api`, or
`apps/server`. Product modules register recipes, capabilities, and event
consumers through composition adapters. The generic execution module must not
import product recipes.

The migration will break cycles inside `packages/api` before it extracts the
new packages. `scripts/module-architecture-baseline.json` records the current
graph and exact legacy private imports. The baseline is regression control, not
an approved design. `pnpm check:architecture` permits listed debt to disappear
but rejects new cyclic edges, new private cross-module imports, assistant-to-
transport imports, production-to-preview imports, and new web cross-feature
imports.

**Why.** A package name is part of its interface. `api` can mean an HTTP
surface, any public interface, or a remote protocol. `backend` states where code
runs but not what decisions it owns. `http` identifies the adapter technology.
`assistant` identifies the product behavior that disappears if the package is
removed.

The current `@alfred/api` package owns transport, product decisions, durable
execution, queues, and runtime lifecycle. Its `backend.ts` facade gives callers
many implementation-level doors. Seventeen assistant modules are in one
strongly connected component. A direct package move would preserve that
coupling under a new package name.

Breaking cycles behind small interfaces first gives callers less knowledge,
keeps changes local to an owner, and makes package extraction mechanical. The
checked baseline also prevents migration work from adding more debt while old
paths still exist.

**Alternatives rejected.**

- **`@alfred/core`.** It is short but does not state what it owns. Contracts,
  runtime primitives, infrastructure, and product behavior can all be called
  core, so it tends to become a grab bag.
- **`@alfred/backend`.** It describes deployment position instead of owned
  decisions.
- **Keep all behavior in `@alfred/api`.** This keeps transport and product
  decisions mixed and preserves the large facade.
- **Move all current API modules into `@alfred/assistant` at once.** This moves
  files but does not remove cycles or private imports.
- **Create one package for each product domain.** This adds build and manifest
  work without a deployment or runtime need. Checked internal modules give the
  required isolation.
- **Create horizontal `services`, `repositories`, and `utils` layers.** This
  spreads one product decision across directories and weakens locality.

**Consequences.** Every migration slice must introduce or deepen one module
interface, move callers to it, test through it, and remove the old door. A
slice that only moves files is incomplete. Temporary exceptions need an owner,
a reason, and a removal phase. The architecture check runs in `verify:fast` and
CI.

**Cross-ref.** This is a structural decision. It does not change the product
semantics in ADR-0005, ADR-0006, ADR-0034, ADR-0047, or ADR-0067. Those decisions
continue to control realtime delivery, durable execution, approval, domain
events, and knowledge storage.
