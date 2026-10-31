---
id: centralize-only-when-copies-change-together
section: Constants and ownership
status: stays-review
rung: none
---

# Centralize duplicated logic only when the copies change together.

Leave a similar shape that changes on its own.

Why: a wrong merge couples two concepts. Example: `parseEmailAddress` in `@alfred/contracts`.

## Bad

```ts
// the Gmail ingestor and the self-mail backfill each hold a copy
function parseEmailAddress(value: string | null): string | null {
  if (!value) return null;
  const raw = (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
  return raw.includes("@") ? raw : null;
}
```

Both copies decide which mail is self-authored, so a fix to one must reach the other.

## Good

```ts
import { parseEmailAddress } from "@alfred/contracts";
```

## Mechanism

`check:duplicates` finds copies. Whether they change together is judgment.

## Hits
