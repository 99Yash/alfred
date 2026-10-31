---
id: literal-type-only-for-new-concept
section: Types
status: stays-review
rung: none
---

# Keep a literal type only when it is a different concept, and say why in one comment.

A wire reshape is the usual case.

Why: the next reviewer otherwise collapses it to the row type. Example: the `Synced*` read models in `packages/sync/src/schemas.ts`.

## Bad

```ts
export const syncedFactSchema = z.object({
  id: z.string(),
  key: z.string(),
  validFrom: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});
```

The schema restates `UserFact` and gives no reason. A reviewer then replaces it with the row type, and the wire dates break.

## Good

```ts
/** The Replicache wire shape of a fact, not `UserFact`: each date is an ISO string. */
export const syncedFactSchema = z.object({
  id: z.string(),
  key: z.string(),
  validFrom: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});
```

## Mechanism

A check cannot tell an intentional reshape from drift. A literal type that copies a row type can be a wire reshape or a stale copy, and only the comment says which.

## Hits
