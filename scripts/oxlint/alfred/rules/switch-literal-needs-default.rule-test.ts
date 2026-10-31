import { RuleTester } from "oxlint/plugins-dev";

import { switchLiteralNeedsDefaultRule } from "./switch-literal-needs-default.ts";

// The spec of `switch-literal-needs-default`: a `switch` whose `case` tests are all
// string literals ends in a `default`. Without one, a member that this build does
// not know falls through, and the function returns `undefined` (PRs #1535, #1132,
// #1103, #868). The Bad and Good cases come from
// docs/reference/smells/switch-literal-needs-default.md.
//
// `pnpm check:oxlint-plugin` drives each `invalid` case through the root
// `.oxlintrc.json`. A bare `filename` such as `probe.ts` names only the language
// and keeps the case inside the gate scope.

const tester = new RuleTester();

const missingDefault = () => ({ messageId: "missingDefault" });

tester.run("alfred/switch-literal-needs-default", switchLiteralNeedsDefaultRule, {
  valid: [
    {
      name: "a default that calls assertNever (the smell's Good case)",
      filename: "probe.ts",
      code: 'function f(row: { source: "gmail" | "github" | "sentry"; metadata: unknown }) { switch (row.source) { case "gmail": return { source: row.source, metadata: parseGmailDocumentMetadata(row.metadata) }; case "github": case "sentry": return { source: row.source, metadata: parseReceipt(row.metadata) }; default: return assertNever(row.source, "document source"); } }',
    },
    {
      name: "a default that returns a real value",
      filename: "probe.ts",
      code: 'function f(kind: "cron" | "manual") { switch (kind) { case "cron": return "Scheduled"; case "manual": return "Run now"; default: return "Triggered"; } }',
    },
    {
      name: "a default with only a break, over an open string",
      filename: "probe.ts",
      code: 'function f(event: { key: string }) { switch (event.key) { case "Home": go(0); break; default: break; } }',
    },
    {
      name: "a default that is not the last clause",
      filename: "probe.ts",
      code: 'function f(s: "a" | "b") { switch (s) { default: return 0; case "a": return 1; case "b": return 2; } }',
    },
    {
      name: "a number case",
      filename: "probe.ts",
      code: 'function f(n: 1 | 2) { switch (n) { case 1: return "a"; case 2: return "b"; } }',
    },
    {
      name: "a case test that is a member, not a literal",
      filename: "probe.ts",
      code: 'function f(kind: string) { switch (kind) { case Kind.A: return 1; case "b": return 2; } }',
    },
    {
      name: "a template literal with an expression",
      filename: "probe.ts",
      code: "function f(s: string, p: string) { switch (s) { case `${p}.a`: return 1; } }",
    },
    {
      name: "a switch with no case",
      filename: "probe.ts",
      code: "function f(s: string) { switch (s) { } }",
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a test tree is out of scope",
      filename: "packages/http/test/switch.test.ts",
      code: 'function f(s: "a") { switch (s) { case "a": return 1; } }',
    },
  ],
  invalid: [
    {
      name: "no default (the smell's Bad case)",
      filename: "probe.ts",
      code: 'function f(row: { source: "gmail" | "github" | "sentry"; metadata: unknown }) { switch (row.source) { case "gmail": return { source: row.source, metadata: parseGmailDocumentMetadata(row.metadata) }; case "github": case "sentry": return { source: row.source, metadata: parseReceipt(row.metadata) }; } }',
      errors: [missingDefault()],
    },
    {
      name: "code after the switch handles the rest",
      filename: "probe.ts",
      code: 'function f(s: "a" | "b") { switch (s) { case "a": return 1; case "b": return 2; } return null; }',
      errors: [missingDefault()],
    },
    {
      name: "an open string with literal cases",
      filename: "probe.ts",
      code: 'function f(event: { key: string }) { switch (event.key) { case "Home": go(0); break; case "End": go(-1); break; } }',
      errors: [missingDefault()],
    },
    {
      name: "a template literal with no expression",
      filename: "probe.ts",
      code: 'function f(s: "a" | "b") { switch (s) { case `a`: return 1; case "b": return 2; } }',
      errors: [missingDefault()],
    },
    {
      name: "a case that breaks to code after the switch",
      filename: "probe.ts",
      code: 'function f(s: { kind: "none" | "found" }) { switch (s.kind) { case "none": return null; case "found": break; } return s; }',
      errors: [missingDefault()],
    },
    {
      name: "each switch in a nested pair reports",
      filename: "probe.ts",
      code: 'function f(a: "x", b: "y") { switch (a) { case "x": switch (b) { case "y": return 1; } } }',
      errors: [missingDefault(), missingDefault()],
    },
  ],
});
