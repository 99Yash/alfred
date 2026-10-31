import { RuleTester } from "oxlint/plugins-dev";

import { noNeverSentinelBindingRule } from "./no-never-sentinel-binding.ts";

// The spec of `no-never-sentinel-binding`: a `never` binding in a `switch`
// clause compiles for any use, so a runtime value that reaches the clause can
// leave the function as a valid result (PRs #1566, #1547, #701, #676, #1219).
// The Bad and Good cases come from docs/reference/smells/never-sentinel-escape.md.
//
// `pnpm check:oxlint-plugin` drives each `invalid` case through the root
// `.oxlintrc.json`. A bare `filename` such as `probe.ts` names only the
// language and keeps the case inside the gate scope.

const tester = new RuleTester();

const neverBinding = () => ({ messageId: "neverBinding" });

tester.run("alfred/no-never-sentinel-binding", noNeverSentinelBindingRule, {
  valid: [
    {
      name: "assertNever in the default (the smell's Good case)",
      filename: "probe.ts",
      code: 'function f(s: "a" | "b") { switch (s) { case "a": return 1; case "b": return 2; default: return assertNever(s, "s"); } }',
    },
    {
      name: "a real value in the default",
      filename: "probe.ts",
      code: 'function f(s: "a" | "b") { switch (s) { case "a": return 1; default: return 0; } }',
    },
    {
      name: "a never binding outside a switch",
      filename: "probe.ts",
      code: "function f(s: never) { const x: never = s; return x; }",
    },
    {
      name: "a binding with another type in a default",
      filename: "probe.ts",
      code: "function f(s: string) { switch (s) { default: { const x: string = s; return x; } } }",
    },
    {
      name: "a never binding in a function inside the clause",
      filename: "probe.ts",
      code: "function f(s: string) { switch (s) { default: return (v: never) => { const x: never = v; return x; }; } }",
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a test tree is out of scope",
      filename: "packages/http/test/push.test.ts",
      code: 'function f(s: "a") { switch (s) { case "a": return 1; default: { const x: never = s; return x; } } }',
    },
  ],
  invalid: [
    {
      name: "the binding returned (the smell's Bad case)",
      filename: "probe.ts",
      code: 'function f(c: { status: "a" }) { switch (c.status) { case "a": return 1; default: { const _exhaustive: never = c.status; return _exhaustive; } } }',
      errors: [neverBinding()],
    },
    {
      name: "the binding in an object",
      filename: "probe.ts",
      code: 'function f(s: "a") { switch (s) { case "a": return null; default: { const _exhaustive: never = s; return { statusText: _exhaustive }; } } }',
      errors: [neverBinding()],
    },
    {
      name: "the binding discarded with void before a real value",
      filename: "probe.ts",
      code: 'function f(s: "a") { switch (s) { case "a": return 1; default: { const exhaustive: never = s; void exhaustive; return 0; } } }',
      errors: [neverBinding()],
    },
    {
      name: "the binding in a throw",
      filename: "probe.ts",
      code: 'function f(s: "a") { switch (s) { case "a": return 1; default: { const _exhaustive: never = s; throw new Error(`bad ${String(_exhaustive)}`); } } }',
      errors: [neverBinding()],
    },
    {
      name: "the binding in a case clause",
      filename: "probe.ts",
      code: 'function f(s: "a") { switch (s) { case "a": { const x: never = s as never; return x; } } }',
      errors: [neverBinding()],
    },
    {
      name: "the binding in a nested block of the default",
      filename: "probe.ts",
      code: 'function f(s: "a") { switch (s) { case "a": return 1; default: if (s) { const x: never = s; return x; } return 0; } }',
      errors: [neverBinding()],
    },
  ],
});
