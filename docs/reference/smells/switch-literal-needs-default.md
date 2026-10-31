---
id: switch-literal-needs-default
section: Types
status: candidate
rung: ast
feasibility: medium
issue: #1629
---

# End a `switch` over a closed union of string literals with a `default` that calls `assertNever`.

`typescript/switch-exhaustiveness-check` proves that each member has a case. It does not ask for a `default`.

Why: the compiler checks the cases against the union of today. A stored row or a peer at deploy skew can hold a member that this build does not know. Without a `default`, that value falls through, and the function returns `undefined`. Example: `parseDocumentMetadata` in `packages/contracts/src/document-metadata.ts`.

## Bad

```ts
switch (row.source) {
  case "gmail":
    return { source: row.source, metadata: parseGmailDocumentMetadata(row.metadata) };
  case "github":
  case "sentry":
    return { source: row.source, metadata: parseReceipt(row.metadata) };
}
```

## Good

```ts
switch (row.source) {
  case "gmail":
    return { source: row.source, metadata: parseGmailDocumentMetadata(row.metadata) };
  case "github":
  case "sentry":
    return { source: row.source, metadata: parseReceipt(row.metadata) };
  default:
    return assertNever(row.source, "document source");
}
```

## Mechanism

AST: a `switch` whose every `case` test is a string literal and that has no `default` clause. A switch over an open `string` has no member set, so the rule must not fire on a switch that already has a `default`.

## Hits

- #1535 packages/contracts/src/document-metadata.ts: `parseDocumentMetadata` had no `default` and returned `undefined` for a source that the build did not know.
- #1132 packages/http/src/mcp.ts: `mcpToolPolicyStateResult` and `policyStateFromUnresolved` had no `_exhaustive` default.
- #1103 packages/assistant/src/triage/floors/spam.ts: the new lane switch had no `never` default.
- #868 PDF ingestion README: the `switch` that later readers copy had no `default`.
