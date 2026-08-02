# ADR-0089 — Name HTTP and assistant packages by ownership

**Status.** Accepted. Migration in progress.

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
