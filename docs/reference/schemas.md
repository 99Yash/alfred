# Schema placement — where runtime validators live, and how to find them

A zod schema in this repo is not validation boilerplate parked beside logic.
It is the source-of-truth type: its `z.infer` is the type every consumer
compiles against, so the schema belongs to whichever module owns that
contract. Placement therefore follows **consumer need**, not file type:

| The question that decides it                           | Home                                                        | Example                                       |
| ------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------- |
| Must browser and server agree on this shape?           | `@alfred/contracts`, split by domain file                   | `briefing.ts`, `events.ts`, `tool-schemas.ts` |
| Is this a synced Replicache read model or mutator arg? | `@alfred/sync` (`src/schemas.ts` holds the shared registry) | `syncedNoteSchema`, `factValueSchema`         |
| Is this a provider's wire shape?                       | The owning integration client                               | `google/gmail.ts`, `notion/oauth.ts`          |
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
  (#466), and the later `system.search_context` tool (#426) must all agree on
  it. A provisional/internal shape stays with its owning module file until a
  second boundary must agree on it; `EvidenceCard` crossed to contracts at that
  point rather than early, just as the provisional `ContextEvidence` it replaced
  stayed in `registry.ts` until then.

Deletion test: deleting the owner file must delete the shape. If the shape
survives in `types.ts` / `schemas.ts` / `constants.ts` after its logic is
gone, it was in the wrong file.

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
