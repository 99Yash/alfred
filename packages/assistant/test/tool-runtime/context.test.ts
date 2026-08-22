import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseIanaTimezone } from "@alfred/contracts";

import { toolExecuteContext } from "../../src/tool-runtime/context";
import type { ToolExecuteContextFields } from "../../src/tool-runtime/internal/registry";

/**
 * `toolExecuteContext` is the ONLY constructor of a `ToolExecuteContext`, and it
 * exists so the provider bind cannot disagree with `userId`. That guarantee
 * splits across two enforcement layers, and this file only carries one of them:
 *
 * - **Runtime (here).** The bind is DERIVED, not passed: the result is the input
 *   fields untouched plus exactly one added key. That is what stops a future
 *   caller from smuggling its own `integrations` through.
 * - **Compiler (the `@ts-expect-error` pin below).** The userId-AGREEMENT half is
 *   not runtime-observable — `Integrations` exposes no `userId` to read back — so
 *   a body mutated to `integrations({ userId: "someone-else" })` would pass every
 *   assertion here. What the compiler enforces is the reason such a mutation has
 *   to be written inside this one function to happen at all:
 *   `ToolExecuteContextFields = Omit<ToolExecuteContext, "integrations">`, so no
 *   caller can supply a bind. Do not read the runtime cases as proving agreement.
 *
 * Env-free by construction: every provider on the bind is a memoized lazy getter,
 * so constructing a context builds no client, opens no connection, and reads no
 * credential.
 */
describe("toolExecuteContext", () => {
  const fields: ToolExecuteContextFields = {
    runId: "run_1",
    scratchpadRunId: "run_1",
    stepId: "step_1",
    toolCallId: "call_1",
    userId: "user_1",
    timezone: parseIanaTimezone("America/New_York"),
    caller: "boss",
    runContext: { caller: "boss", interaction: "background" },
  };

  test("returns every supplied field unchanged", () => {
    const ctx = toolExecuteContext(fields);

    for (const key of Object.keys(fields) as (keyof ToolExecuteContextFields)[]) {
      assert.deepEqual(ctx[key], fields[key], `field ${key} was rewritten`);
    }
  });

  test("derives the binds rather than taking one — exactly the derived keys are added", () => {
    const ctx = toolExecuteContext(fields);

    assert.equal(
      Object.hasOwn(fields, "integrations"),
      false,
      "the fields type must not carry a bind",
    );
    assert.equal(
      Object.hasOwn(fields, "corpus"),
      false,
      "the fields type must not carry the corpus bind",
    );
    assert.ok(ctx.integrations, "the constructor must attach a provider bind");
    assert.ok(ctx.corpus, "the constructor must attach a corpus bind");
    assert.deepEqual(
      Object.keys(ctx).sort(),
      [...Object.keys(fields), "corpus", "integrations"].sort(),
      "the constructor added or dropped a key beyond the derived binds",
    );
  });

  test("binds per call rather than sharing one instance across contexts", () => {
    const first = toolExecuteContext(fields);
    const second = toolExecuteContext({ ...fields, userId: "user_2" });

    assert.notEqual(first.integrations, second.integrations, "two users must not share one bind");
    assert.equal(second.userId, "user_2");
  });

  test("a caller cannot pass its own bind (type pin, TS2353)", () => {
    const smuggled = {
      ...fields,
      // @ts-expect-error `ToolExecuteContextFields` omits `integrations`, so an
      // object literal carrying one is excess-property-checked away. Deleting
      // this directive must make `tsc -p packages/assistant/tsconfig.test.json`
      // fail; if it ever stops failing, the bind is no longer derived-only.
      integrations: {},
    } satisfies ToolExecuteContextFields;

    // The runtime half is incidental — spreading an unknown key through is what
    // the compiler above exists to prevent, not something to assert about.
    assert.ok(smuggled);
  });
});
