---
id: search-prose-after-rename
section: Process
status: stays-review
rung: none
---

# When you delete, rename or move a mechanism, search the comments and docs for the words that describe it.

Search for its plain-word names too, not only its identifier. `check:doc-symbols` and `check:prose-locators` catch only a dead backticked symbol, path or specifier.

Why: a comment that names a removed mechanism still reads as true. Example: #1483 removed the bottom pin, and review found a comment in `apps/web/src/routes/-chat/tool-call-group.tsx` that still gave it as a reason. Review of #1458 found that `packages/db/src/redis.ts` still named the old owner of the subscription recovery.

## Bad

```tsx
// Inline, no capped height: the feed's stick-to-bottom keeps the current step in view.
const rail = (
```

The bottom pin is gone, so the reason is false.

## Good

```tsx
// Inline, no capped height: the anchored question holds still while the reply grows
// into the reserve below it, and a click on the pill jumps to the live end once it
// outgrows the viewport.
const rail = (
```

## Mechanism

`check:doc-symbols` and `check:prose-locators` catch a dead backticked name. A plain-word name is not a token that a check can resolve.

## Hits

- #1483 `apps/web/src/routes/-chat/tool-call-group.tsx`: a comment still gave the removed bottom pin as the reason for no capped height.
- #1458 `packages/db/src/redis.ts`: a comment still named the old owner of the subscription recovery.
