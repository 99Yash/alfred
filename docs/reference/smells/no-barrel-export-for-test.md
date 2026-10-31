---
id: no-barrel-export-for-test
section: Backend
status: gated
rung: check
rule: check:test-only-exports
---

# Do not export a primitive from a package barrel only for a test.

The test imports it from `src/`.

Why: a public primitive is the door for the next copy. Example: #1361.

## Bad

```ts
// packages/assistant/src/knowledge/index.ts
export { completeProjectionRun, startProjectionRun } from "./projection";

// packages/assistant/test/knowledge/gmail-kind-fold.test.ts
import { completeProjectionRun, startProjectionRun } from "@alfred/assistant/knowledge";
```

## Good

```ts
// packages/assistant/test/knowledge/gmail-kind-fold.test.ts
import { completeProjectionRun, startProjectionRun } from "../../src/knowledge/projection";
```

## Mechanism

Check script `pnpm check:test-only-exports` (`scripts/check-test-only-exports.mjs`). It runs knip two times with `--include-entry-exports`. The first run is in production mode, where test files are not entries. The second run is in default mode. A name that the first run reports and the second run does not report has only test readers. The check fails when that name is on a door: a file that a workspace `exports` map names.

Plain `knip --production` cannot state the rule, for two reasons:

- It does not report the exports of an entry file, and each door is an entry file. A probe added `export { failProjectionRun } from "./projection"` to the knowledge barrel, and the name left the plain report.
- It reports a name that a test imports from an inner `src/` module. That is the Good form.

Scripts and evals are production entries (the `!` suffix in `knip.json`). So a name that only a script or an eval reads is not a finding.

The paydown removed 108 names from doors. Each test now imports the name from its `src/` module. `PullResponse` and `PushResponse` in `@alfred/http` got `@public`, because the inferred `App` type names them. `scripts/test-only-exports-baseline.json` lists the 365 findings that remain. The check fails on a finding that is not in the baseline. It also fails on a baseline row that is no longer a finding, so the list only gets shorter. The remaining findings are these:

- 288 names that a door module declares itself. Most are in a module that a glob subpath publishes (`./*` in `@alfred/contracts`, `./tool-runtime/*`, `./triage/*`). The fix is to move the name to an inner module, or to delete it when production does not need it.
- 17 re-exports that a test in another workspace reads. The fix is a `test-support.ts` door.
- 35 re-exports that tests reach through `export *` or a dynamic import.
- 25 re-exports that stay on purpose or need a manual change. `tool-registry-door.test.ts` reads `registerTool` through the package specifier to pin the exports self-reference. `middleware-surface.type-test.ts` pins `SecurityHeadersOptions` on the `@alfred/http` door. The `@alfred/http` routes use an import and a separate `export { … }`.

False negatives:

- A door export with `@public` or `@internal` on its export line. Knip skips `@public` in each mode and `@internal` in production mode. Review checks the reason on the tag. An `@internal` tag on the declaration behind a barrel does not hide the barrel re-export. A probe showed this.
- A door named `test-support.ts`. It is a door for tests by its name.
- A name that a script or an eval also reads.
- A new test reader of a name that the baseline already lists.

False positives:

- Intentional API that knip cannot see, such as a type that Eden reads through `typeof app`. Tag it `@public` with the reason.
- A door that a test pins on purpose, such as `registerTool`. It stays in the baseline.

The probes: a re-export of `failProjectionRun` in `packages/assistant/src/knowledge/index.ts` failed and named that file and that name. A new test-only `export const` in `packages/contracts/src/attention.ts` failed and named that file. A test-only export in `packages/assistant/src/knowledge/projection.ts`, which no `exports` map names, passed.

## Hits

- #1361 packages/assistant/src/knowledge/index.ts: the barrel exported the projection-run primitives and the folds only for tests.
- #1516 packages/assistant/src/tool-runtime/index.ts: exported `type BoundToolCall` only for two tests.
