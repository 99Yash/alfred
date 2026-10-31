---
id: switch-literal-needs-default
section: Types
status: gated
rung: ast
rule: alfred/switch-literal-needs-default
---

# End a `switch` over a closed union of string literals with a `default` that calls `assertNever`, or that returns a real value when unparsed data can reach it.

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

AST rule `alfred/switch-literal-needs-default`: a `switch` with at least one `case` and no `default`, where the test of each `case` is a string literal or a template literal with no expression. The rule reports the discriminant. It skips a switch with a `case` test of another kind, such as a number or a member like `Kind.A`. The repo has no `enum`.

An oxlint JS plugin has no type information, so the string-literal cases are the proxy for a closed union. The rule also reports a switch over an open `string`, such as `event.key`. Its fix is a `default` that tells what happens to the other values, for example `default: break;`. The rule also reports a switch that falls through to code after it, such as `return null` after the last `case`. Move that code into the `default`.

The rule does not read the `default`. `typescript/switch-exhaustiveness-check` still reports a missing union member when a `default` exists, and `alfred/no-never-sentinel-binding` rejects a `never` binding in the `default`.

The paydown added a `default` to 39 switches: 13 in `apps/web`, 17 in `packages/assistant`, 6 in `packages/http`, 2 in `packages/contracts`, and 1 in `packages/extraction`. It used the decision of [never-sentinel-escape](./never-sentinel-escape.md). 34 defaults call `assertNever`, because the value was parsed at its boundary or the code built it. Two defaults in `history-format.ts` return a real value, because run history arrives as an unparsed HTTP response. `outcomeHeadline` returns an "Unknown outcome" headline, and `triggerIdentity` returns the trigger label. Three keyboard handlers switch over `event.key` and end in `default: break;`. The rematch queue does not parse its job data, but its `default` calls `assertNever` like the four other queue processors. A throw fails the job, so BullMQ retries it. A return would drop the job.

## Hits

- #1535 packages/contracts/src/document-metadata.ts: `parseDocumentMetadata` had no `default` and returned `undefined` for a source that the build did not know.
- #1132 packages/http/src/mcp.ts: `mcpToolPolicyStateResult` and `policyStateFromUnresolved` had no `_exhaustive` default.
- #1103 packages/assistant/src/triage/floors/spam.ts: the new lane switch had no `never` default.
- #868 PDF ingestion README: the `switch` that later readers copy had no `default`.
