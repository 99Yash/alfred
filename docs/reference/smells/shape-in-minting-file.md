---
id: shape-in-minting-file
section: Types
status: stays-review
rung: none
---

# Put a shape in the file that mints or stores it.

Do not make a `types.ts`, `schemas.ts` or per-package `schemas/` folder.

Why: a grab-bag file groups by syntax and hides the owner. See "Colocate the schema with its type, caps, and minting logic" in `docs/reference/schemas.md`.

## Bad

```ts
// packages/mailer/src/types.ts
export interface ComposedEmail {
  subject: string;
  html: string;
  text: string;
}
```

## Good

```ts
// packages/assistant/src/delivery/notify.ts, next to the transport that takes it
export type ComposedEmail = Pick<NotifyArgs, "subject" | "html" | "text">;
```

The move came in #1118, which removed the per-module `types.ts` files.

## Mechanism

Placement follows ownership, not file type. A file-exists gate or a literal ban fires on correct code.

## Hits
