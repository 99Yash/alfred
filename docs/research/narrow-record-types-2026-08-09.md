# Narrow record types and boundary schemas

Research date: 2026-08-09

## Decision

Keep the hard ban on `Record<string, any>`, but do not use zero `Record<string, unknown>` spellings as the success metric. The scalable rule is:

1. External, persisted, and protocol input enters as `unknown`.
2. The owner parses it once with a schema that describes only the projection that the owner uses.
3. Internal code uses `z.infer` or another type derived from that schema.
4. A string index signature remains valid for a real dynamic dictionary or JSON object. It must not stand in for a known domain object.

The starting diff moved in this direction, but it was not ready as written. The brief-metadata parser created a fail-open policy regression. The baseline checker was also too text-sensitive and measured the wrong final state. The Notion and Gmail schemas needed narrower ownership and clearer compatibility rules before this could become a model for later migrations.

## Primary-source findings

### What `Record<string, unknown>` means

TypeScript defines `Record<Keys, Type>` as an object type whose property keys are `Keys` and whose property values are `Type`. `Record<string, unknown>` is therefore an open string-keyed object, not a declaration of known fields. [TypeScript utility types](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type)

The TypeScript handbook says an index signature is for a case where property names are not known in advance, but the value shape is known. It also requires declared properties to agree with the string index signature's value type. [TypeScript handbook, index signatures](https://www.typescriptlang.org/docs/handbook/2/objects.html#index-signatures)

