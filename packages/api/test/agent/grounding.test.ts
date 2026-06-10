import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDateGrounding } from "../../src/modules/agent/grounding";

// `formatDateGrounding` is the plumbing the agent date-grounding fix relies on:
// it renders "now" in the user's timezone so the model can anchor relative and
// partial dates ("October 2026", "next week"). The tz math is the regression-
// prone part — an off-by-one across the UTC day boundary silently grounds the
// agent on the wrong day. These cases pin that behavior; the behavioral half
// (does the model actually call calendar.list_events instead of asking which
// year?) lives in evals/date-grounding.eval.ts.

test("formatDateGrounding: UTC renders the same calendar day", () => {
  const out = formatDateGrounding("UTC", new Date("2026-06-10T12:00:00Z"));
  assert.match(out, /^Wednesday, 10 June 2026 \(2026-06-10\), timezone UTC$/);
});

test("formatDateGrounding: ahead-of-UTC tz crosses into the next day", () => {
  // 20:00Z is 01:30 the next morning in IST (UTC+5:30) — the off-by-one the
  // old UTC-only grounding would have gotten wrong.
  const out = formatDateGrounding("Asia/Kolkata", new Date("2026-06-10T20:00:00Z"));
  assert.match(out, /Thursday, 11 June 2026 \(2026-06-11\), timezone Asia\/Kolkata/);
});

test("formatDateGrounding: behind-UTC tz stays on the previous day", () => {
  // 05:00Z is 22:00 the previous evening in PDT (UTC-7).
  const out = formatDateGrounding("America/Los_Angeles", new Date("2026-06-10T05:00:00Z"));
  assert.match(out, /Tuesday, 9 June 2026 \(2026-06-09\), timezone America\/Los_Angeles/);
});

test("formatDateGrounding: ISO segment and timezone label are always present", () => {
  const out = formatDateGrounding("Europe/London", new Date("2026-12-25T10:00:00Z"));
  assert.ok(out.includes("(2026-12-25)"), `expected ISO date in: ${out}`);
  assert.ok(out.endsWith("timezone Europe/London"), `expected tz label in: ${out}`);
});
