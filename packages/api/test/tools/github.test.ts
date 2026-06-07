import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildPullRequestSearchQuery,
  resolvePullRequestAuthor,
} from "../../src/modules/tools/github";

const NOW = Date.UTC(2026, 5, 6, 12, 0, 0);

describe("buildPullRequestSearchQuery", () => {
  test("builds the closed-in-the-past-week query used for PR-count questions", () => {
    assert.equal(
      buildPullRequestSearchQuery(
        {
          author: "@me",
          state: "closed",
          closedWithinDays: 7,
          perPage: 30,
        },
        NOW,
      ),
      "is:pr author:@me is:closed closed:>=2026-05-30",
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
        NOW,
      ),
      "is:pr author:99Yash is:merged created:>=2026-05-23 repo:99Yash/alfred label:bug",
    );
  });
});
