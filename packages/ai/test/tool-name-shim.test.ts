import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { INTEGRATION_ACTIONS, type IntegrationSlug } from "@alfred/contracts";
import { getShimmedToolNameMaxLen } from "../src/provider";
import { decodeToolName, encodeToolName } from "../src/tool-name-shim";

/**
 * The Anthropic tool-name shim encodes `.`→`__` and back. That round-trip is
 * only reversible while two `ToolName` invariants hold: exactly one `.` per
 * name, and no `__` anywhere (so `decode` can't split the wrong underscore).
 * The shim's comment states this but nothing enforced it — a future tool named
 * `foo.bar__baz` or `foo.bar.baz` would silently corrupt on the way back from
 * Anthropic. This test asserts the invariant over the live registry so adding
 * such a name fails here instead of in production.
 */

const ALL_TOOL_NAMES: string[] = (
  Object.entries(INTEGRATION_ACTIONS) as [IntegrationSlug, readonly string[]][]
).flatMap(([integration, actions]) => actions.map((action) => `${integration}.${action}`));

describe("tool-name-shim registry invariants", () => {
  test("registry is non-empty (guards against an empty flatMap passing vacuously)", () => {
    assert.ok(ALL_TOOL_NAMES.length > 0);
  });

  test("every tool name has exactly one '.'", () => {
    for (const name of ALL_TOOL_NAMES) {
      const dots = name.split(".").length - 1;
      assert.equal(dots, 1, `${name} must contain exactly one '.' (has ${dots})`);
    }
  });

  test("no tool name contains '__' (would break the decode split)", () => {
    for (const name of ALL_TOOL_NAMES) {
      assert.ok(!name.includes("__"), `${name} must not contain '__'`);
    }
  });

  test("encode→decode round-trips every tool name", () => {
    for (const name of ALL_TOOL_NAMES) {
      assert.equal(decodeToolName(encodeToolName(name)), name);
    }
  });

  test("encoded names match the strictest shimmed provider name policy", () => {
    const pattern = /^[a-zA-Z0-9_-]+$/;
    const maxLen = getShimmedToolNameMaxLen();
    for (const name of ALL_TOOL_NAMES) {
      const encoded = encodeToolName(name);
      assert.match(encoded, pattern, `${name} → ${encoded} must use provider-safe characters`);
      assert.ok(
        encoded.length <= maxLen,
        `${name} → ${encoded} must fit shimmed provider max length ${maxLen}`,
      );
    }
  });
});
