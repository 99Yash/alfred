---
id: brand-claim-needs-probe
section: Types
status: candidate
rung: ast
feasibility: medium
issue: #1629
---

# Record a probe before you claim that only one function mints a brand, that a misuse does not compile, or that `check-types` catches a form.

Probe each form, and include the mints that need no cast: a type guard, `z.custom<Brand>()`, and `Object.assign` onto a branded value. Claim only the forms that fail.

Why: a `unique symbol` brand is only a type tag, so each expression of the brand type mints it, and no gate stops a mint with no cast. Example: the `RedactedToolInput` doc in `packages/ai/src/metering/langfuse.ts` names the forms that still compile (#1540). A draft of #1548 said that the compiler proves that no stored image part reaches the model, but a swap of two arguments of one type compiled. The local lesson is `.lessons/a-brand-only-mint-claim-is-false-*`.

## Bad

```ts
/**
 * A tool input after its tool's `redactInput` ran (#293). Only
 * `BoundToolCall.redactedInput` can mint it, so no raw input reaches a span.
 */
export type RedactedToolInput = { readonly [redactedToolInputBrand]: true };
```

## Good

```ts
/**
 * A tool input after its tool's `redactInput` ran (#293). Only
 * `BoundToolCall.redactedInput` should mint it. A raw `unknown` or `JsonValue`
 * input does not type-check at `ToolSpanInput` or `DispatchRejectionInput`.
 * A cast, a type guard, a zod custom schema, or a merge into a redacted value
 * still compiles, so review owns those.
 */
export type RedactedToolInput = { readonly [redactedToolInputBrand]: true };
```

The Good doc claims only the forms that a probe saw fail, and names the forms that still compile.

## Mechanism

The claim is prose. An AST rule that fails a type guard or a `z.custom` of a brand outside its owner module would remove the mints with no cast.

## Hits

- #1548 PR body draft: said the compiler proves that no stored image part reaches the model; a swap of two arguments of one type compiled.
- #1540 packages/ai/src/metering/langfuse.ts: the brand doc claimed a staging-row invariant that the type did not enforce; probes found a cast and a merge that compile.