`unknown` is the type-safe counterpart of `any`: all values can flow into it, but code must narrow or assert it before most operations. [TypeScript 3.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-0.html#new-unknown-top-type)

Two consequences matter here:

- A read from `Record<string, unknown>` produces `unknown`, so each consumer must rediscover the value shape.
- A string index signature permits arbitrary property names. With `noUncheckedIndexedAccess`, an indexed read also carries `undefined`, because the requested key might not exist. [TypeScript 4.1 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-1.html#checked-indexed-accesses---nouncheckedindexedaccess)

For a closed key set, `Record<LiteralUnion, Value>` is different. TypeScript's `satisfies` operator can check exact keys and compatible values while it preserves the expression's narrow inferred type. [TypeScript 4.9 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)

### Zod object policy is part of the contract

Zod derives a static output type with `z.infer`. It also exposes `z.input` and `z.output` when parsing or transformation makes the accepted input differ from the normalized output. [Zod basic usage](https://zod.dev/basics#inferring-types)

`safeParse` returns a discriminated success-or-error result. It does not make a best-effort partial object unless each field schema defines that policy. [Zod basic usage](https://zod.dev/basics#handling-errors)

Zod 4 object modes have different contracts:

- `z.object({...})` strips unrecognized keys from the parsed result.
- `z.strictObject({...})` rejects unrecognized keys.
- `z.looseObject({...})` keeps unrecognized keys.
- `.catchall(schema)` keeps unrecognized keys only when they satisfy the catchall schema. [Zod object schemas](https://zod.dev/api#objects)

This distinction is important for provider compatibility. Notion says it can add response fields without a new API version and integrations must be resilient to these additive changes. A normal `z.object` read projection already has that property because it ignores and strips additive fields. Keeping all unknown fields is not required for forward compatibility unless the code must inspect or re-emit them. [Notion API versioning](https://developers.notion.com/reference/versioning)

`z.record(z.string(), valueSchema)` represents a true string-keyed map. In Zod 4, an enum-keyed `z.record` checks every enum key; `z.partialRecord` represents a partial enum-keyed map. [Zod records](https://zod.dev/api#records)

`.catch(fallback)` returns the fallback after any validation error in that schema. It can be useful for an explicitly best-effort field, but it also hides the distinction between absent and malformed input. [Zod catch](https://zod.dev/api#catch)

Zod 4 changed the inferred shape of `z.unknown()` and `z.any()` fields: they are no longer inferred as optional object keys. [Zod 4 migration guide](https://zod.dev/v4/changelog#changes-zunknown-optionality)

A focused probe against this repository's Zod 4.3.6 shows an important edge: `z.object({ a: z.unknown() }).safeParse({})` succeeds with `{}`, while `z.infer` marks `a` as required. Do not use required `z.unknown()` fields to prove that a provider key exists. Use an explicit optional schema if absence is valid, or validate the real consumed type if presence is required.

For timestamps that are documented as ISO values, Zod supplies `z.iso.datetime()`. It accepts UTC `Z` values by default and can opt into offsets. [Zod ISO datetimes](https://zod.dev/api#iso-datetimes)

### Persistence types do not validate rows

The database column currently declares credential metadata with Drizzle `jsonb(...).$type<Record<string, unknown>>()`. Drizzle documents that `.$type()` changes JSON inference but does not check runtime values. A consumer must still validate persisted JSON at its owning read boundary. [Drizzle PostgreSQL JSON/JSONB columns](https://orm.drizzle.team/docs/column-types/pg#jsonb)

This supports the diff's move from casts to Zod reads. It does not require one shared schema for every consumer of the JSON bag. Each owner can parse its own projection.

### Oxlint can enforce exact type-reference spellings

Oxlint's `typescript/no-restricted-types` rule accepts a map of banned type names and custom messages. The rule is a restriction rule and supports fixes and suggestions. [Oxlint `no-restricted-types`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-restricted-types)

The Oxlint implementation removes whitespace from configured names and source snippets. For a generic type reference, it compares the full source span when a configured key contains a generic or other complex form. This makes the configured `Record<string, any>` ban insensitive to formatting whitespace. [Oxlint rule source](https://github.com/oxc-project/oxc/blob/main/crates/oxc_linter/src/rules/typescript/no_restricted_types.rs#L35-L40)

The same implementation is syntactic, not semantic. It checks TypeScript type-reference nodes and source text. It does not resolve aliases, and it does not make an object index signature equivalent to `Record`. [Oxlint rule source](https://github.com/oxc-project/oxc/blob/main/crates/oxc_linter/src/rules/typescript/no_restricted_types.rs#L243-L380)

Therefore the Oxlint rule correctly bans the exact `Record<string, any>` spelling, including whitespace variants. It does not establish the broader claim that every equivalent loose-`any` object type is banned.

Oxlint supports narrowly scoped inline disables for exceptional cases. It can also report an unused disable through a CLI option or `options.reportUnusedDisableDirectives`, which makes a local exception self-cleaning after the exceptional node disappears. [Oxlint inline ignore comments](https://oxc.rs/docs/guide/usage/linter/ignore-comments.html)

Oxlint also supports local JavaScript rules with AST traversal, but its JavaScript plugin API is still alpha and does not support type-aware custom rules. A custom rule is possible, but this stability and capability tradeoff must be explicit. [Oxlint JavaScript plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins)

## Diff adjudication

### P1: the combined brief schema can erase a valid restriction

[`briefAuthoredMetadataSchema`](../../packages/api/src/modules/agent/workflows/user-authored-brief.ts) validates `allowedIntegrations`, `allowedTools`, and `requiredCapabilities` as one object. Each of the three read helpers reparses that complete object.

This creates failure coupling. For example:

```ts
{
  allowedIntegrations: ["notion"],
  allowedTools: 42,
}
```

The old `readAllowedIntegrations` kept `['notion']` because it inspected that field independently. The new complete-object parse fails because `allowedTools` is malformed, so `readAllowedIntegrations` returns `[]`. `integrationAllowed` defines an empty list as unrestricted. One malformed sibling field can therefore broaden the integration policy from Notion-only to all integrations.

The widening is larger than one integration list. A malformed `requiredCapabilities` value also makes the `allowedTools` read return `undefined`. `initialState` treats `undefined` as "derive and activate the normal tool surface," so one malformed readiness field can erase both valid integration and tool restrictions.

This local schema also restates weaker versions of fields already owned by [`workflowRevisionDefinitionSchema`](../../packages/contracts/src/agent.ts): the canonical integration field uses `integrationSlugSchema` and a 20-item limit, and the canonical tool field uses `toolNameSchema` and a 100-item limit. The new metadata schema uses unbounded `z.array(z.string())` for both. A new integration/tool constraint now requires coordinated edits and nothing makes the second edit inevitable.

This is a release blocker. It is a concrete counterexample to the claim that one shared schema is safer.

Recommended shape:

- Parse the metadata object shell once.
- Parse each independent policy field with its own schema, or make failure semantics explicit at each field.
- Derive each field parser from `workflowRevisionDefinitionSchema.shape` instead of restating its element type and limits.
- Do not map malformed policy metadata to the same value that means "no restriction."
- Return one normalized `BriefAuthoredMetadata` value to `initialState` so the object is parsed once, not three times.

The domain change probe is "add or revise one metadata policy field." It must not invalidate an unrelated policy field. The owning adapter should make that independence structural.

### P1: the baseline checker is not a scalable hard boundary

[`check-loose-record-types.mjs`](../../scripts/check-loose-record-types.mjs) is intended as a migration counter, but its current identity is `file:line` and its detection is line-based regex.

The following ordinary changes can break or evade it:

- Adding a line above an unchanged occurrence moves its identity and reports it as new debt.
- Removing an occurrence leaves a stale baseline entry because the script checks only `unknownSites - baseline`; it does not reject `baseline - unknownSites`.
- A multiline `Record<\n string,\n unknown\n>` is not detected.
- `{ [name: string]: unknown }` is not detected because the index-signature regex accepts only an identifier literally named `key`.
- A type alias or another semantically equivalent form is not detected.
- Multiple banned occurrences on one grandfathered line produce one `file:line` identity, so removing all but one occurrence does not reduce the measured debt.
- Comment and syntax handling are approximate because the scanner does not parse TypeScript.

The current baseline contains 99 line identities. The check passes in this working tree, but line identity means unrelated code growth will create maintenance noise as that number and the repository grow.

More importantly, zero occurrences is not the correct domain goal. The repository's canonical `isRecord` and `toRecord` helpers honestly return an open string-keyed object. Dynamic canonicalization, MCP argument bags, and deliberate JSON dictionaries also have unknown keys by design. Zod loose objects and schema-derived aliases can retain the same index-signature semantics without containing the banned source spelling. A spelling counter can therefore reward a cosmetic wrapper while the representation stays equally open.

The useful target is unsafe use, not the existence of the type:

- Casts or assertions that turn untrusted data into an open record without validation.
- Repeated manual field reads that should be one owned boundary projection.
- A known domain object represented as an arbitrary dictionary.
- An open record that crosses farther into the system than its owning adapter.

Named intentional dictionaries are not debt when the domain keys are truly dynamic and the owner validates the value shape.

Recommended enforcement:

1. Keep Oxlint for the exact hard ban that it supports well.
2. Do not land `check:loose-record-types` or its shrink-to-zero baseline as repository policy. Remove this gate from the current diff.
3. Prefer an AST restriction on unsafe assertion/cast sites, with a reasoned local disable for an intentional dictionary. Enable unused-disable reporting so removed exceptions fail cleanly. Oxlint documents both local disables and unused-disable reporting. [Oxlint inline ignore comments](https://oxc.rs/docs/guide/usage/linter/ignore-comments.html)
4. If a temporary migration inventory is proposed later, use AST locations plus a stable fingerprint, and reject both new entries and stale entries. At minimum, store file plus normalized node text and occurrence count instead of line number. Do not make zero open-record spellings its completion condition.
5. Add checker fixtures for whitespace, multiline forms, named index parameters, comments, aliases, test-directory scope, stale entries, and duplicate occurrences.
6. State the intentional exclusions. The current script ignores tests, evals, scripts, and spikes, so the policy is not repository-wide.
7. If a custom Oxlint JavaScript rule is chosen, record that the plugin API is alpha and cannot provide type-aware analysis today. [Oxlint JavaScript plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins)

### P2: the Notion schema conflates three provider objects

[`notionObjectSchema`](../../packages/integrations/src/notion/client.ts) represents search hits, pages, and blocks in one loose schema. Those objects do not share one useful read projection:

- Search and page code reads `id`, `object`, `url`, `last_edited_time`, `title`, and `properties`.
- Block rendering reads `type` and then a dynamic payload at `block[type]`.
- A Notion block has a top-level `type` and a type-specific property. The official block object does not promise a top-level page `url`. [Notion block object](https://developers.notion.com/reference/block)

The current schema keeps unknown keys only because block rendering later indexes the dynamic type key. That need makes every search hit and page loose too. This is conflation: one consumer's dynamic field weakens two unrelated consumers.

The stable-looking fields do not currently validate their claimed provider types: `id`, `object`, `url`, `last_edited_time`, and `type` use `z.unknown()`. With the Zod 4.3.6 missing-key behavior noted above, they also do not prove key presence at runtime. The schema gives TypeScript required property names without establishing those properties at the boundary.

The title fallback is inconsistent. A malformed top-level `title` becomes `[]` through `.catch([])`, while a malformed nested page-property `title` can fail the complete Notion object and then the complete list response. The same best-effort title feature should not have two unrelated failure policies.

Split it into endpoint projections:

- A search-result schema for search output.
- A page schema for page reads and page-create responses.
- A block schema that deliberately keeps the type-specific payload, followed by `textPayloadSchema.safeParse` at that dynamic key.
- A list-envelope schema factory, or separate named envelopes, if shared pagination fields are useful.

Notion documents block children as a paginated list of block objects, and it documents that a response can contain fewer than `page_size`. This supports a block-specific result schema rather than an omnibus object. [Notion retrieve block children](https://developers.notion.com/reference/get-block-children)

The Notion version header is correctly pinned. Keep the schemas aligned with that pinned version. Notion reserves new versions for breaking changes, but it can add response fields without a new version, so strip unknown response fields unless one consumer truly needs them. [Notion API versioning](https://developers.notion.com/reference/versioning)

### P2: Gmail compatibility and current state were fused

[`gmailWatchStateSchema`](../../packages/integrations/src/google/watch.ts) makes `installedAt` optional "so legacy rows still parse." Readiness does not consume this schema or `GmailWatchState`; it independently reads raw metadata and requires `baselineHistoryId` plus `installedAt`. The renewal path parses `GmailWatchState` and needs `topic`, `expiresAt`, and the baseline. These are two projections over the same stored object, but the new exported type merges their concerns and does not make their coordination inevitable.

The scalable shape separates them:

- Define the stored watch shape once at the package boundary that both consumers can use, or define two projections whose distinct required fields are explicit.
- A persisted-input schema accepts the supported legacy versions.
- A normalization step returns one current install/status output, or an explicit legacy/incomplete state.
- If an incomplete legacy row cannot be normalized honestly, the reader returns `null` or a named non-ready result instead of silently weakening the current output.
- Add a change probe for a future required watch field: renewal and readiness must either share the new invariant or remain intentionally independent without one path making old rows disappear by accident.

Repository history resolves the immediate compatibility question: `GmailWatchState` introduced `installedAt` as required in the same change that introduced the stored watch object, and the writer populated it from the start. There is no supported stored version without it. The revised landing can therefore require the full current state, return `null` for incomplete rows, and make readiness use the same parser. [Initial Gmail watch state](https://github.com/99Yash/alfred/blob/877ca618/packages/integrations/src/google/watch.ts#L26-L38)

Also, `expiresAt` and `installedAt` are documented as ISO timestamps, but the schema checks only `string`. Use the repository's time contract or `z.iso.datetime()` at this owning boundary. [Zod ISO datetimes](https://zod.dev/api#iso-datetimes)

`credentialWatchMetadataSchema.passthrough()` is not needed for this read. A normal `z.object` will ignore unrelated credential metadata without exposing it in the parsed result. The SQL update already preserves unrelated metadata through JSONB merge; schema passthrough does not provide that preservation.

### P2: the trajectory helper rebuilds an existing boundary read

The trajectory metadata helper reads one top-level string from `unknown`. The repository already assigns that job to `getStringPath` in `@alfred/contracts`; the root instructions name it as the canonical helper for nested reads from unknown/JSON. A new one-field Zod schema creates a second door for the same operation and reparses it for every span.

Use `getStringPath(metadata, "toolCallId")` unless this metadata acquires a real multi-field contract. If a schema remains, `.passthrough()` has no value because no caller uses or re-emits the other keys.

### P3: read projections retain unknown keys without a consumer

The authored-brief reader, Gmail credential reader, and trajectory reader use `.passthrough()`, but each helper returns or consumes only declared fields. Zod's normal object mode already accepts additive source fields and strips them. [Zod object schemas](https://zod.dev/api#objects)

Remove passthrough from these projection schemas unless a caller must re-emit the unknown keys. This keeps `z.infer` narrow and prevents later code from silently depending on unvalidated data.

### P3: outbound-only schemas need a clear purpose

`notionSearchBodySchema` and `paragraphBlockSchema` currently provide inferred types, but the code does not parse the constructed request bodies with them. This is not unsafe by itself; the values are authored locally and TypeScript checks them. However, the names suggest a runtime wire boundary that does not exist.

Choose one explicit role:

- If these are construction types only, use a named local type or a `satisfies` check at construction.
- If the module promises runtime validation before the provider call, parse at that boundary.
- If one schema must own both construction and validation, keep `z.infer`, but test the schema and actually use it at the boundary where the promise matters.

The distinction matters because Zod's input and output types can differ after defaults, catches, coercion, or transforms. `z.infer` is the output type. [Zod basic usage](https://zod.dev/basics#inferring-types)

## What is good in the direction

- Provider, telemetry, and persisted JSON are now received as `unknown` at the read helper instead of being asserted with `as`.
- The Notion response still enters through `notionFetch(): Promise<unknown>` and is parsed by the caller that owns the response shape.
- Runtime response types that have an owning schema are derived with `z.infer` instead of being restated beside it.
- The exact `Record<string, any>` restriction is configured in the repository's existing linter and is part of `pnpm check`.

These are strong direction changes. They do not remove the specific failure and scaling risks above.

## Applied adjudication

The revised landing follows the research result:

- It removes the loose-record baseline and its `pnpm check` hook.
- It derives authored-run policy fields from `workflowRevisionDefinitionSchema`, parses once, and throws on malformed present policy instead of mapping it to unrestricted.
- It gives Notion search, page, created-page, and block responses separate projections. Only the block projection retains a dynamic type payload.
- It makes Gmail watch timestamps and all four current fields required, exports one metadata reader, and routes renewal plus readiness through it.
- It uses `getStringPath` for the one-field trajectory metadata read.
- It adds focused regression tests for policy failure, Gmail incomplete state, Notion additive fields, and dynamic block text.

## Scalable schema pattern

Use this decision table when later debt sites migrate:

| Situation                                       | Input                        | Schema policy                                                    | Internal output                                       |
| ----------------------------------------------- | ---------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| Provider or HTTP response projection            | `unknown`                    | `z.object` with consumed fields; strip additive fields           | `z.infer`                                             |
| Provider object with a required dynamic payload | `unknown`                    | Narrow fixed envelope plus deliberate loose/catchall payload     | `z.infer` plus a second parse of the selected payload |
| Persisted versioned object                      | `unknown`                    | Union/version parser, then normalize                             | One current output type                               |
| Closed authored object                          | Known local values           | Named type or schema-derived output; `satisfies` at construction | Closed type                                           |
| Literal-key registry                            | Known local values           | `Record<KeyUnion, Value>` plus `satisfies`                       | Exhaustive closed map                                 |
| True dynamic dictionary                         | Unknown keys, uniform values | `z.record(keySchema, valueSchema)`                               | `Record<K, V>`                                        |
| Arbitrary JSON object                           | `unknown`                    | Canonical `jsonObjectSchema`                                     | Canonical `JsonObject`                                |

The important unit is the consumer's projection, not the provider's entire object and not the storage bag. A dependency can add fields without coordinated edits because normal object parsing strips them. A breaking dependency change affects the one adapter that owns that endpoint. An unrelated malformed field cannot erase a valid policy because independent policies are not parsed as one all-or-nothing object.

## Recommended landing order

1. Fix the brief-metadata fail-open regression and parse once.
2. Split Notion search/page/block schemas by endpoint projection.
3. Separate Gmail persisted compatibility input from the current exported state; validate timestamp formats.
4. Remove passthrough from read projections that do not consume or re-emit unknown keys.
5. Remove `check:loose-record-types` and the shrink-to-zero baseline from this landing. Replace the goal with semantics-based unsafe-use enforcement or review.
6. Add focused tests for malformed sibling metadata, incomplete Gmail rows, Notion additive fields, and Notion block payloads.
7. Retain the hard `Record<string, any>` Oxlint ban. Adopt semantics-based unsafe-use review; do not adopt a ban on intentional open dictionaries.

## Sources

- [TypeScript utility types](https://www.typescriptlang.org/docs/handbook/utility-types.html)
- [TypeScript handbook: object types and index signatures](https://www.typescriptlang.org/docs/handbook/2/objects.html#index-signatures)
- [TypeScript 3.0: `unknown`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-0.html#new-unknown-top-type)
- [TypeScript 4.1: checked indexed access](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-1.html#checked-indexed-accesses---nouncheckedindexedaccess)
- [TypeScript 4.9: `satisfies`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)
- [Zod basic usage](https://zod.dev/basics)
- [Zod schema API](https://zod.dev/api)
- [Zod 4 migration guide](https://zod.dev/v4/changelog)
- [Oxlint `no-restricted-types`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-restricted-types)
- [Oxlint `no-restricted-types` source](https://github.com/oxc-project/oxc/blob/main/crates/oxc_linter/src/rules/typescript/no_restricted_types.rs)
- [Oxlint inline ignore comments](https://oxc.rs/docs/guide/usage/linter/ignore-comments.html)
- [Oxlint JavaScript plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins)
- [Drizzle PostgreSQL JSON/JSONB columns](https://orm.drizzle.team/docs/column-types/pg#jsonb)
- [Notion API versioning](https://developers.notion.com/reference/versioning)
- [Notion block object](https://developers.notion.com/reference/block)
- [Notion retrieve block children](https://developers.notion.com/reference/get-block-children)
