---
id: import-type-side-effects
section: Types
status: candidate
rung: ast
feasibility: high
issue: #1629
---

# Write `import type { X }` when every name of an import is a type.

Keep the inline `type` marker only for a mixed import that also brings a value.

Why: under `verbatimModuleSyntax`, `import { type X } from "m"` erases the name but keeps `import "m"`. So the module still loads, runs its side effects, and stays in the import graph. Example: in #1554, a type-only inline import made a module cycle, and a schema threw a ReferenceError before initialization.

## Bad

```ts
import { type Document } from "@alfred/db/schemas";
import { findUnembeddedDocumentIds, indexDocument } from "./embed-document";
```

## Good

```ts
import type { Document } from "@alfred/db/schemas";
import { findUnembeddedDocumentIds, indexDocument } from "./embed-document";
```

## Mechanism

Built-in oxlint rule: `typescript/no-import-type-side-effects`. About 50 sites remain, and the fixer rewrites each of them.

The `inline-type-imports` fix style of `typescript/consistent-type-imports` writes the Bad form. So the two rules must run together.

## Hits

- #1520 apps/server/src/scripts/repairs/repair-triage-sender-miss-committed.ts: three imports kept the inline `type` form when every name was a type.
- #1554 packages/contracts/src/identity-affiliation.ts: `import { type FactKey }` kept a runtime import, and the cycle threw a ReferenceError at load.
- #680 knowledge settings: `import { type IanaTimezone }` imported only a type in the inline form.
- #669 packages/assistant/src/knowledge/cold-start/cold-start-research.ts: `import { type Workflow }` made the scanner count a real module edge.
- #742 packages/api: deleting the last value from a mixed import left `import { type Database }`, which kept `@alfred/db` in the graph.
