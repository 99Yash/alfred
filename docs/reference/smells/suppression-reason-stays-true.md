---
id: suppression-reason-stays-true
section: Process
status: stays-review
rung: none
---

# Keep the reason of a lint suppression, a disable directive or a `SAFETY:` note true. Delete one that no longer applies.

Why: the gate checks that a reason exists, not that it is still true. The unused-directive check proves only that a directive still suppresses a report. It cannot read the reason or a plain comment.

## Bad

```ts
// The route now declares a response schema, so this reason is false.
// oxlint-disable-next-line typescript/no-unnecessary-condition -- the route has no response schema yet, so `data` can be null.
if (!data) return { kind: "failed" };
```

## Good

```ts
// oxlint-disable-next-line typescript/no-unnecessary-condition -- Eden treaty `data` is the server's JSON typed by its route, not parsed here; an empty body or a skewed deploy can leave it null.
if (!data) return { kind: "failed" };
```

When the reason stops being true, change the reason or delete the directive.

## Mechanism

A check cannot read whether a reason is still true. The unused-directive check reads whether a directive suppresses a report, not its reason text.

## Hits
