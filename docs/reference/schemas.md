# Schema placement — where runtime validators live, and how to find them

A zod schema in this repo is not validation boilerplate parked beside logic.
It is the source-of-truth type: its `z.infer` is the type every consumer
compiles against, so the schema belongs to whichever module owns that
contract. Placement therefore follows **consumer need**, not file type:

| The question that decides it                           | Home                                                        | Example                                       |
| ------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------- |
| Must browser and server agree on this shape?           | `@alfred/contracts`, split by domain file                   | `briefing.ts`, `events.ts`, `tool-schemas.ts` |
| Is this a synced Replicache read model or mutator arg? | `@alfred/sync` (`src/schemas.ts` holds the shared registry) | `syncedNoteSchema`, `factValueSchema`         |
| Is this a provider's wire shape?                       | The owning integration client                               | `google/gmail.ts`, `vercel/oauth.ts`          |
| Does code look schemas up by name across features?     | A registry table next to the dispatcher                     | `TOOL_INPUT_SCHEMAS`                          |
| None of these - one feature parses one payload         | Colocate with the parser that owns the boundary             | `valueRangeSchema` in `sheets.ts`             |

Do not introduce a per-package grab-bag `schemas.ts`. Grouping by syntax
("it is a zod schema") instead of by domain recreates the junk-drawer problem:
no front door, high-traffic merges, and contract split from owner. A package
level schema module is earned by a registry need (that is why sync has one),
never by convention.

## Colocate the schema with its type, caps, and minting logic

A boundary shape has one home file, and everything that co-changes with it
lives there:

- The schema, its `z.infer` type, and the caps/constants its bounds enforce
  stay together in the owning domain file (`contextSearchRequestSchema` with
  `ContextSearchRequest` and `CONTEXT_SEARCH_DEFAULT_LIMIT` /
  `CONTEXT_SEARCH_MAX_LIMIT` in `packages/contracts/src/context-search.ts`;
  the model is `briefing-constants.ts`: `briefingHourSchema` with
  `BriefingHour` and its 0–23 bounds). Do not split the schema into
  `schemas.ts`, the type into `types.ts`, and the caps into `constants.ts` —
  that is the same junk drawer in three files, and a cap change then touches
  three owners instead of one.
- The result a verb mints lives with that verb. `searchContext` in
  `packages/assistant/src/context-search/search.ts` owns `ContextSearchResult`
  and the `ContextSourceReport` / `ContextSourceStatus` it constructs;
  `registry.ts` owns the `ContextSource` contract (returning the shared
  `EvidenceCard`) because it stores `Map<string, ContextSource>`. A shared
  `types.ts` holding all of those shapes groups by syntax instead of by owner
  and hides which file may change which shape.
