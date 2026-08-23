# PR #738 scope narrowing

Research date: 2026-08-10

## Decision

The direction of [PR #738](https://github.com/99Yash/alfred/pull/738) is sound, but the current PR is not one coherent change. Narrow it before merge.

Drop commit `1137e556` (the repository-wide `UnknownRecord` rename and the `Record<string, unknown>` ban). Split commit `e9ce86bb` by owning boundary. The smallest useful first PR is the action-staging JSON boundary. Put the GitHub webhook projection, Replicache types, Drizzle update patches, and other JSON-object columns in separate PRs.

## Implemented result

The rebuilt branch keeps two related runtime boundaries:

- The action-staging flow validates JSON before persistence and applies the same result normalization to staged and direct execution.
- The preference contract accepts only JSON-safe values before Replicache synchronization.

Focused tests cover `undefined`, functions, `Date`, `BigInt`, and cyclic values where they can enter these boundaries. The branch does not include the repository-wide `UnknownRecord` migration, the lint ban, the GitHub webhook projection, the Drizzle update-patch refactors, or unproven `JsonObject` column annotations.

## The lint rule contradicts its stated guarantee

TypeScript defines `Record<Keys, Type>` as an object type whose keys are `Keys` and whose values are `Type`. An index signature is the matching language feature for keys that are not known in advance. [`UnknownRecord` in this PR](../../packages/contracts/src/guards.ts) is only a named string index signature, so it does not narrow the value beyond `Record<string, unknown>`. [TypeScript `Record`](https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type) [TypeScript index signatures](https://www.typescriptlang.org/docs/handbook/2/objects.html#index-signatures)

Oxlint's `no-restricted-types` rule bans configured type names. For a configured complex type, its implementation compares the written source form. It does not prove a semantic property of the resolved type. [Oxlint rule documentation](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-restricted-types) [Oxlint rule source](https://github.com/oxc-project/oxc/blob/main/crates/oxc_linter/src/rules/typescript/no_restricted_types.rs#L243-L380)

The result is a contradiction:

- The message says code must choose `JsonObject` for validated JSON or `UnknownRecord` for unvalidated structure.
- `UnknownRecord` is structurally the same open unknown-valued object that the rule bans under another spelling.
- The second commit changes 76 files, but almost all changes are erased type imports and spelling changes. It creates no runtime validation.
- The rule can still be bypassed with another alias or a direct index signature.

Keep the existing `Record<string, any>` ban. Do not ban every direct `Record<string, unknown>` spelling. Review whether the value is a known object, an actual dynamic dictionary, JSON, or untrusted input. This matches the earlier repository research in [`narrow-record-types-2026-08-09.md`](./narrow-record-types-2026-08-09.md).

## Drizzle types are useful, but they are not validation

Drizzle states that `jsonb(...).$type<T>()` changes inference and gives compile-time protection for defaults, inserts, and selects, but it does not check runtime values. [Drizzle PostgreSQL column types](https://orm.drizzle.team/docs/column-types/pg#jsonb)

PostgreSQL guarantees that a `jsonb` value is valid JSON. It does not guarantee that the top-level value is an object: scalars, arrays, and objects are all valid `jsonb`. [PostgreSQL JSON types](https://www.postgresql.org/docs/current/datatype-json.html#DATATYPE-JSON-INPUT-OUTPUT)

This gives three distinct guarantees:

| Shape                                                    | Guarantee                                                  | Runtime-safe claim                                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jsonb(...).$type<JsonValue>()`                          | Compile-time writes and reads use Alfred's JSON-value type | The database value is JSON, but Drizzle did not validate the inferred TypeScript type                                                                            |
| `jsonb(...).$type<JsonObject>()`                         | Compile-time writes and reads use an object type           | The database can still contain a scalar or array unless a parser or database constraint proves an object                                                         |
| `jsonValueSchema.parse(x)` / `jsonObjectSchema.parse(x)` | The value passed this runtime check                        | The returned value has the schema's runtime shape; `z.infer` can be derived from that schema [Zod parsing and inference](https://zod.dev/basics#inferring-types) |

Therefore, the new `JsonValue` column types are useful compile-time pressure. The new `JsonObject` column types are only honest when every writer is typed and persisted reads are trusted by an explicit storage invariant, or when the owner parses reads. In particular, [`object-state/store.ts`](../../packages/assistant/src/connections/object-state/store.ts) must not remove `toRecord(existing.attributes)` only because [`integration-objects.ts`](../../packages/db/src/schema/integration-objects.ts) adds `.$type<JsonObject>()`. That replacement removes a runtime guard based on a compile-time annotation.

The two Drizzle update-patch changes are sound. `PgUpdateSetSource<T>` is the exact type accepted by `.set()`. Drizzle derives its keys from `TTable['$inferInsert']` and also permits SQL expressions, which is required for `rowVersion = rowVersion + 1`. [Drizzle update source](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/pg-core/query-builders/update.ts#L35-L48)

## What creates runtime safety in this PR

The following changes create or consolidate runtime checks:

- The action-staging path parses proposed, edited, failed, and executed values with the canonical JSON schemas before or at persistence.
- The GitHub reducer uses one Zod projection and derives its internal type with `z.infer`. `safeParse` returns a discriminated success-or-error result, and normal `z.object` parsing strips fields that the reducer does not own. [Zod `safeParse`](https://zod.dev/basics#handling-errors) [Zod object behavior](https://zod.dev/api#objects)
- The preference subscriber already parses each row with `syncedPreferenceSchema`; narrowing its map from `unknown` to `PreferenceValue` then reflects a runtime check.

The following changes do not create runtime safety:

- `UnknownRecord` imports and renames.
- `JsonObject` or `JsonValue` annotations by themselves.
- `.$type<T>()` by itself.
- `PgUpdateSetSource`, `SyncedEntity`, or `PreferenceValue` annotations by themselves.

The rebuilt action-staging change makes this behavior explicit. [`dispatch/index.ts`](../../packages/api/src/modules/dispatch/index.ts) sends both staged and direct tool results through `toJsonValue`. Focused tests now cover `Date`, `BigInt`, cycles, functions, and `undefined` members. Both paths therefore use one normalization policy before their results cross the JSON boundary.

## Provider and protocol types do not replace the local runtime projection

GitHub documents the `pull_request` webhook payload and actions. Octokit's generated webhook package supplies full static payload types, and its schema package supplies a full JSON Schema that can be used with Ajv. [GitHub webhook payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request) [Octokit webhook types](https://github.com/octokit/webhooks/tree/main/payload-types) [Octokit webhook schemas](https://github.com/octokit/webhooks/tree/main/payload-schemas)

Neither option makes this small reducer projection unnecessary. A type-only Octokit import does not validate `JSON.parse` output. Full-payload JSON Schema validation is broader and heavier than the six fields this reducer consumes. Keep the small Zod projection in its own PR. Rename its comment from “provider-owned” to “application-owned projection of the provider payload.”

Replicache's `put` patch value is `ReadonlyJSONValue`; the official patch type is available as `PatchOperation`. [Replicache `PatchOperation`](https://doc.replicache.dev/api/type-aliases/PatchOperation) [Replicache `JSONValue`](https://doc.replicache.dev/api/type-aliases/JSONValue)

`SyncedEntity` is a useful Alfred domain union, but it is not a replacement for protocol conformance. Before the rebuild, `preferenceValueSchema` accepted `z.array(z.unknown())`; a local probe confirmed that arrays containing `undefined`, `Date`, or a function passed that schema. The rebuilt branch replaces it with `z.array(jsonValueSchema)` and adds focused rejection tests. The Replicache projection can therefore use the validated `PreferenceValue` type without relying on a cast for safety.

## Smallest coherent split

1. **Action-staging JSON boundary.** Keep the `action_stagings` `JsonValue` column types and the owning writers/readers in dispatch, approvals, activation, and notification. Resolve staged-versus-fast normalization and add edge-case tests. This is the first PR because it removes unsafe persistence casts and adds runtime checks around one state machine.
2. **GitHub reducer projection.** Keep the Zod projection and reducer tests only. It is independent of persisted JSON typing.
3. **Drizzle-derived local shapes.** Land the two `PgUpdateSetSource` changes and the Replicache preference/map types as small compile-time refactors. Keep Replicache protocol hardening separate if it changes the preference schema.
4. **One JSON-object owner per PR.** Handle run metadata, credential metadata, notifications, drift details, and integration-object attributes separately. Each PR must name its writer and read parser or its database invariant. Do not remove a runtime guard because of `.$type<JsonObject>()`.
5. **No repository-wide `UnknownRecord` migration.** Keep `UnknownRecord` only if the guard return type name improves local documentation. Do not use a global spelling ban as the completion metric.

This split reduces reviewer load and makes each PR's claim testable: compile-time ownership, runtime validation, or protocol conformance. It also avoids describing a type-only rename as persistence hardening.
