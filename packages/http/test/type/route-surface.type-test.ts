// Compile-only fixture for the route half of `@alfred/http`'s barrel
// (`packages/http/src/index.ts`). The middleware half is pinned by
// `middleware-surface.type-test.ts`; this file pins every route the package
// owns — the agent-run route plus the four domain routes campaign item 05
// moved across — each of which `packages/api/src/index.ts` mounts with
// `.use(...)`.
//
// The fixture is compile-only for the same reason as its sibling: exercising
// the route for real needs the auth macro, which needs env and a live
// database, and a skipped test is not a pass. This file never runs —
// `@alfred/http` has no test script (campaign item 19 owns adding one). It is
// type-checked solely by `packages/http/tsconfig.test.json`, which
// `check-types` runs as its second `tsc` pass, after the composite `tsc -b`
// that only ever sees `src`.
//
// Every binding below is mutation-tested, one binding at a time. Dropping the
// barrel export turns this file red with TS2305; rebinding the name to a
// non-Elysia value turns it red with TS2769 (plus TS2322 on the prefix
// assertion); changing the route module's own prefix turns it red with
// TS2322.
//
// What this fixture does NOT pin is the `{ auth: true }` guard: commenting out
// `.use(authMacro)` in the route module leaves this file green. It needs no
// assertion here, because that mutation is already five compile errors in the
// route module itself (TS2353 on the guard plus TS2339 on every `user`), so
// the guard is checked one tier up from a fixture.

import {
  agent,
  approvalsRoutes,
  onboardingRoutes,
  skillsRoutes,
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

// The four domain routes campaign item 05 moved out of
// `packages/api/src/modules/*`. The mount path is the one property a pure
// transport move must preserve, and nothing else in the repo pins it: no test
// imports these route objects, and neither `app.handle` test touches
// `/api/approvals`, `/api/me/onboarding`, `/api/skills` or `/api/workflows`.
export const approvalsPrefix: (typeof approvalsRoutes)["config"]["prefix"] = "/api/approvals";
export const onboardingPrefix: (typeof onboardingRoutes)["config"]["prefix"] = "/api/me/onboarding";
export const skillsPrefix: (typeof skillsRoutes)["config"]["prefix"] = "/api/skills";
export const workflowsPrefix: (typeof workflowRoutes)["config"]["prefix"] = "/api/workflows";

// The mount call sites themselves: `packages/api/src/index.ts` composes each
// route into the root app with `.use(...)`, so every plugin must stay usable
// there.
export const composed = new Elysia()
  .use(agent)
  .use(approvalsRoutes)
  .use(onboardingRoutes)
  .use(skillsRoutes)
  .use(workflowRoutes);
