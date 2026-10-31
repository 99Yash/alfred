---
id: derive-row-type-from-table
section: Types
status: stays-review
rung: none
---

# Derive a row type from its table.

Use the named row type (`Document`) with `Pick` or `Omit`, and the `New*` insert type or `$inferInsert`.

Why: a copy drifts when a column changes. Before you derive, read "Derive row types from the table" in `docs/reference/database.md`. Example: `rowToFact` in `packages/assistant/src/knowledge/facts.ts`.

## Bad

```ts
export interface FactRow {
  id: string;
  userId: string;
  key: string;
  value: unknown;
  confidence: number;
  status: FactStatus;
  source: MemorySource;
  validFrom: Date;
}
```

## Good

```ts
/** `UserFact` with the zod-parsed `status` and `source` narrowed. */
export type FactRow = Omit<UserFact, "status" | "source"> & {
  status: FactStatus;
  source: MemorySource;
};
```

## Mechanism

A correct derive depends on column traps and on intentional reshapes such as `Synced*`. A checker cannot separate a reshape from drift. `pnpm schemas:dupes` stays a discovery aid.

## Hits
