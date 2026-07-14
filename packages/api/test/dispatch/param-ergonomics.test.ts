import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ToolName } from "@alfred/contracts";
import { TOOL_INPUT_SCHEMAS } from "@alfred/contracts/tool-schemas";
import { normalizeToolInputKeys } from "../../src/modules/dispatch/normalize-keys";

/**
 * Regression guard for the param-ergonomics pass (query/DSL-flawless work,
 * 2026-07-14). The measured cross-integration failure was NOT the query DSL but
 * the tool-input *parameter surface*: the model reaches for a natural param
 * name/shape the strict schema rejects → `unrecognized_keys`/`invalid_input` →
 * a wasted boss turn + a "Couldn't {integration}" flash. Each case below is a
 * shape drawn from the 400-run failure scan; it must now VALIDATE first-try
 * through the exact two-step the dispatcher runs (`normalizeToolInputKeys` then
 * `schema.safeParse`), so a future schema change that reintroduces the bounce
 * fails here instead of in production.
 *
 * This is the deterministic complement to the live-model *grounding* evals: it
 * pins boundary TOLERANCE (accept the fumbled shape) rather than model behavior
 * (construct the right query), so it needs no provider and never flakes.
 */

function dispatchParse(toolName: ToolName, input: unknown) {
  const schema = TOOL_INPUT_SCHEMAS[toolName];
  assert.ok(schema, `no schema registered for ${toolName}`);
  const normalized = normalizeToolInputKeys(input, schema);
  return schema.safeParse(normalized.input);
}

interface Case {
  readonly name: string;
  readonly tool: ToolName;
  readonly input: Record<string, unknown>;
  /** Optional assertions on the parsed output. */
  readonly expect?: (data: Record<string, unknown>) => void;
}

