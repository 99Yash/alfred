// Compile-only fixture for the route half of `@alfred/http`'s barrel
// (`packages/http/src/index.ts`). The middleware half is pinned by
// `middleware-surface.type-test.ts`; this file pins every route the package
// owns, each of which `packages/http/src/index.ts` mounts with `.use(...)`. Add
// a prefix line here in the same slice that adds a barrel route line, and do
// not describe the set by counting it — the campaign is still moving routes in.
//
// The fixture is compile-only for the same reason as its sibling: exercising
// the route for real needs the auth macro, which needs env and a live
// database, and a skipped test is not a pass. This file never runs: the
// package's `test` script globs `test/**/*.test.ts`, and a `.type-test.ts`
// name does not match it. It is type-checked solely by
// `packages/http/tsconfig.test.json`, which `check-types` runs as its second
// `tsc` pass, after the composite `tsc -b` that only ever sees `src`.
//
// Every binding below is mutation-tested, one binding at a time. Dropping the
// barrel export turns this file red with TS2305; changing the route module's
// own prefix turns it red with TS2322. The codes for a rebind to a non-Elysia
// value depend on the SHAPE of the replacement, so record the shape next to
// any code you cite here: rebinding to an object literal that does carry a
// `config.prefix` of the wrong type fails the assertion below with TS2769 plus
// TS2322, while rebinding to a value on which the indexed access itself fails
// gives TS2769 plus TS2339. The fixture is red either way.
//
// What this fixture does NOT pin is the `{ auth: true }` guard: commenting out
// `.use(authMacro)` in the route module leaves this file green. It needs no
// assertion here, because that mutation is already a compile error in the
// route module itself, so the guard is checked one tier up from a fixture —
// and it is checked there on purpose, not by accident. The load-bearing error
// is TS2353 on the `.guard({ auth: true }, …)` object literal, which is
// structurally independent of every handler: removing the guard AND every use
// of `user` from `workflows.ts` still fails on it. The TS2339s on `user` are
// extra, and the total is per-module, so never copy a count between route
// files. Measured here one file at a time, each mutation reverted before the
// next: agent 6, approvals 3, onboarding 4, skills 4, workflows 3,
// conversations 6 — one TS2353 on the guard, one TS6133 for the now-unused
// import, and one TS2339 per handler that destructures `user`. Measure with one
// `tsc` pass, or with a mutation inside `src`: `check-types` here is
// `tsc -b … && tsc -p …` over the same sources, so a `test/`-only mutation that
// leaves the first pass green is counted once by the second pass, while a `src`
// mutation short-circuits the `&&` and is also counted once. A mutation red in
// both passes is counted twice.
//
// The blind spot is the opposite shape: a route carrying no `{ auth: true }`
// guard at all — the deliberately unauthenticated webhooks campaign items
// 24-27 bring — leaves `tsc` nothing to fail on. Prove the guard boundary of
// one of those with `app.handle`, not with `tsc`.

import {
  agent,
  approvalsRoutes,
  chatRoutes,
  events,
  mcpIntegrationRoutes,
  meRoutes,
  onboardingRoutes,
  replicache,
  skillsRoutes,
  toolTiersRoutes,
  workflowRoutes,
} from "@alfred/http";
import { Elysia } from "elysia";

// The barrel binding is an Elysia plugin instance, not a factory, and it
// carries its own prefix. Elysia threads that prefix through the instance's
// first type parameter, so reading it back off `agent` is how this fixture
// pins the mount path: the route answers under `/api/agent`, and it does so
// because the module sets that prefix, not because the composing app supplies
// one.
// Exported (not bare `const`) to satisfy `noUnusedLocals`, matching the
// established `.type-test.ts` idiom in this package and `@alfred/api`.
export const prefix: (typeof agent)["config"]["prefix"] = "/api/agent";

