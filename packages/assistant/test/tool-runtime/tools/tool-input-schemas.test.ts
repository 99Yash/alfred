import assert from "node:assert/strict";
import { test } from "node:test";
import { asSchema } from "ai";
import { INTEGRATION_SLUGS } from "@alfred/contracts";
import { acceptedParamNames } from "../../../src/tool-runtime/internal/dispatch/invalid-input";
import { registerBuiltinTools } from "../../../src/tool-runtime/builtin-tools";
import { listToolsForIntegration } from "../../../src/tool-runtime/internal/registry";

/**
 * Every other tool must expose accepted keys, or `normalizeToolInputKeys` silently no-ops for
 * it.
 */
const PARAMLESS_TOOLS = new Set(["system.list_instructions", "system.current_time"]);

/**
 * A top-level discriminated union serializes to a typeless `oneOf`, and Anthropic
 * rejects every chat turn. Uses the SDK's `asSchema`, the converter the providers use.
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
 * A wrapper that hides the keys makes the normalizer a silent no-op. The keys must
 * also match what `asSchema` shows the model.
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