const CASES: readonly Case[] = [
  // ── casing family (general normalizer) ──────────────────────────────────
  {
    name: "gmail.search max_results → maxResults",
    tool: "gmail.search",
    input: { q: "from:linkedin.com", max_results: 5 },
    expect: (d) => assert.equal(d.maxResults, 5),
  },
  {
    name: "calendar.list_events time_min/time_max → timeMin/timeMax",
    tool: "calendar.list_events",
    input: { time_min: "2026-07-01T00:00:00Z", time_max: "2026-07-02T00:00:00Z" },
    expect: (d) => {
      assert.ok(d.timeMin);
      assert.ok(d.timeMax);
    },
  },
  {
    name: "github.search per_page → perPage",
    tool: "github.search",
    input: { query: "repo:99Yash/alfred", per_page: 10 },
    expect: (d) => assert.equal(d.perPage, 10),
  },
  {
    name: "drive.search_files page_token / page_size casing",
    tool: "drive.search_files",
    input: { q: "name contains 'x'", page_size: 10, page_token: "tok" },
    expect: (d) => {
      assert.equal(d.pageSize, 10);
      assert.equal(d.pageToken, "tok");
    },
  },
  {
    name: "github.get_pull_request pullNumber (camel) → pull_number",
    tool: "github.get_pull_request",
    input: { owner: "99Yash", repo: "alfred", pullNumber: 305 },
    expect: (d) => assert.equal(d.pull_number, 305),
  },
  // ── synonyms (withKeyAliases) ────────────────────────────────────────────
  {
    name: "gmail.send_draft body → bodyText",
    tool: "gmail.send_draft",
    input: { to: ["a@example.com"], subject: "Hi", body: "The message body." },
    expect: (d) => assert.equal(d.bodyText, "The message body."),
  },
  {
    name: "github.search limit → perPage",
    tool: "github.search",
    input: { query: "repo:99Yash/alfred", limit: 5 },
    expect: (d) => assert.equal(d.perPage, 5),
  },
  {
    // A cased/underscored variant of an ALIAS (not an accepted key) can't be
    // reached by the generic dispatch normalizer, so withKeyAliases matches the
    // alias case/underscore-insensitively — otherwise `Limit`/`Body` would fall
    // through both layers and re-open the exact bounce the wrapper closes.
    name: "github.search Limit (cased alias) → perPage",
    tool: "github.search",
    input: { query: "repo:99Yash/alfred", Limit: 5 },
    expect: (d) => assert.equal(d.perPage, 5),
  },
  {
    name: "gmail.send_draft Body (cased alias) → bodyText",
    tool: "gmail.send_draft",
    input: { to: ["a@example.com"], subject: "Hi", Body: "The message body." },
    expect: (d) => assert.equal(d.bodyText, "The message body."),
  },
  // ── wrong shape (github url/number decompose — the biggest offender) ─────
  {
    name: "github.get_pull_request url → owner/repo/pull_number",
    tool: "github.get_pull_request",
    input: { url: "https://github.com/99Yash/alfred/pull/305" },
    expect: (d) => {
      assert.equal(d.owner, "99Yash");
      assert.equal(d.repo, "alfred");
      assert.equal(d.pull_number, 305);
    },
  },
  {
    name: "github.get_issue url → owner/repo/issue_number",
    tool: "github.get_issue",
    input: { url: "https://github.com/99Yash/alfred/issues/218" },
    expect: (d) => assert.equal(d.issue_number, 218),
  },
  {
    name: "github.get_pull_request bare number → pull_number",
    tool: "github.get_pull_request",
    input: { owner: "99Yash", repo: "alfred", number: 305 },
    expect: (d) => assert.equal(d.pull_number, 305),
  },
  {
    // Live-caught (run_zontenz6gh4e, 2026-07-14): the search→fetch step emitted
    // a combined `owner/repo` slug AND the `pullRequestNumber` synonym, bouncing
    // the first fetch attempt. Both must now fold.
    name: "github.get_pull_request combined slug + pullRequestNumber synonym",
    tool: "github.get_pull_request",
    input: { repo: "99Yash/alfred", pullRequestNumber: "503" },
    expect: (d) => {
      assert.equal(d.owner, "99Yash");
      assert.equal(d.repo, "alfred");
      assert.equal(d.pull_number, 503);
    },
  },
  {
    name: "github.get_issue combined slug + issueNumber synonym",
    tool: "github.get_issue",
    input: { repo: "99Yash/alfred", issueNumber: 218 },
    expect: (d) => {
      assert.equal(d.owner, "99Yash");
      assert.equal(d.repo, "alfred");
      assert.equal(d.issue_number, 218);
    },
  },
  // ── real Drive-DSL guard ─────────────────────────────────────────────────
  {
    name: "drive.search_files bare term → name/fullText contains",
    tool: "drive.search_files",
    input: { q: "resume" },
    expect: (d) => assert.equal(d.q, "name contains 'resume' or fullText contains 'resume'"),
  },
  {
    name: "drive.search_files q='*' → dropped (list recent)",
    tool: "drive.search_files",
    input: { q: "*" },
    expect: (d) => assert.equal(d.q, undefined),
  },
  // ── calendar over-specification (window wins; no bounce) ─────────────────
  {
    name: "calendar.list_events kitchen-sink (bounds + window + partOfDay)",
    tool: "calendar.list_events",
    input: {
      timeMin: "2026-07-09T12:00:00+05:30",
      timeMax: "2026-07-10T12:00:00+05:30",
      window: "today",
      partOfDay: "full_day",
      maxResults: 50,
    },
    expect: (d) => assert.equal(d.window, "today"),
  },
];

describe("param-ergonomics: measured fumbles validate first-try through dispatch", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const parsed = dispatchParse(c.tool, c.input);
      assert.equal(
        parsed.success,
        true,
        parsed.success ? "" : `bounced: ${JSON.stringify(parsed.error?.issues)}`,
      );
      if (parsed.success && c.expect) c.expect(parsed.data as Record<string, unknown>);
    });
  }
});

describe("param-ergonomics: the github number-synonym fold stays a closed allowlist", () => {
  // An unrelated numeric field must NOT be folded into the item number. Folding
  // `comment_number` → `issue_number` would silently fetch the WRONG entity — a
  // failure strictly worse than a bounce, which self-corrects. So this MUST
  // bounce (unknown key + missing issue_number), never quietly succeed.
  test("github.get_issue comment_number is not folded into issue_number", () => {
    const parsed = dispatchParse("github.get_issue", {
      owner: "99Yash",
      repo: "alfred",
      comment_number: 5,
    });
    assert.equal(parsed.success, false);
  });
});
