import assert from "node:assert/strict";
import { test } from "node:test";
import { asSchema } from "ai";
import { INTEGRATION_SLUGS } from "@alfred/contracts";
import { acceptedParamNames } from "../../src/modules/dispatch/invalid-input";
import { listToolsForIntegration, registerBuiltinTools } from "../../src/modules/tools";

/**
 * Tools that genuinely take no parameters. `normalizeToolInputKeys` correctly
 * no-ops for these; every OTHER tool must expose a non-empty accepted-key set,
 * or the normalizer silently disables casing tolerance for it (the exact
 * regression #505 exists to prevent). Kept as an explicit allowlist so ADDING a
 * param to one — or a wrapper that breaks unwrapping on a rich tool — fails here.
 */
const PARAMLESS_TOOLS = new Set(["railway.list_projects", "system.list_instructions"]);

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

/**
 * Guard for the param-ergonomics normalizer (#505). `normalizeToolInputKeys`
 * renames casing/underscore variants to the schema key by reading the accepted
 * keys from `acceptedParamNames` (`z.toJSONSchema(schema, { io: "input" })`).
 * That must (a) survive every `preprocess`/wrapper composition — otherwise it
 * returns `[]` and the normalizer SILENTLY becomes a no-op — and (b) agree with
 * the keys the model is actually shown (the SDK's `asSchema`, the exact payload
 * providers build), or the normalizer would target a different surface than the
 * model uses. Both failure modes are invisible at runtime, so pin them here.
 */
test("acceptedParamNames survives every wrapper and matches the model-facing surface", () => {
  registerBuiltinTools();
  const problems: string[] = [];
  for (const slug of INTEGRATION_SLUGS) {
    for (const t of listToolsForIntegration(slug)) {
      const accepted = [...acceptedParamNames(t.inputSchema)].sort();
      const modelJson = asSchema(t.inputSchema as never).jsonSchema as {
        properties?: Record<string, unknown>;
      };
      const modelFacing = Object.keys(modelJson.properties ?? {}).sort();

      if (PARAMLESS_TOOLS.has(t.name)) {
        if (accepted.length !== 0) {
          problems.push(`${t.name}: expected param-less but accepts [${accepted.join(", ")}]`);
        }
      } else if (accepted.length === 0) {
        problems.push(`${t.name}: acceptedParamNames is empty — normalizer silently disabled`);
      }

      if (JSON.stringify(accepted) !== JSON.stringify(modelFacing)) {
        problems.push(
          `${t.name}: normalizer keys [${accepted.join(", ")}] ≠ model-facing [${modelFacing.join(", ")}]`,
        );
      }
    }
  }
  assert.deepEqual(problems, [], `param-surface drift:\n  ${problems.join("\n  ")}`);
});