// The domain routes the campaign moved out of `packages/api/src/modules/*`. The
// mount path is the one property a pure transport move must preserve.
//
// This is not the repo's only pin on it, and do not write that it is. The web
// Eden client (`apps/web/src/lib/eden.ts`) is `treaty<App>` over
// `import type { App } from "@alfred/http"`, whose `exports["."]` is the live
// `./src/index.ts`, so the path, method, params, body and response of every
// route the root app mounts are already derived and checked wherever a web
// call site uses them — inside the same `turbo run check-types`. Renaming the
// workflows prefix below to `/api/workflowsZZZ` fails `pnpm --filter web exec
// tsc` with TS2551 in `recovery-panel.tsx`. What that client cannot see is a route
// with no web call site, and what nothing here sees is handler-body behavior;
// this fixture covers the first gap and pins the surface at the package that
// now owns it, so a later transport move need not restate the mount surface.
export const approvalsPrefix: (typeof approvalsRoutes)["config"]["prefix"] = "/api/approvals";
// `/api/chat` is the first route here for which the Eden paragraph above buys
// nothing at all: all five of its web call sites are untyped `fetch`, so
// `treaty<App>` derives the types and nobody consumes them, and renaming this
// prefix fails nothing in `pnpm --filter web exec tsc`. This line plus a
// route-table comparison against the pre-move app are the whole mount-surface
// evidence for it. Check for a call site before assuming Eden covers a prefix.
export const chatPrefix: (typeof chatRoutes)["config"]["prefix"] = "/api/chat";
export const mePrefix: (typeof meRoutes)["config"]["prefix"] = "/api/me";
export const onboardingPrefix: (typeof onboardingRoutes)["config"]["prefix"] = "/api/me/onboarding";
export const skillsPrefix: (typeof skillsRoutes)["config"]["prefix"] = "/api/skills";
export const workflowsPrefix: (typeof workflowRoutes)["config"]["prefix"] = "/api/workflows";

// Only `/connections` has a typed Eden call site. The browser builds connect,
// reconsent and OAuth URLs by hand, so this line and the composed-app route
// comparison pin the MCP mount prefix for the remaining surface.
export const mcpPrefix: (typeof mcpIntegrationRoutes)["config"]["prefix"] = "/api/integrations/mcp";
export const toolTiersPrefix: (typeof toolTiersRoutes)["config"]["prefix"] = "/api/integrations";

// The SSE endpoint, and the Eden check above buys nothing here either: the web
// client builds this URL by hand (`apps/web/src/lib/events/stream.ts:27`, and
// `routes/-debug/debug-events-page.tsx:20` for `_demo`), so `treaty<App>` never
// sees the prefix and this line is its only pin. A changed prefix does not fail
// a call — the browser gets a 404, which puts an `EventSource` in a permanently
// CLOSED state with no reconnect, so the stream stops silently.
export const eventsPrefix: (typeof events)["config"]["prefix"] = "/api/events";

// The Replicache protocol endpoints (`/pull`, `/push`, and a second SSE stream
// for pokes). Eden buys nothing here either, and for a stronger reason than
// above: all three are reached by a hand-built URL, never by the Eden client —
// `fetch(\`${API_URL}/api/replicache/pull\`)` and `/push` at
// `apps/web/src/lib/replicache/client.ts:100,125`, and `new EventSource(...)`
// at `:140`. No generated type is consulted at any of the three call sites, so
// a changed prefix leaves both packages compiling and silently stops every
// client from syncing.
export const replicachePrefix: (typeof replicache)["config"]["prefix"] = "/api/replicache";

// The mount call sites themselves: `packages/http/src/index.ts` composes each
// route into the root app with `.use(...)`, so every plugin must stay usable
// there.
export const composed = new Elysia()
  .use(agent)
  .use(approvalsRoutes)
  .use(chatRoutes)
  .use(events)
  .use(meRoutes)
  .use(onboardingRoutes)
  .use(replicache)
  .use(skillsRoutes)
  .use(workflowRoutes)
  .use(mcpIntegrationRoutes)
  .use(toolTiersRoutes);
