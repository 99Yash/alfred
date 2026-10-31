import { RuleTester } from "oxlint/plugins-dev";

import { noSwallowedCatchRule } from "./no-swallowed-catch.ts";

// The spec of `no-swallowed-catch`: a `.catch(…)` handler does not drop the error and
// return a constant. Such a handler makes a failure look like a real empty result, and
// no log shows it (PRs #1458, #1122). The invalid cases include the two hit shapes from
// docs/reference/smells/no-swallowed-catch.md.
//
// `pnpm check:oxlint-plugin` drives each `invalid` case through the root `.oxlintrc.json`.
// A bare `filename` such as `probe.ts` names only the language and keeps the case inside
// the gate scope.

const tester = new RuleTester();

const swallowed = () => ({ messageId: "swallowed" });

tester.run("alfred/no-swallowed-catch", noSwallowedCatchRule, {
  valid: [
    {
      name: "a handler that logs and keeps the value",
      filename: "probe.ts",
      code: 'async function f() { return await readLine(id).catch((err: unknown) => { logger.warn({ err }, "read failed"); return null; }); }',
    },
    {
      name: "a handler that returns a failure value the caller tells apart (the #1122 fix)",
      filename: "probe.ts",
      code: "async function f() { return await readLine(id).then((line) => ({ line, readFailed: false })).catch(() => ({ line: null, readFailed: true })); }",
    },
    {
      name: "a handler that rethrows",
      filename: "probe.ts",
      code: "async function f() { return await read().catch((err: unknown) => { throw new Error('read failed', { cause: err }); }); }",
    },
    {
      name: "a handler that rejects on a branch of the error",
      filename: "probe.ts",
      code: "async function f() { return await read().catch((err: unknown) => (isNotFound(err) ? null : Promise.reject(err))); }",
    },
    {
      name: "a handler passed by name",
      filename: "probe.ts",
      code: "void read().catch(reportFault);",
    },
    {
      name: "a computed `catch` member",
      filename: "probe.ts",
      code: 'void read()["catch"](() => null);',
    },
    {
      name: "a call named catch that is not a member call",
      filename: "probe.ts",
      code: "catchAll(() => null);",
    },
    {
      name: "a handler with more than one statement",
      filename: "probe.ts",
      code: "void read().catch(() => { counter.failed += 1; return null; });",
    },
    {
      name: "a handler that returns a new default object",
      filename: "probe.ts",
      code: "void read().catch(() => new Map());",
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a test tree is out of scope",
      filename: "packages/http/test/swallow.test.ts",
      code: "void read().catch(() => {});",
    },
  ],
  invalid: [
    {
      name: "an empty block on UNSUBSCRIBE (the #1458 hit)",
      filename: "probe.ts",
      code: "conn.unsubscribe(channelFor(userId)).catch(() => {});",
      errors: [swallowed()],
    },
    {
      name: "null for a failed read (the #1122 hit)",
      filename: "probe.ts",
      code: "async function f() { return await readUserContextLine(userId).catch(() => null); }",
      errors: [swallowed()],
    },
    {
      name: "undefined",
      filename: "probe.ts",
      code: "async function f() { await client.close().catch(() => undefined); }",
      errors: [swallowed()],
    },
    {
      name: "false, with an unused error parameter",
      filename: "probe.ts",
      code: "async function f() { return await flagEnabled().catch((_err: unknown) => false); }",
      errors: [swallowed()],
    },
    {
      name: "an empty string",
      filename: "probe.ts",
      code: 'async function f(res: Response) { return await res.text().catch(() => ""); }',
      errors: [swallowed()],
    },
    {
      name: "an empty array and an empty object",
      filename: "probe.ts",
      code: "void a().catch(() => []); void b().catch(() => ({}));",
      errors: [swallowed(), swallowed()],
    },
    {
      name: "void 0 and a negative number",
      filename: "probe.ts",
      code: "void a().catch(() => void 0); void b().catch(() => -1);",
      errors: [swallowed(), swallowed()],
    },
    {
      name: "a block with only a comment",
      filename: "probe.ts",
      code: "void video.play().catch(() => { /* autoplay can be blocked */ });",
      errors: [swallowed()],
    },
    {
      name: "a block with only a constant return",
      filename: "probe.ts",
      code: "void read().catch(() => { return null; });",
      errors: [swallowed()],
    },
    {
      name: "a bare return",
      filename: "probe.ts",
      code: "void read().catch(() => { return; });",
      errors: [swallowed()],
    },
    {
      name: "an async function expression",
      filename: "probe.ts",
      code: "void read().catch(async function () {});",
      errors: [swallowed()],
    },
    {
      name: "an optional call",
      filename: "probe.ts",
      code: "async function f() { await authorization?.close().catch(() => undefined); }",
      errors: [swallowed()],
    },
  ],
});
