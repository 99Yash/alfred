---
id: check-dts-before-library-claim
section: Types
status: stays-review
rung: none
---

# Check the `.d.ts` file or the library source before you say a library cannot do something.

Why: most limits are an option that nobody found. See `docs/reference/typescript.md`.

## Bad

```text
Zod cannot keep unknown keys on an object schema, so the parser
parses the value and then merges the raw input back on top.
```

## Good

```text
zod 4 declares `looseObject` in its .d.ts: an object schema that keeps
unknown keys. The parser uses it, and the merge goes away.
```

## Mechanism

Not a fact in the code.

## Hits
