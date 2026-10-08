import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseIanaTimezone } from "@alfred/contracts";

import { toolExecuteContext } from "../../src/tool-runtime/context";
import type { ToolExecuteContextFields } from "../../src/tool-runtime/internal/registry";

/**
 * `toolExecuteContext` derives the provider bind, so it cannot disagree with `userId`.
 * Runtime checks prove only "input fields plus one key". `Integrations` exposes no
 * `userId`, so the `@ts-expect-error` below carries the rest.
 * Providers are lazy, so this is env-free.
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

    assert.ok(smuggled);
  });
});
