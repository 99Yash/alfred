---
id: brand-claim-needs-probe
section: Types
status: stays-review
rung: none
---

# Record a probe before you claim that only one function mints a brand, that a misuse does not compile, or that `check-types` catches a form.

Probe each form, and include the mints that need no cast: a type guard, `z.custom<Brand>()`, and `Object.assign` onto a branded value. Claim only the forms that fail.

Why: a `unique symbol` brand is only a type tag, so each expression of the brand type mints it. `alfred/no-brand-mint-outside-owner` fails a type guard or a `z.custom` of a brand outside its owner file. No gate stops a cast, a merge, or a mint in the owner file. Example: the `RedactedToolInput` doc in `packages/ai/src/metering/langfuse.ts` names the forms that still compile (#1540). A draft of #1548 said that the compiler proves that no stored image part reaches the model, but a swap of two arguments of one type compiled. The local lesson is `.lessons/a-brand-only-mint-claim-is-false-*`.

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

The claim is prose, so no check can separate the Bad doc from the Good doc. Both recorded hits are forms that no syntax rule sees: a swap of two arguments of one type (#1548), and a cast and a merge (#1540). Review keeps this smell.

The AST rule `alfred/no-brand-mint-outside-owner` closes a part of the gap. It fails a type guard (`x is Brand`, `asserts x is Brand`) or a `custom<Brand>()` call outside the owner file of the brand. The rule has no type information, so a closed `BRANDS` table in the rule names each brand type and its owner file. The rule also fails a `unique symbol` brand that `BRANDS` does not list with its file. Thus a new or a renamed brand fails lint until someone adds it. A brand doc can therefore claim that a guard or a `z.custom` outside the owner fails `pnpm lint`. It cannot claim that the compiler rejects them.

The rule reports these shapes that do not mint (false positives):

- A guard whose minted type holds the brand only in a function parameter, such as `x is Handler` with `type Handler = (zone: IanaTimezone) => void`. The rule does not read variance. Give the guard a disable comment with its reason.
- An imported type of another package that has the same name as a brand.

The rule does not see these mints (false negatives):

- A cast (`as Brand`), a merge into a branded value (`Object.assign(branded, { raw })`), and the branded value of another call.
- A type of another file that holds a brand field, such as `x is ReceiptRow` when `ReceiptRow` has a `LocalDateKey` field. The rule follows only the aliases and interfaces of the same file.
- A guard that narrows from a type that already names the brand, such as `(v: string | LocalDateKey): v is LocalDateKey`. The rule skips it, so that `isPassthroughToolArgs` in `packages/assistant/src/tool-runtime/internal/registry.ts` stays clean.
- An overload signature that returns the brand, and a type argument to a generic guard (`isType<Brand>(x)`).
- A zod `.brand<"X">()` brand. Its parse is its mint, and the rule reads only `unique symbol` brands.
- A mint in a test file. The rule keeps the scope of the consolidation gate (`inGateScope`).

## Hits

- #1548 PR body draft: said the compiler proves that no stored image part reaches the model; a swap of two arguments of one type compiled.
- #1540 packages/ai/src/metering/langfuse.ts: the brand doc claimed a staging-row invariant that the type did not enforce; probes found a cast and a merge that compile.
