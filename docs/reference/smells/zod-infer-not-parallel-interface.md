---
id: zod-infer-not-parallel-interface
section: Types
status: stays-review
rung: none
---

# Give a zod-validated value the type `z.infer<typeof schema>`.

Do not write a parallel `interface`.

Why: the schema is the source of the type. Example: `SetPreferenceArgs` in `packages/assistant/src/settings/preferences.ts`.

## Bad

```ts
export const setPreferenceArgsSchema = userPreferenceInsertSchema
  .pick({ userId: true, key: true, value: true, source: true });

export interface SetPreferenceArgs {
  userId: string;
  key: string;
  value: unknown;
  source?: MemorySource;
}
```

## Good

```ts
export const setPreferenceArgsSchema = userPreferenceInsertSchema
  .pick({ userId: true, key: true, value: true, source: true });

export type SetPreferenceArgs = z.infer<typeof setPreferenceArgsSchema>;
```

## Mechanism

A correct derive depends on column traps and on intentional reshapes such as `Synced*`. A checker cannot separate a reshape from drift. `pnpm schemas:dupes` stays a discovery aid.

## Hits

- #1662 packages/contracts/src/source-identity.ts:27: SourceIdentity repeats the parser variants; an added union arm compiles without a parser arm. Derive the type from the schema.
- #1665 official-warnings/geometry.ts: the polygon ring type was written by hand beside polygonSchema
- #1672 briefings/agent/tools.ts typed the list_activity filter by hand beside its inline input schema; lift the schema and use z.infer
