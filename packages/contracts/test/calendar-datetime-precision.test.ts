import assert from "node:assert/strict";
import test from "node:test";
import { calendarCreateEventInput } from "@alfred/contracts";
import * as z from "zod";

/**
 * Zod 4.5.0 made seconds mandatory, which breaks a model-written `14:00`.
 * `padDatetimeSeconds` restores the old input set: pin what it accepts and what it still rejects.
 */

const base = { calendarId: "primary", summary: "Sync", timeZone: "Asia/Kolkata" };

const parse = (start: string, end: string) =>
  calendarCreateEventInput.safeParse({ ...base, start, end });

test("minute-precision datetimes are padded to seconds", () => {
  const result = parse("2026-08-29T14:00+05:30", "2026-08-29T15:00+05:30");
  assert.ok(result.success);
  assert.equal(result.data.start, "2026-08-29T14:00:00+05:30");
  assert.equal(result.data.end, "2026-08-29T15:00:00+05:30");
});

test("minute-precision UTC datetimes are padded to seconds", () => {
  const result = parse("2026-08-29T14:00Z", "2026-08-29T15:00Z");
  assert.ok(result.success);
  assert.equal(result.data.start, "2026-08-29T14:00:00Z");
  assert.equal(result.data.end, "2026-08-29T15:00:00Z");
});

test("datetimes that already carry seconds pass through unchanged", () => {
  const result = parse("2026-08-29T14:00:00+05:30", "2026-08-29T15:30:45.123Z");
  assert.ok(result.success);
  assert.equal(result.data.start, "2026-08-29T14:00:00+05:30");
  assert.equal(result.data.end, "2026-08-29T15:30:45.123Z");
});

test("the shim widens nothing: a datetime with no zone is still rejected", () => {
  // The old validator refused this too.
  assert.equal(parse("2026-08-29T14:00", "2026-08-29T15:00").success, false);
});

test("the shim widens nothing: a colon-less offset is still rejected", () => {
  assert.equal(parse("2026-08-29T14:00+0530", "2026-08-29T15:00+0530").success, false);
});

test("the shim widens nothing: non-datetime text is still rejected", () => {
  assert.equal(parse("tomorrow at 2", "tomorrow at 3").success, false);
});

test("padding runs before the end-after-start refinement", () => {
  const result = parse("2026-08-29T15:00Z", "2026-08-29T14:00Z");
  assert.equal(result.success, false);
  assert.ok(result.error?.issues.some((issue) => issue.path.join(".") === "end"));
});

test("the model-facing JSON schema still advertises the canonical surface", () => {
  const json = z.toJSONSchema(calendarCreateEventInput, { io: "input" }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };

  assert.deepEqual(Object.keys(json.properties ?? {}).sort(), [
    "attendees",
    "calendarId",
    "description",
    "end",
    "location",
    "start",
    "summary",
    "timeZone",
  ]);
  // The preprocess must not make an optional field required.
  assert.deepEqual((json.required ?? []).sort(), ["end", "start", "summary"]);
});
