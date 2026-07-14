import assert from "node:assert/strict";
import { test } from "node:test";
import { asSchema } from "ai";
import { INTEGRATION_SLUGS } from "@alfred/contracts";
import { listToolsForIntegration, registerBuiltinTools } from "../../src/modules/tools";

/**
 * Regression guard for the `read_chat_history` 400 (a top-level
 * `z.discriminatedUnion` serialized to a typeless `oneOf`, and Anthropic
 * rejected every chat turn with `tools.N.custom.input_schema.type: Field
 * required`). Every registered tool's `input_schema` must be a JSON Schema
 * object with a top-level `type: "object"` — the shape Anthropic (and OpenAI)
 * require. Uses the SDK's own `asSchema`, the exact converter the providers use
 * to build the tool payload, so `.transform()` tools are checked the way the
 * model actually sees them.
 */
test("every registered tool input schema has a top-level object type", () => {
  registerBuiltinTools();
  const offenders: string[] = [];
  for (const slug of INTEGRATION_SLUGS) {
    for (const t of listToolsForIntegration(slug)) {
      const json = asSchema(t.inputSchema as never).jsonSchema as { type?: unknown };
      if (json?.type !== "object") {
        offenders.push(`${t.name} (type=${JSON.stringify(json?.type)})`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `tools with a non-object top-level input_schema: ${offenders.join(", ")}`,
  );
});
