---
id: no-barrel-export-for-test
section: Backend
status: candidate
rung: check
feasibility: medium
issue: #1629
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

Knip in production mode, where test files are not entries.

## Hits

- #1361 packages/assistant/src/knowledge/index.ts: the barrel exported the projection-run primitives and the folds only for tests.
- #1516 packages/assistant/src/tool-runtime/index.ts: exported `type BoundToolCall` only for two tests.
