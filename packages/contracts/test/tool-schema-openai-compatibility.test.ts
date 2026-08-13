import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TOOL_INPUT_SCHEMAS } from "@alfred/contracts/tool-schemas";
import { z } from "zod";

const UNSUPPORTED_LOOKAROUND = /\(\?[=!<]/;

describe("OpenAI tool-schema compatibility", () => {
  test("model-facing tool patterns do not contain regex lookaround", () => {
    for (const [toolName, schema] of Object.entries(TOOL_INPUT_SCHEMAS)) {
      const jsonSchema = z.toJSONSchema(schema, { io: "input" });
      const serialized = JSON.stringify(jsonSchema);

      assert.equal(
        UNSUPPORTED_LOOKAROUND.test(serialized),
        false,
        `${toolName} emits a regex lookaround that OpenAI JSON Schema rejects`,
      );
    }
  });

  test("lookaround-free email schemas retain runtime validation", () => {
    const readContext = TOOL_INPUT_SCHEMAS["system.read_user_context"];

    assert.equal(readContext.safeParse({ subjectEmail: " Person@Example.com " }).success, true);
    assert.equal(readContext.safeParse({ subjectEmail: ".person@example.com" }).success, false);
    assert.equal(
      readContext.safeParse({ subjectEmail: "person..name@example.com" }).success,
      false,
    );
    assert.equal(readContext.safeParse({ subjectEmail: "not-an-email" }).success, false);
  });
});
