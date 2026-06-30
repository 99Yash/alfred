import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ToolName } from "@alfred/contracts";
import { TOOL_INPUT_SCHEMAS } from "@alfred/contracts/tool-schemas";
import { z } from "zod";
import { spawnSubAgentInputSchema } from "../src/modules/agent/sub-agents";

/**
 * Cross-integration guard for the JSON-stringified-array failure mode.
 *
 * Cheap / non-thinking models (Haiku is the worst offender) serialize a
 * nested-array tool argument as a JSON *string* (`values: "[[\"a\"]]"`) instead
 * of a real array. A bare `z.array(...)` then hard-fails the dispatch boundary
 * with `invalid_type: expected array, received string`, the boss bounces on the
 * same wall several turns in a row, and the user sees a naive tool error (or a
 * fabricated success over empty output — trace run_9ff8bcw13vba). The fix is
 * `coerceJsonArrayFields` in tool-schemas.ts, applied per array field.
 *
 * This test is the gate: it introspects EVERY tool schema, discovers every
 * array-typed top-level field from the model-facing JSON schema, and asserts
 * (a) each one is covered by a fixture here and (b) the JSON-stringified form of
 * that field still parses. A new array field added without coercion fails the
 * coverage assertion below, so the tolerance can't silently regress per
 * integration.
 */

const MODEL_FACING_TOOL_INPUT_SCHEMAS: Partial<Record<ToolName, z.ZodType>> = {
  ...TOOL_INPUT_SCHEMAS,
  // Server-only because the schema references sub-agent internals, but still
  // boss-visible and model-facing in chat turns.
  "system.spawn_sub_agent": spawnSubAgentInputSchema,
};

/**
 * One valid input per tool that has an array-typed field, plus the names of the
 * array fields on it. `base` must parse as-is; each listed field is then
 * re-tested in its JSON-stringified form. Keep this in lockstep with the array
 * fields discovered by `discoverArrayFields` — the coverage test enforces it.
 */
const FIXTURES: Record<string, { base: Record<string, unknown>; arrayFields: readonly string[] }> =
  {
    "calendar.create_event": {
      base: {
        summary: "Weekly sync",
        start: "2026-07-01T10:00:00Z",
        end: "2026-07-01T11:00:00Z",
        attendees: ["a@example.com", "b@example.com"],
      },
      arrayFields: ["attendees"],
    },
    "gmail.send_draft": {
      base: {
        to: ["a@example.com"],
        cc: ["c@example.com"],
        bcc: ["d@example.com"],
        subject: "Hello",
        bodyText: "Body text.",
      },
      arrayFields: ["to", "cc", "bcc"],
    },
    "sheets.update_values": {
      base: {
        spreadsheetId: "sid",
        range: "Sheet1!A1:B1",
        values: [["a", "b"]],
      },
      arrayFields: ["values"],
    },
    "sheets.append_values": {
      base: {
        spreadsheetId: "sid",
        range: "Sheet1!A1",
        values: [["a", "b"]],
      },
      arrayFields: ["values"],
    },
    "sheets.batch_update": {
      base: {
        spreadsheetId: "sid",
        requests: [{ addSheet: { properties: { title: "Tab" } } }],
      },
      arrayFields: ["requests"],
    },
    "slides.batch_update": {
      base: {
        presentationId: "pid",
        requests: [{ createSlide: {} }],
      },
      arrayFields: ["requests"],
    },
    "system.read_user_context": {
      base: {
        include: ["profile", "facts"],
      },
      arrayFields: ["include"],
    },
    "system.spawn_sub_agent": {
      base: {
        subId: "research",
        brief: "Find relevant activity across connected tools.",
        allowedIntegrations: ["gmail", "calendar"],
      },
      arrayFields: ["allowedIntegrations"],
    },
    "system.suggest_todo": {
      base: {
        name: "Reply to the vendor contract",
        sources: [{ provider: "github", kind: "pull_request", id: "123" }],
      },
      arrayFields: ["sources"],
    },
    "system.update_artifact": {
      base: {
        artifactId: "aid",
        pages: [{ title: "Page 1", html: "<p>x</p>" }],
      },
      arrayFields: ["pages"],
    },
  };

