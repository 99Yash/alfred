---
id: one-owning-schema-per-shared-shape
section: Types
status: stays-review
rung: none
---

# Give a shape that two packages share one owning schema.

Consumers derive with `.pick`, `.omit` or `.extend`. A producer pins its return type to the owner.

Why: a field renamed by the producer then fails `tsc` and does not drop from the client. Example: `readIntegrationStatus` in `packages/assistant/src/connections/availability.ts`.

## Bad

```ts
// server: the return type is inferred from the object literal
export async function readIntegrationStatus(userId: string) {
  return { integrations, alerts };
}

// web: a second copy of the same shape
interface IntegrationStatusResponse { integrations: IntegrationMap; alerts: Alert[] }
```

## Good

```ts
// @alfred/contracts owns the schema; the server and the web read the same type
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

export async function readIntegrationStatus(userId: string): Promise<IntegrationStatus> {
```

## Mechanism

A correct derive depends on column traps and on intentional reshapes such as `Synced*`. A checker cannot separate a reshape from drift. `pnpm schemas:dupes` stays a discovery aid.

## Hits
