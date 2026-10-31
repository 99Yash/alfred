---
id: guards-only-on-unknown
section: Types
status: candidate
rung: compiler
feasibility: medium
issue: #1629
---

# Use `isRecord` and `getPath` only on a value that is `unknown` at a true parse boundary.

Index a typed field directly. Use `isIndexable` and `Reflect.get` for an SDK instance.

Why: the guard widens a parsed value again. Example: #1279.

## Bad

```ts
const row = rows[0];
const rawHeadline = getPath(row?.fullBriefing, "headline");
const headline = rawHeadline === undefined ? null : String(rawHeadline);
```

## Good

```ts
const row = rows[0];
const headline = row?.fullBriefing?.headline ?? null;
```

## Mechanism

Compiler: a closed-domain parameter that rejects an argument whose type is not `unknown`.

## Hits

- #1279 `packages/http/src/me.ts`: `getPath` read `headline` off a typed `FullBriefing`; two other sites read typed `JsonObject` fields the same way.
- #1293 apps/server/src/scripts/smokes/smoke-expiry.ts: `getStringPath` read `result.message` off a typed `ToolCallDispatchResult`.
- #1533 tool-call-round.ts and chat-turn.ts: path helpers read tool results that their own handlers built with types.
- #1546 packages/assistant/src/connections/mcp/result.ts: `getPath` read a typed `McpProtocolCallResult` again after the envelope widened it to `unknown`.
- #1537 jsonb columns: about 50 path-helper reads on columns whose schema already existed but was not connected.
- #1517 object-state reducers: about 39 path-helper reads on a webhook payload that ingress had already parsed.
- #1568 gmail-kind-fold.ts and gmail-edge-fold.ts: `getStringPath` read header fields off a payload that a schema already parsed.
