---
id: guards-only-on-unknown
section: Types
status: gated
rung: compiler
rule: check-types
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

Compiler: a closed-domain parameter in `packages/contracts/src/guards.ts`. `pnpm check-types` fails on a closed argument. Each guard infers `T` from its argument. When `T` is outside the domain, the parameter type is a marker interface that no value has, and the key of the marker is the error message.

Two domains:

- `isRecord` and `toRecord` (`UnknownOnly<T>`) take `unknown`, `any`, `{}`, and `{}` with `null` or `undefined`. Control-flow narrowing of an `unknown` value gives `{} | null`, so that type passes. An `any` argument reads as `unknown`, so the predicate still narrows it to `Record<string, unknown>`.
- `getPath`, `getStringPath` and `getIdPath` (`OpenOnly<T>`) also take open JSON. Open JSON is `JsonValue`, `JsonObject`, the AI SDK `JSONValue`, `Record<string, unknown>`, `object`, an array of those, and a union of those with primitives. A union member with a named key is closed. A primitive with no open member is closed too.

Decisions:

- `isRecord` rejects `JsonValue` and `Record<string, unknown>`. Its predicate cannot narrow a `JsonValue` union to its object branch without an array member. Use `isJsonObject(value)`, which takes `JsonValue | undefined` and narrows to `JsonObject`. It does the same runtime check as `isRecord`. On a `Record<string, unknown>`, the call proves nothing that the type does not already state.
- The path helpers accept `JsonValue`. A `JsonValue` has no named keys, so a path read erases no parse. A jsonb column with no `$type` is `unknown`, so the gate cannot tell whether a schema for that column exists. Hits #1537 and #1517 are of that kind.
- `any` passes. The `no-unsafe-*` lint rules already own an `any` value.
- A generic `T` that the call site cannot resolve does not pass, because the conditional type stays open. Bind the value to `unknown` first, as `deepFreeze` in `packages/assistant/src/connections/mcp/client.ts` does. When the narrowing must keep `T`, write `isRecord<unknown>(row)` and append `// drift-ok: <why>`, as `packages/auth/src/credential-adapter.ts` does.

The consolidation row `boundary-guard-type-argument` rejects an explicit type argument on a guard, because an explicit argument skips the inferred check.

The gate cannot see these forms:

- A typed value widened to `unknown` before the call: `const raw: unknown = row.error`, or a parameter typed `unknown`. This is correct when the type does not hold for stored data. For example, `documents.metadata` has a `$type`, but raw SQL merges write it. The tests in `packages/assistant/test/gmail-attachment.test.ts` and `gmail-ingest.test.ts` read the stored JSON that way.
- A value typed `unknown` upstream although a schema already parsed it, such as a webhook payload that ingress parsed (#1517).
- A closed type two levels down, such as `Record<string, Record<string, FullBriefing>>`. The check reads the outer type and its value type only.
- A test file on the typecheck baseline. Those files do not compile in `check-types`.

## Hits

- #1279 `packages/http/src/me.ts`: `getPath` read `headline` off a typed `FullBriefing`; two other sites read typed `JsonObject` fields the same way.
- #1293 apps/server/src/scripts/smokes/smoke-expiry.ts: `getStringPath` read `result.message` off a typed `ToolCallDispatchResult`.
- #1533 tool-call-round.ts and chat-turn.ts: path helpers read tool results that their own handlers built with types.
- #1546 packages/assistant/src/connections/mcp/result.ts: `getPath` read a typed `McpProtocolCallResult` again after the envelope widened it to `unknown`.
- #1537 jsonb columns: about 50 path-helper reads on columns whose schema already existed but was not connected.
- #1517 object-state reducers: about 39 path-helper reads on a webhook payload that ingress had already parsed.
- #1568 gmail-kind-fold.ts and gmail-edge-fold.ts: `getStringPath` read header fields off a payload that a schema already parsed.
