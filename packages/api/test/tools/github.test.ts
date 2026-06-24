import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { pullRequestQueryIssues } from "@alfred/contracts";
import {
  buildPullRequestSearchQuery,
  resolvePullRequestAuthor,
} from "../../src/modules/tools/github";

// Noon UTC on Sat 6 June 2026 — far enough from a tz boundary that UTC and
// Asia/Kolkata agree on the calendar day, except where a case picks a
// near-midnight time to exercise the boundary.
const NOW = Date.UTC(2026, 5, 6, 12, 0, 0);

describe("buildPullRequestSearchQuery", () => {
  test("closed-in-the-past-week resolves to a tz-local calendar window (N days incl today)", () => {
    assert.equal(
      buildPullRequestSearchQuery(
        { author: "@me", state: "closed", closedWithinDays: 7, perPage: 30 },
        "UTC",
        NOW,
      ),
      // 6 June minus 6 days = 31 May → the last 7 calendar days, today included.
      "is:pr author:@me is:closed closed:>=2026-05-31",
    );
  });

  test("mergedWithinDays:1 means *today* in the user's timezone", () => {
    assert.equal(
      buildPullRequestSearchQuery(
        { author: "99Yash", state: "merged", mergedWithinDays: 1, perPage: 30 },
        "UTC",
        NOW,
      ),
      "is:pr author:99Yash is:merged merged:>=2026-06-06",
    );
  });

  test("'merged today' crosses the UTC midnight boundary in the user's zone", () => {
    // 23:30 UTC on 6 June is already 05:00 on 7 June in Asia/Kolkata (UTC+5:30).
    // A UTC-sliced window would answer for the 6th and miss a PR merged on the
    // user's "today" (the 7th). The tz-local window gets it right.
    const lateNight = Date.UTC(2026, 5, 6, 23, 30, 0);
    assert.equal(
      buildPullRequestSearchQuery(
        { author: "@me", state: "merged", mergedWithinDays: 1, perPage: 30 },
        "Asia/Kolkata",
        lateNight,
      ),
      "is:pr author:@me is:merged merged:>=2026-06-07",
    );
  });

  test("resolves @me to the connected GitHub login before search", () => {
    assert.equal(resolvePullRequestAuthor("@me", "99Yash"), "99Yash");
    assert.equal(resolvePullRequestAuthor("octocat", "99Yash"), "octocat");
    assert.equal(resolvePullRequestAuthor("octocat", null), "octocat");
    assert.throws(
      () => resolvePullRequestAuthor("@me", null, "user_1"),
      /user user_1 has no github login/,
    );
  });

  test("composes merged, created-window, and extra qualifiers without blank fragments", () => {
    assert.equal(
      buildPullRequestSearchQuery(
        {
          author: "99Yash",
          state: "merged",
          createdWithinDays: 14,
          query: " repo:99Yash/alfred label:bug ",
          perPage: 10,
        },
        "UTC",
        NOW,
      ),
      "is:pr author:99Yash is:merged created:>=2026-05-24 repo:99Yash/alfred label:bug",
    );
  });

  test("dedupes an identical token that slips into the free-form query", () => {
    // The schema rejects is:/author: collisions before dispatch, but the
    // builder must never emit a doubled token even if one reaches it.
    assert.equal(
      buildPullRequestSearchQuery(
        { author: "@me", state: "open", query: "is:pr", perPage: 30 },
        "UTC",
        NOW,
      ),
      "is:pr author:@me is:open",
    );
  });
});

describe("pullRequestQueryIssues", () => {
  test("clean query (extra-only qualifiers) produces no issues", () => {
    assert.deepEqual(pullRequestQueryIssues({ query: "repo:99Yash/alfred label:bug" }), []);
    assert.deepEqual(pullRequestQueryIssues({ query: 'label:"good first issue" review:approved' }), []);
    assert.deepEqual(pullRequestQueryIssues({}), []);
  });

  test("rejects an invented qualifier (the merged-by: silent-zero bug)", () => {
    const issues = pullRequestQueryIssues({ query: "merged-by:@me" });
    assert.equal(issues.length, 1);
    assert.match(issues[0]!, /Unknown GitHub search qualifier/);
    assert.match(issues[0]!, /merged-by/);
  });

  test("rejects structured-managed qualifiers free-typed into query (#213 dup clauses)", () => {
    const issues = pullRequestQueryIssues({ query: "is:pr author:99Yash" });
    assert.ok(issues.some((m) => /Don't put `is:`/.test(m)));
    assert.ok(issues.some((m) => /Don't put `author:`/.test(m)));
  });

  test("rejects a free-form date window that collides with its structured field", () => {
    const issues = pullRequestQueryIssues({ query: "merged:>=2026-06-01", mergedWithinDays: 7 });
    assert.equal(issues.length, 1);
    assert.match(issues[0]!, /`merged:` in `query` conflicts with the `mergedWithinDays` field/);
  });

  test("allows an explicit date range when the structured window is unset", () => {
    // "PRs merged in October" — a specific range the *WithinDays fields can't
    // express — is legitimate free-form.
    assert.deepEqual(pullRequestQueryIssues({ query: "merged:2026-10-01..2026-10-31" }), []);
  });
});
