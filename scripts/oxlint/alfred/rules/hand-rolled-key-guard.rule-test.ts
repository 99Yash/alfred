import { RuleTester } from "oxlint/plugins-dev";

import { handRolledKeyGuardRule } from "./hand-rolled-key-guard.ts";

// The spec of `hand-rolled-key-guard`. The first cases of each list moved here
// from `scripts/consolidation-rules.selftest.mjs`, where the rule was a regex,
// and keep their outcome, except one: a lowercase table that a same-file
// object literal binds is now a table. The other cases are the holes the regex
// left. #1516 shipped `TOOL_RISK_RANK[resolved] === undefined` as a fail-closed
// guard, and `"toString"` passed it.
//
// `pnpm check:oxlint-plugin` runs this file, and it drives every `invalid` case
// without a `filename` through the root `.oxlintrc.json`.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const ownKeyCall = () => ({ messageId: "ownKeyCall" });

const inheritedKey = () => ({ messageId: "inheritedKey" });

const RANK = `const TOOL_RISK_RANK = { no_risk: 0, low: 1, high: 2 } as const;\n`;

tester.run("alfred/hand-rolled-key-guard", handRolledKeyGuardRule, {
  valid: [
    {
      name: "the guard built once with keyGuard is the intended form",
      code: "export const isFactKey = keyGuard(FACT_ONTOLOGY);",
    },
    {
      name: "keyGuard tests its table parameter, and a parameter is not a table",
      filename: "packages/contracts/src/guards.ts",
      code: "export function keyGuard(table) { return (value) => typeof value === 'string' && Object.hasOwn(table, value); }",
    },
    {
      name: "an imported lowercase table stays outside the rule: the name is the only signal",
      code: `import { serverMutators } from "./mutators";\nexport const has = (name) => Object.prototype.hasOwnProperty.call(serverMutators, name);`,
    },
    {
      name: "a narrowing guard and then a read of the table",
      code: `${RANK}export function rank(value) { if (!isToolRiskTier(value)) return null; return TOOL_RISK_RANK[value]; }`,
    },
    {
      name: "a value read with a fallback is not a membership test",
      code: `${RANK}export const rank = (tier) => TOOL_RISK_RANK[tier] ?? 0;`,
    },
    {
      name: "a truthy read is not a membership test",
      code: `${RANK}export const rank = (tier) => (TOOL_RISK_RANK[tier] ? 1 : 0);`,
    },
    {
      name: "a static key in an in test is checked by the compiler",
      code: `export const noRoots = !("roots" in MCP_CLIENT_CAPABILITIES);`,
    },
    {
      name: "a static index is checked by the compiler",
      code: `${RANK}export const missing = TOOL_RISK_RANK["low"] === undefined;`,
    },
    {
      name: "an array const is not a table: a dynamic index is a bounds check",
      code: `const WEEKDAYS = ["mon", "tue"] as const;\nexport const past = (i) => WEEKDAYS[i] === undefined;`,
    },
    {
      name: "a Map const is not a table",
      code: `const CACHE = new Map();\nexport const miss = (key) => CACHE[key] === undefined;`,
    },
    {
      name: "an empty object literal is a mutable bag, not a closed table",
      code: `const seen = {};\nexport const fresh = (key) => seen[key] === undefined;`,
    },
    {
      name: "a lowercase const inside a function is a per-call bag, not a table",
      code: `export function advance(state, runId) { const completedRuns = { ...state.completedRuns }; return completedRuns[runId] === undefined; }`,
    },
    {
      name: "an in test on a per-call copy of an input",
      code: `export function alias(value, canonical) { const rest = { ...value }; if (!(canonical in rest)) rest[canonical] = 1; return rest; }`,
    },
    {
      name: "a lowercase let is not a table",
      code: `let tiers = { low: 1 };\nexport const miss = (key) => tiers[key] === undefined;`,
    },
    {
      name: "a lowercase local typed record is not a table",
      code: `export function kindDef(def, kind) { const kinds = def.kinds; if (!Object.prototype.hasOwnProperty.call(kinds, kind)) return null; return kinds[kind]; }`,
    },
    {
      name: "a strict null comparison is not the missing-key value",
      code: `${RANK}export const miss = (tier) => TOOL_RISK_RANK[tier] === null;`,
    },
    {
      name: "a member receiver is outside the rule",
      code: `export const miss = (kind) => REGISTRY.kinds[kind] === undefined;`,
    },
    {
      name: "a shadowed undefined is not the missing-key value",
      code: `${RANK}export function miss(tier, undefined) { return TOOL_RISK_RANK[tier] === undefined; }`,
    },
    {
      name: "a private brand check is not a key test",
      code: "class Box { #id = 1; static is(value) { return #id in value; } }",
    },
    {
      name: "the word in inside a string is not an in test",
      code: 'export const note = "the page in PDF and the run in CI";',
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a test tree is out of scope",
      filename: "packages/assistant/test/mcp/protocol-capabilities.test.ts",
      code: `export const has = (key) => key in MCP_CLIENT_CAPABILITIES;`,
    },
  ],
  invalid: [
    {
      name: "Object.hasOwn over a SCREAMING_CASE table",
      code: "export const isSenderWord = (value) => Object.hasOwn(SENDER_WORDS, value);",
      errors: [ownKeyCall()],
    },
    {
      name: "the prototype hasOwnProperty spelling of the same test",
      code: "export const isFactKey = (key) => Object.prototype.hasOwnProperty.call(FACT_ONTOLOGY, key);",
      errors: [ownKeyCall()],
    },
    {
      name: "a hasOwnProperty method call on the table",
      code: "export const isFactKey = (key) => FACT_ONTOLOGY.hasOwnProperty(key);",
      errors: [ownKeyCall()],
    },
    {
      name: "a lowercase table that a same-file object literal binds",
      code: `const serverMutators = { createTodo: () => {}, deleteTodo: () => {} } satisfies Record<string, unknown>;\nexport const isMutator = (name) => Object.prototype.hasOwnProperty.call(serverMutators, name);`,
      errors: [ownKeyCall()],
    },
    {
      name: "the #1516 shape: an index read compared with undefined",
      code: `${RANK}export function rank(resolved) { if (TOOL_RISK_RANK[resolved] === undefined) return null; return TOOL_RISK_RANK[resolved]; }`,
      errors: [inheritedKey()],
    },
    {
      name: "the negated strict form, undefined on the left",
      code: `${RANK}export const known = (tier) => undefined !== TOOL_RISK_RANK[tier];`,
      errors: [inheritedKey()],
    },
    {
      name: "a loose null comparison",
      code: `${RANK}export const known = (tier) => TOOL_RISK_RANK[tier] != null;`,
      errors: [inheritedKey()],
    },
    {
      name: "a loose undefined comparison through optional chaining",
      code: `export const miss = (tier) => TOOL_RISK_RANK?.[tier] == undefined;`,
      errors: [inheritedKey()],
    },
    {
      name: "void 0 as the missing-key value",
      code: `${RANK}export const miss = (tier) => TOOL_RISK_RANK[tier] === void 0;`,
      errors: [inheritedKey()],
    },
    {
      name: "a typeof test of an index read",
      code: `${RANK}export const miss = (tier) => typeof TOOL_RISK_RANK[tier] === "undefined";`,
      errors: [inheritedKey()],
    },
    {
      name: "an in test of a dynamic key",
      code: `${RANK}export const isTier = (value) => typeof value === "string" && value in TOOL_RISK_RANK;`,
      errors: [inheritedKey()],
    },
    {
      name: "an in test against an imported SCREAMING_CASE table",
      code: `import { SPAM_FLOOR_OUTCOMES } from "./outcomes";\nexport const listed = (row) => row.outcome in SPAM_FLOOR_OUTCOMES;`,
      errors: [inheritedKey()],
    },
    {
      name: "an in test against a frozen lowercase table",
      code: `const labels = Object.freeze({ low: "Low", high: "High" });\nexport const isLabel = (key) => key in labels;`,
      errors: [inheritedKey()],
    },
    {
      name: "a SCREAMING_CASE const inside a function is still a table",
      code: `export function isTier(value) { const RANK = { low: 1, high: 2 }; return RANK[value] !== undefined; }`,
      errors: [inheritedKey()],
    },
    {
      name: "Reflect.has is the same test as in",
      code: `${RANK}export const isTier = (value) => Reflect.has(TOOL_RISK_RANK, value);`,
      errors: [inheritedKey()],
    },
    {
      name: "each membership test in one file reports",
      code: `${RANK}export const a = (x) => x in TOOL_RISK_RANK;\nexport const b = (x) => TOOL_RISK_RANK[x] ?? 0;\nexport const c = (x) => Object.hasOwn(TOOL_RISK_RANK, x);`,
      errors: [inheritedKey(), ownKeyCall()],
    },
  ],
});
