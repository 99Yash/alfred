import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TOOL_INPUT_SCHEMAS } from "@alfred/contracts/tool-schemas";
import { z } from "zod";

/**
 * Cheap models send an array argument as a JSON string (`values: "[[\"a\"]]"`).
 * Every top-level array field on every tool must accept that form via `coerceJsonArrayFields`.
 * A new array field without a fixture fails the coverage test.
 */

/** One valid `base` input per tool with array fields; each listed field is retried as a JSON string. */
interface ArrayCoercionFixture {
  base: Record<string, unknown>;
  arrayFields: readonly string[];
}

/** A tool whose array fields are mutually exclusive needs one fixture per exclusive field. */
type ToolArrayCoercionFixtures = ArrayCoercionFixture | readonly ArrayCoercionFixture[];

const FIXTURES = {
  "calendar.create_event": {
    base: {
      summary: "Weekly sync",
      start: "2026-07-01T10:00:00Z",
      end: "2026-07-01T11:00:00Z",
      attendees: ["a@example.com", "b@example.com"],
    },
    arrayFields: ["attendees"],
  },
  "calendar.update_event": {
    base: {
      accountId: "account-1",
      eventId: "event-1",
      eventTitle: "Weekly sync",
      addAttendees: ["a@example.com"],
      removeAttendees: ["b@example.com"],
    },
    arrayFields: ["addAttendees", "removeAttendees"],
  },
  "github.get_pull_requests": {
    base: {
      items: [
        { owner: "99Yash", repo: "alfred", pull_number: 957 },
        { owner: "99Yash", repo: "alfred", pull_number: 952 },
      ],
    },
    arrayFields: ["items"],
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
  "gmail.create_draft": {
    base: {
      to: ["a@example.com"],
      cc: ["c@example.com"],
      bcc: ["d@example.com"],
      subject: "Hello",
      bodyText: "Body text.",
    },
    arrayFields: ["to", "cc", "bcc"],
  },
  "gmail.modify_thread": {
    base: {
      threadId: "thread-1",
      addLabels: ["Receipts", "STARRED"],
      removeLabels: ["INBOX"],
    },
    arrayFields: ["addLabels", "removeLabels"],
  },
  "gmail.modify_message": {
    base: {
      messageId: "message-1",
      addLabels: ["TRASH"],
      removeLabels: ["INBOX"],
    },
    arrayFields: ["addLabels", "removeLabels"],
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
  "system.search_context": {
    base: {
      query: "contract clause about termination",
      objects: [{ by: "identity", provider: "github", kind: "pull_request", externalId: "123" }],
    },
    arrayFields: ["objects"],
  },
  "system.spawn_sub_agent": {
    base: {
      subId: "research",
      brief: "Find relevant activity across connected tools.",
      allowedIntegrations: ["gmail", "calendar"],
    },
    arrayFields: ["allowedIntegrations"],
  },
  "system.author_workflow": {
    base: {
      name: "Weekday brief",
      brief: "Summarize the current time every weekday.",
      trigger: { kind: "cron", schedule: "0 8 * * 1-5", timezone: "Asia/Kolkata" },
      capabilities: [{ tool: "system.current_time" }],
      intent: "Run a weekday brief.",
      assumptions: [],
      externalEffects: [],
    },
    arrayFields: ["capabilities", "assumptions", "externalEffects"],
  },
  "system.activate_workflow": {
    base: {
      workflowId: "wf",
      baseRevisionId: "rev",
      baseContentHash: "hash",
      baseRowVersion: 1,
      definition: {
        name: "Manual brief",
        description: null,
        brief: "Report the current time.",
        trigger: { kind: "manual" },
        allowedIntegrations: ["system"],
        allowedTools: ["system.current_time"],
        requiredCapabilities: [{ tool: "system.current_time" }],
      },
      schedule: {
        summary: "Run manually",
        timezone: "UTC",
        previewedAt: "2026-07-31T00:00:00.000Z",
      },
      resolvedAccounts: [],
      resolvedCapabilities: [{ tool: "system.current_time", title: "check the current time" }],
      authoringProposal: {
        intent: "Report the current time.",
        assumptions: [],
        externalEffects: [],
        requestedCapabilities: [{ tool: "system.current_time" }],
      },
    },
    arrayFields: ["resolvedAccounts", "resolvedCapabilities"],
  },
  "system.remember": {
    base: {
      kind: "standing_instruction",
      phrasing: "Investment mail from these two is never urgent.",
      directive: "Do not mark mail from these two senders urgent.",
      scope: "investment mail",
      targets: ["noreply@example.com", "promo@example.com"],
      senderFilter: ["example.com"],
      effects: ["demote_urgent", "block_todo_suggestion"],
      replaces: ["si_old"],
      coexistsWith: ["si_kept"],
    },
    arrayFields: ["targets", "senderFilter", "effects", "replaces", "coexistsWith"],
  },
  "system.resolve_todo": {
    base: { kind: "todo_ids", todoIds: ["todo_1", "todo_2"] },
    arrayFields: ["todoIds"],
  },
  "system.suggest_todo": {
    base: {
      name: "Reply to the vendor contract",
      sources: [{ provider: "github", kind: "pull_request", id: "123" }],
    },
    arrayFields: ["sources"],
  },
  "system.update_artifact": [
    {
      base: {
        artifactId: "aid",
        pages: [{ title: "Page 1", html: "<p>x</p>" }],
      },
      arrayFields: ["pages"],
    },
    {
      base: {
        artifactId: "aid",
        edits: [{ oldString: "Draft", newString: "Final" }],
      },
      arrayFields: ["edits"],
    },
  ],
  "system.ask_user": {
    base: {
      context: "Need a choice to proceed.",
      questions: [
        {
          question: "Which inbox should I triage first?",
          header: "Inbox",
          options: [
            { label: "Work", description: "Triage the work inbox." },
            { label: "Personal", description: "Triage the personal inbox." },
          ],
          multiSelect: false,
        },
      ],
      answers: [{ selectedOptions: ["Work"], customAnswer: null }],
    },
    arrayFields: ["questions", "answers"],
  },
} satisfies Record<string, ToolArrayCoercionFixtures>;

function fixturesFor(name: string): readonly ArrayCoercionFixture[] {
  const entry: ToolArrayCoercionFixtures | undefined = Object.entries(FIXTURES).find(
    ([k]) => k === name,
  )?.[1];

  if (entry === undefined) return [];

  return "base" in entry ? [entry] : entry;
}

/** Every array-typed top-level field, read from the model-facing JSON schema. */
function discoverArrayFields(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema, { io: "input" });

  const props = json.properties ?? {};

  // A boolean schema node has no `type` or `anyOf`, so it is never an array field.
  return Object.entries(props)
    .filter(([, v]) => {
      const isArray = (t: unknown) => t === "array" || (Array.isArray(t) && t.includes("array"));

      if (typeof v !== "object") return false;

      return (
        isArray(v.type) || (v.anyOf ?? []).some((b) => typeof b === "object" && isArray(b.type))
      );
    })
    .map(([k]) => k);
}

describe("tool-schema array-field coercion (cross-integration)", () => {
  // A new array field fails here until it has a fixture.
  test("every array-typed tool field is covered by a fixture", () => {
    const uncovered: string[] = [];

    for (const [name, schema] of Object.entries(TOOL_INPUT_SCHEMAS)) {
      for (const field of discoverArrayFields(schema as z.ZodType)) {
        if (!fixturesFor(name).some((fixture) => fixture.arrayFields.includes(field))) {
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

  for (const name of Object.keys(FIXTURES)) {
    const fixtures = fixturesFor(name);
    const schema = Object.entries(TOOL_INPUT_SCHEMAS).find(([n]) => n === name)?.[1];

    test(`${name}: base fixtures parse and list the right array fields`, () => {
      assert.ok(schema, `${name} is missing from TOOL_INPUT_SCHEMAS`);

      for (const { base } of fixtures) {
        // Annotated: @types/node 26 overloads `assert.ok`, so the call below types its message
        // argument to pick the assertion, and that argument reads `parsed` inside this loop.
        const parsed: z.ZodSafeParseResult<unknown> = schema.safeParse(base);
        assert.ok(
          parsed.success,
          `base fixture should parse: ${JSON.stringify(parsed.error?.issues)}`,
        );
      }

      // The fixtures' array fields, together, must match the schema's exactly.
      const arrayFields = fixtures.flatMap((fixture) => fixture.arrayFields);
      assert.deepEqual(arrayFields.toSorted(), discoverArrayFields(schema).toSorted());
    });

    const cases = fixtures.flatMap(({ base, arrayFields }) =>
      arrayFields.map((field) => ({ base, field })),
    );

    for (const { base, field } of cases) {
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

        const json = z.toJSONSchema(schema, { io: "input" });

        const node = json.properties?.[field];
        // A boolean schema node advertises no type.
        const prop = typeof node === "object" ? node : undefined;

        const advertisesArray =
          prop?.type === "array" ||
          (Array.isArray(prop?.type) && prop.type.includes("array")) ||
          (prop?.anyOf ?? []).some((b) => typeof b === "object" && b.type === "array");

        assert.ok(advertisesArray, `${field} must still be an array in the model-facing schema`);
      });
    }
  }

  // Coercion accepts only a JSON array string, not any string.
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