- The evidence element is a shared contract, not a module-internal shape:
  `evidenceCardSchema` / `EvidenceCard` live in
  `packages/contracts/src/evidence-card.ts` (#423) because source adapters, the
  model-facing packer (`context-search/pack.ts`), the source capability manifest
  (#466), and the `system.search_context` tool (#426) must all agree on
  it. A provisional/internal shape stays with its owning module file until a
  second boundary must agree on it; `EvidenceCard` crossed to contracts at that
  point rather than early, just as the provisional `ContextEvidence` it replaced
  stayed in `registry.ts` until then.

- The same split separates a shape's MEANING from a reader's JUDGEMENT.
  `sourceManifestSchema` / `SourceManifest` live in
  `packages/contracts/src/source-manifest.ts` (#466) with their enums
  (`SOURCE_READ_CAPABILITIES`, `SOURCE_COST_CLASSES`, ...) and their
  fact-level helpers (`sourceManifestDisplayName`,
  `sourceManifestSupportsRead`, `declaresReadSemantics`), because the server
  boundary reads the shape today and a future web catalog reads the same shape
  without a move. The ranking WEIGHTS that fold a manifest into a number stay in
  `context-search/rank.ts`, the selection policy and the trust predicate
  (`isTrustedRetrievalSource`) stay in `context-search/manifest.ts`: those are
  decisions about a manifest, not facts about one, and putting them in contracts
  would make every consumer inherit one reader's opinion. The trust predicate
  stays there until a second reader across a boundary (a web catalog) must
  agree on it.

Deletion test: deleting the owner file must delete the shape. If the shape
survives in `types.ts` / `schemas.ts` / `constants.ts` after its logic is
gone, it was in the wrong file.

## One owner, consumers derive

A shape that two packages must agree on has one owning schema. A browser-safe shape lives in `@alfred/contracts`.

- A variant comes from `.pick()`, `.omit()` or `.extend()` on the owner. Do not restate a `z.object`.
- A producer pins itself to the owner at compile time. Return the `z.infer` type of the owner from the function that builds the body, or annotate with `satisfies z.ZodType<...>`. `readIntegrationStatus` in `packages/assistant/src/connections/availability.ts` returns `IntegrationStatus` from `packages/contracts/src/integration-status.ts`. A field renamed by the producer then fails `tsc`.
- A narrower local projection that reshapes for the UI is correct. It derives from the owner and says so in a comment.
- A literal type is correct when it is deliberately not the source shape. The `Synced*` read models pick, rename and re-type columns for the client. Keep that divergence, and say in one comment why the type is not derived.

Compile-time pins carry this rule, not a lint script. A generic copy checker cannot separate a correct projection from drift.

## Derive a runtime schema from a table

When a runtime boundary validates the same select, insert or update shape as a Drizzle table, derive the base validator from the table with `drizzle-zod`.

```ts
// packages/db/src/schema/memory.ts
export const userPreferenceInsertSchema = createInsertSchema(userPreferences, {
  source: memorySourceSchema.optional(),
});

// packages/assistant/src/settings/preferences.ts
export const setPreferenceArgsSchema = userPreferenceInsertSchema
  .pick({ userId: true, key: true, value: true, source: true })
  .extend({ key: z.string().min(1).max(200) });
```

- Drizzle owns the column presence, the nullability and the database defaults.
- Refine scalar business rules at the boundary (`min`, `max`, formats).
- Override a `jsonb` field with its contract-owned zod schema. `.$type<T>()` informs TypeScript but does not validate at runtime.
- When one `jsonb` column holds a different shape per row kind, `$type` the union of the arms' `z.input` types and read through the arm the discriminator column selects. `documents.metadata` is the example: `$type<DocumentMetadataInput>()`, read with `parseDocumentMetadata({ source, metadata })`, or with `parseGmailDocumentMetadata` / `parseGmailAttachmentMetadata` when the source is fixed (most readers). Each arm brands its output with its own literal, so an unparsed column value — or a value parsed for the wrong arm — does not type-check where a parsed arm is required. Raw SQL `||` merges write the column with no parse, so a reader must parse.
- When writers merge keys into a jsonb column over time (`jsonb_set`, `||`), read it with `parsePersistedMetadata(schema, raw)`: a bad key reads as absent and the rest of the row survives. The owners are `parseGmailIngestionState` (`ingestion_state.state`, which keeps no `$type`: the column is per `(credentialId, stream)` and a raw SQL `jsonb_set` writer merges keys, so only the parse proves the shape) and `parseGoogleCredentialMetadata` / `readVercelTeamId` (`integration_credentials.metadata`, which keeps the wide `$type<JsonObject>` because each reader knows its provider).
- `agent_runs.metadata` holds one shape per `workflow_slug` and is written once, never merged: one lenient per-key reader per workflow (`readChatTurnRunMetadata`, `readChatMemoryCaptureRunMetadata`, the existing `readSubAgentMetadata`), and no `$type` because many workflows share the column.
- Gmail `documents.raw` holds one shape per `source` and the ingest writer stores the full message: read it with `parseStoredGmailMessage`, which is all-or-nothing and returns `null` for a row it rejects (a bad field does not read as absent; the whole row falls back).
- A writer checks its literal against the schema's `z.input` (`satisfies`, a return-type annotation, or the Drizzle `$type`). Exception: the Google connect writer stores a plain `JsonObject` literal, because `upsertCredential` takes `JsonObject` for every provider.
- Do not generate a wire DTO or a Replicache model from a table because the fields overlap. Those schemas reshape, redact, rename or serialize rows on purpose, and they stay contracts with explicit mappers.
- A generated select schema describes a complete row. For a partial query projection, derive a matching `.pick(...)` or validate the owning DTO.

## Finding schemas

[`pnpm schemas`](../../scripts/schema-catalog.mjs) prints every schema binding
per package and file, marking non-exported ones:

```sh
pnpm schemas                 # catalog, grouped by package
pnpm schemas --package=sync  # one package
pnpm schemas --dupes         # identical object shapes under different names
```

The scanner counts `const NAME = z.<method>(...)` bindings (annotations
allowed) plus compositions off known bases (`.extend`, `.omit`, ...). It is a
discovery aid with conservative detection, not a gate: absence from its output
is "not detected", never proof of absence.

## Naming

Exported boundary schemas end in `Schema`; registries pluralize
(`...Schemas`). Keep the name derived from the domain role
(`integrationSlugSchema`) rather than from the mechanics of the parse chain -
the name should say what the shape means, not how it was built.

## Effect Schema

Adopting `effect/Schema` was considered and declined for now. Zod 4 already
provides native JSON Schema generation and the Standard Schema interface, the
tree carries 100+ zod-importing files, and Effect Schema's distinctive payoffs
(codecs as values, typed error channels) compound only inside Effect's
runtime, which this repo deliberately skipped for errors. The one transferable
idea worth stealing incrementally is schema-level branding: prefer
`z.string().refine(...).brand("Iana")` over hand-minted branded casts when a
parse seam exists, so the validator mints the brand instead of an assertion.

Revisit only if a concrete driver appears - measured web-bundle pressure from
zod, a second consumer needing Standard Schema at boundaries, or adoption of
Effect-the-runtime itself.

ADR-0114 adopts Effect-the-runtime in one file only (the MCP connection
manager). That file parses no external data, so it does not fire this trigger.
A second Effect module with a parse boundary would.
