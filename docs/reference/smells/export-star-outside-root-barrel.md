---
id: export-star-outside-root-barrel
section: Constants and ownership
status: gated
rung: regex
rule: export-star-outside-root-barrel
---

# Name each re-export in a module barrel. Use `export *` only in a package root barrel.

Why: `export *` makes every new export of the source module public with no review, and it hides which names cross the door. It also loads the whole module, so a new export with a side effect at load reaches every importer. Example: `packages/assistant/src/knowledge/index.ts` names most of its exports and still ends three blocks with `export *`.

## Bad

```ts
// packages/assistant/src/knowledge/index.ts
export { refoldActiveGmailKindProjection } from "./refold";
export * from "./extractor";
export * from "./cold-start";
```

## Good

```ts
// packages/assistant/src/knowledge/index.ts
export { refoldActiveGmailKindProjection } from "./refold";
export { buildThreadTranscript, extractPropositionsFromThread } from "./extractor";
export { collectColdStartSignals, resolveIdentity } from "./cold-start";
```

## Mechanism

Regex row `export-star-outside-root-barrel` in `scripts/consolidation-rules.mjs`. It matches `export * from` and `export type * from` on one line. The formatter keeps the statement on one line, so the row sees each spelling. The owners are `packages/contracts/src/index.ts` and `packages/db/src/schemas.ts`.

The paydown changed 44 `export *` lines in 10 barrels to named re-exports. Each list holds the names that an importer reads through the barrel. A name with no importer in the tree stays in the list, because knip then reports it in its source module. That removal is for a later change.

`export * as ns from` stays legal. It binds one named namespace, and knip's `nsExports` reports a namespace member that nothing reads.

## Hits

- #751 the old `@alfred/api` backend barrel: `export * from "@alfred/assistant/connections"` put every new connections export on the backend door.
- #745 packages/assistant/src/connections/index.ts: nothing kept the barrel from `export * from "./ingestion"`, which would load BullMQ at import.
- #684 packages/assistant/src/knowledge/index.ts: an allowlist barrel ended with `export * from "./extractor"`.
- #683 packages/assistant/src/knowledge/index.ts: the two folded sub-barrels were forwarded with `export *`, not by name.
- #711 the memory barrel: `export *` gave the catalog two doors for one write.
