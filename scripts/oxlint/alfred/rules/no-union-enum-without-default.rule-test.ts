import { RuleTester } from "oxlint/plugins-dev";

import { noUnionEnumWithoutDefaultRule } from "./no-union-enum-without-default.ts";

// The spec of `no-union-enum-without-default` (item 51: a `t.UnionEnum` with no
// option fills a missing field with its first member, and a decision POST with
// no `decision` reached the handler as `"approve"`).
//
// `pnpm check:oxlint-plugin` runs this file, and it drives every `invalid` case
// without a `filename` through the root `.oxlintrc.json`.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const missingDefault = () => ({ messageId: "missingDefault" });

tester.run("alfred/no-union-enum-without-default", noUnionEnumWithoutDefaultRule, {
  valid: [
    {
      name: "a union enum with default undefined",
      filename: "packages/http/src/me.ts",
      code: "sortField: t.Optional(t.UnionEnum(usageSortFieldValues, { default: undefined }))",
    },
    {
      name: "the decision tuple with default undefined",
      filename: "packages/http/src/approvals.ts",
      code: "decision: t.UnionEnum(DECISIONS, { default: undefined })",
    },
    {
      name: "a default key among other options",
      code: "t.UnionEnum(VALUES, { default: undefined, description: 'pick one' })",
    },
    {
      name: "a shorthand default key",
      code: "t.UnionEnum(VALUES, { default: makeDefault() })",
    },
    {
      name: "an options object spread may carry the key",
      code: "t.UnionEnum(VALUES, { ...base })",
    },
    {
      name: "a union of literals is not a union enum",
      code: "t.Union(VALUES.map((v) => t.Literal(v)))",
    },
    {
      name: "a callee that only contains the name",
      code: "myUnionEnumerator(VALUES)",
    },
  ],
  invalid: [
    {
      name: "no second argument",
      code: "t.UnionEnum(VALUES)",
      errors: [missingDefault()],
    },
    {
      name: "an empty options object",
      code: "t.UnionEnum(VALUES, {})",
      errors: [missingDefault()],
    },
    {
      name: "an options object without the key",
      filename: "packages/http/src/me.ts",
      code: "t.UnionEnum(VALUES, { description: 'pick one' })",
      errors: [missingDefault()],
    },
    {
      name: "a non-object second argument",
      code: "t.UnionEnum(VALUES, opts)",
      errors: [missingDefault()],
    },
    {
      name: "a bare union enum call",
      code: "UnionEnum(VALUES)",
      errors: [missingDefault()],
    },
    {
      name: "a computed member call",
      code: "t['UnionEnum'](VALUES)",
      errors: [missingDefault()],
    },
    {
      name: "each bare call in one file reports",
      code: "t.UnionEnum(A)\nt.UnionEnum(B, { default: undefined })\nt.UnionEnum(C, {})",
      errors: [missingDefault(), missingDefault()],
    },
  ],
});
