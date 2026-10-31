---
id: constant-at-narrowest-owner
section: Constants and ownership
status: stays-review
rung: none
---

# Put a constant at its narrowest stable owner.

Use `@alfred/contracts` only for a value that the server and the web app must agree on, in the file of the schema that enforces it. Keep implementation mechanics (timeouts, TTLs, batch sizes) in the owning package, next to the code that reads them.

Why: a value in the wrong package becomes a second door. See "Colocate the schema with its type, caps, and minting logic" in `docs/reference/schemas.md`.

## Bad

```ts
// packages/contracts/src/constants.ts
export const GMAIL_HISTORY_PAGE_SIZE = 100;
export const CONTEXT_SEARCH_MAX_LIMIT = 50;
```

Only the Gmail ingestor reads the page size, and the web app never sees it.

## Good

```ts
// packages/integrations/src/google/ingestor.ts, next to the code that reads it
const GMAIL_HISTORY_PAGE_SIZE = 100;

// packages/contracts/src/context-search.ts, next to the schema that enforces it
export const CONTEXT_SEARCH_MAX_LIMIT = 50;
```

## Mechanism

Placement follows ownership, not file type. A file-exists gate or a literal ban fires on correct code.

## Hits