/** Every array-typed top-level field, read from the model-facing JSON schema. */
function discoverArrayFields(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema, { io: "input" }) as {
    properties?: Record<string, { type?: unknown; anyOf?: { type?: unknown }[] }>;
  };
  const props = json.properties ?? {};
  return Object.entries(props)
    .filter(([, v]) => {
      const isArray = (t: unknown) => t === "array" || (Array.isArray(t) && t.includes("array"));
      return isArray(v?.type) || (v?.anyOf ?? []).some((b) => isArray(b?.type));
    })
    .map(([k]) => k);
}

describe("tool-schema array-field coercion (cross-integration)", () => {
  // The gate: every array field on every tool must have a fixture. A new
  // array-typed argument added anywhere fails here until it is both covered by a
  // fixture and (the next test proves) wrapped in coerceJsonArrayFields.
  test("every array-typed tool field is covered by a fixture", () => {
    const uncovered: string[] = [];
    for (const [name, schema] of Object.entries(MODEL_FACING_TOOL_INPUT_SCHEMAS)) {
      for (const field of discoverArrayFields(schema as z.ZodType)) {
        if (!FIXTURES[name]?.arrayFields.includes(field)) {
          uncovered.push(`${name}.${field}`);
        }
      }
    }
    assert.deepEqual(
      uncovered,
      [],
      `array field(s) without coercion coverage — add a fixture and wrap the field in coerceJsonArrayFields: ${uncovered.join(", ")}`,
    );
  });

  for (const [name, { base, arrayFields }] of Object.entries(FIXTURES)) {
    const schema = MODEL_FACING_TOOL_INPUT_SCHEMAS[name as ToolName] as z.ZodType | undefined;

    test(`${name}: base fixture parses and lists the right array fields`, () => {
      assert.ok(schema, `${name} is missing from TOOL_INPUT_SCHEMAS`);
      const parsed = schema.safeParse(base);
      assert.ok(
        parsed.success,
        `base fixture should parse: ${JSON.stringify(parsed.error?.issues)}`,
      );
      // Fixture/schema drift guard: the fields the fixture claims are arrays
      // must be exactly the array fields the schema actually exposes.
      assert.deepEqual([...arrayFields].sort(), discoverArrayFields(schema).sort());
    });

    for (const field of arrayFields) {
      test(`${name}.${field}: JSON-stringified array coerces back to an array`, () => {
        assert.ok(schema);
        const stringified = { ...base, [field]: JSON.stringify(base[field]) };
        const parsed = schema.safeParse(stringified);
        assert.ok(
          parsed.success,
          `stringified ${field} should coerce: ${JSON.stringify(parsed.error?.issues)}`,
        );
        assert.deepEqual(
          (parsed.data as Record<string, unknown>)[field],
          base[field],
          `coerced ${field} should equal the original array`,
        );
      });

      test(`${name}.${field}: model-facing schema still advertises an array`, () => {
        assert.ok(schema);
        const json = z.toJSONSchema(schema, { io: "input" }) as {
          properties?: Record<string, { type?: unknown; anyOf?: { type?: unknown }[] }>;
        };
        const prop = json.properties?.[field];
        const advertisesArray =
          prop?.type === "array" ||
          (Array.isArray(prop?.type) && prop.type.includes("array")) ||
          (prop?.anyOf ?? []).some((b) => b?.type === "array");
        assert.ok(advertisesArray, `${field} must still be an array in the model-facing schema`);
      });
    }
  }

  // A string that is not a JSON array must still be rejected (coercion is a
  // narrow escape hatch, not a blanket "accept any string for an array").
  test("a non-array string still fails strict validation", () => {
    const schema = TOOL_INPUT_SCHEMAS["sheets.update_values"];
    const garbage = schema.safeParse({
      spreadsheetId: "sid",
      range: "Sheet1!A1",
      values: "not-json",
    });
    assert.equal(garbage.success, false);
    const jsonObject = schema.safeParse({
      spreadsheetId: "sid",
      range: "Sheet1!A1",
      values: '{"not":"an-array"}',
    });
    assert.equal(jsonObject.success, false);
  });
});
