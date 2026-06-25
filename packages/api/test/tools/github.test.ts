import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  githubSearchQueryIssues,
  queryHasNarrowingScope,
  sanitizeGithubSearchQuery,
} from "@alfred/contracts";
import { buildGithubSearchQuery, resolvePullRequestAuthor } from "../../src/modules/tools/github";

// Noon UTC on Sat 6 June 2026 — far enough from a tz boundary that UTC and
// Asia/Kolkata agree on the calendar day, except where a case picks a
// near-midnight time to exercise the boundary.
const NOW = Date.UTC(2026, 5, 6, 12, 0, 0);

describe("buildGithubSearchQuery", () => {
  test("closed-in-the-past-week resolves to a tz-local calendar window (N days incl today)", () => {
    assert.equal(
      buildGithubSearchQuery(
        { type: "pr", author: "@me", state: "closed", closedWithinDays: 7, perPage: 30 },
        "UTC",
        NOW,
      ),
      // 6 June minus 6 days = 31 May → the last 7 calendar days, today included.
      "is:pr author:@me is:closed closed:>=2026-05-31T00:00:00+00:00",
    );
  });

  test("mergedWithinDays:1 means *today* in the user's timezone", () => {
    assert.equal(
      buildGithubSearchQuery(
        { type: "pr", author: "99Yash", state: "merged", mergedWithinDays: 1, perPage: 30 },
        "UTC",
        NOW,
      ),
      "is:pr author:99Yash is:merged merged:>=2026-06-06T00:00:00+00:00",
    );
  });

  test("'merged today' crosses the UTC midnight boundary in the user's zone", () => {
    // 23:30 UTC on 6 June is already 05:00 on 7 June in Asia/Kolkata (UTC+5:30).
    const lateNight = Date.UTC(2026, 5, 6, 23, 30, 0);
    assert.equal(
      buildGithubSearchQuery(
        { type: "pr", author: "@me", state: "merged", mergedWithinDays: 1, perPage: 30 },
        "Asia/Kolkata",
        lateNight,
      ),
      "is:pr author:@me is:merged merged:>=2026-06-06T18:30:00+00:00",
    );
  });

  test("type:'issue' searches issues, not PRs", () => {
    assert.equal(
      buildGithubSearchQuery(
        { type: "issue", author: "@me", state: "open", perPage: 30 },
        "UTC",
        NOW,
      ),
      "is:issue author:@me is:open",
    );
  });

  test("type:'both' omits the is:pr/is:issue clause", () => {
    assert.equal(
      buildGithubSearchQuery(
        { type: "both", author: "99Yash", state: "all", perPage: 30 },
        "UTC",
        NOW,
      ),
      "author:99Yash",
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
      buildGithubSearchQuery(
        {
          type: "pr",
          author: "99Yash",
          state: "merged",
          createdWithinDays: 14,
          query: " repo:99Yash/alfred label:bug ",
          perPage: 10,
        },
        "UTC",
        NOW,
      ),
      "is:pr author:99Yash is:merged created:>=2026-05-24T00:00:00+00:00 repo:99Yash/alfred label:bug",
    );
  });

  test("dedupes an identical token that slips into the free-form query", () => {
    assert.equal(
      buildGithubSearchQuery(
        { type: "pr", author: "@me", state: "open", query: "is:pr", perPage: 30 },
        "UTC",
        NOW,
      ),
      "is:pr author:@me is:open",
    );
  });
});

describe("sanitizeGithubSearchQuery (ADR-0071 sanitize-and-merge)", () => {
  test("folds free-typed author:/state:/is: into the structured fields and strips them", () => {
    const { sanitized, stripped } = sanitizeGithubSearchQuery({
      type: "pr",
      author: "@me",
      state: "all",
      query: "is:pr author:99Yash state:closed",
    });
    assert.equal(sanitized.author, "99Yash");
    assert.equal(sanitized.state, "closed");
    assert.equal(sanitized.type, "pr");
    assert.equal(sanitized.query, undefined); // every token was folded out
    assert.ok(stripped.length >= 3);
  });

  test("a duplicate date window is dropped (the structured field wins)", () => {
    const { sanitized, stripped } = sanitizeGithubSearchQuery({
      query: "merged:>=2026-06-01 repo:99Yash/alfred",
      mergedWithinDays: 7,
    });
    assert.equal(sanitized.query, "repo:99Yash/alfred");
    assert.ok(stripped.some((s) => s.startsWith("merged:")));
  });

  test("a standalone explicit date window is kept (no structured field to fold into)", () => {
    const { sanitized, stripped } = sanitizeGithubSearchQuery({
      query: "merged:2026-10-01..2026-10-31",
    });
    assert.equal(sanitized.query, "merged:2026-10-01..2026-10-31");
    assert.deepEqual(stripped, []);
  });

  test("valid extra qualifiers (is:draft, label:) survive untouched", () => {
    const { sanitized, stripped } = sanitizeGithubSearchQuery({
      query: "is:draft label:bug review:approved",
    });
    assert.equal(sanitized.query, "is:draft label:bug review:approved");
    assert.deepEqual(stripped, []);
  });

  test("a negated qualifier is NOT folded — exclusion intent is preserved verbatim", () => {
    // `-author:octocat` excludes; the inclusion-only structured field can't
    // express that, so it must stay in the query (the prior code dropped the
    // `-` and set author='octocat', inverting the user's intent).
    const { sanitized, stripped } = sanitizeGithubSearchQuery({
      query: "-author:octocat repo:99Yash/alfred",
    });
    assert.equal(sanitized.author, undefined);
    assert.equal(sanitized.query, "-author:octocat repo:99Yash/alfred");
    assert.deepEqual(stripped, []);
  });

  test("folding is:pr does not clip a prefix-overlapping is:private token", () => {
    // `split("is:pr")` would corrupt `is:private` into `ivate`; the
    // scanner-based strip removes whole tokens only.
    const { sanitized } = sanitizeGithubSearchQuery({
      query: "is:pr is:private",
    });
    assert.equal(sanitized.type, "pr");
    assert.equal(sanitized.query, "is:private");
  });

  test("an unrecognized state: value is NOT folded and NOT silently stripped", () => {
    // `state:done` is not a real GitHub state. The old code stripped every
    // `state:` token regardless, silently rewriting the query into a different
    // one. It must now be left in place for the validator to reject.
    const { sanitized, stripped } = sanitizeGithubSearchQuery({
      query: "state:done repo:99Yash/alfred",
    });
    assert.equal(sanitized.state, undefined);
    assert.equal(sanitized.query, "state:done repo:99Yash/alfred");
    assert.deepEqual(stripped, []);
  });

  test("a free-typed is:issue with unset type resolves to issue, not both", () => {
    // With no schema default applied, an unset `type` + free-typed `is:issue`
    // narrows to `issue` instead of silently widening to `both`.
    const { sanitized } = sanitizeGithubSearchQuery({ query: "is:issue" });
    assert.equal(sanitized.type, "issue");
  });

  test("an explicit type:'pr' plus free-typed is:issue widens to both", () => {
    const { sanitized } = sanitizeGithubSearchQuery({ type: "pr", query: "is:issue" });
    assert.equal(sanitized.type, "both");
  });
});

describe("githubSearchQueryIssues (residue that has no safe auto-fix)", () => {
  test("clean query (extra-only qualifiers) produces no issues", () => {
    assert.deepEqual(githubSearchQueryIssues({ query: "repo:99Yash/alfred label:bug" }), []);
    assert.deepEqual(
      githubSearchQueryIssues({ query: 'label:"good first issue" review:approved' }),
      [],
    );
    assert.deepEqual(githubSearchQueryIssues({ query: "has:label user-review-requested:@me" }), []);
    assert.deepEqual(githubSearchQueryIssues({ query: "is:draft is:queued is:private" }), []);
    assert.deepEqual(githubSearchQueryIssues({}), []);
  });

  test("folded structured-field collisions no longer reject (sanitize handles them)", () => {
    // is:/author:/state: free-typed into query are now silently merged, not
    // rejected — so the residue checker sees nothing wrong.
    assert.deepEqual(
      githubSearchQueryIssues(
        sanitizeGithubSearchQuery({ query: "is:pr author:99Yash state:closed" }).sanitized,
      ),
      [],
    );
    assert.deepEqual(
      githubSearchQueryIssues(
        sanitizeGithubSearchQuery({ query: "merged:>=2026-06-01", mergedWithinDays: 7 }).sanitized,
      ),
      [],
    );
  });

  test("rejects an unrecognized state: value instead of dropping it silently", () => {
    // `state:done` survives sanitize (see above); the validator must reject it
    // rather than ship a query GitHub silently demotes to a zero-match term.
    const issues = githubSearchQueryIssues(
      sanitizeGithubSearchQuery({ query: "state:done repo:99Yash/alfred" }).sanitized,
    );
    assert.equal(issues.length, 1);
    assert.match(issues[0]!, /Unrecognized GitHub state value/);
    assert.match(issues[0]!, /state:done/);
  });

  test("recognized state: values still fold cleanly (no false rejection)", () => {
    assert.deepEqual(
      githubSearchQueryIssues(
        sanitizeGithubSearchQuery({ query: "state:open repo:99Yash/alfred" }).sanitized,
      ),
      [],
    );
  });

  test("rejects an invented qualifier (the merged-by: silent-zero bug)", () => {
    const issues = githubSearchQueryIssues({ query: "merged-by:@me" });
    assert.equal(issues.length, 1);
    assert.match(issues[0]!, /Unknown GitHub search qualifier/);
    assert.match(issues[0]!, /merged-by/);
  });

  test("rejects invented qualifiers even inside boolean groups", () => {
    const issues = githubSearchQueryIssues({ query: "(repo:99Yash/alfred AND merged-by:@me)" });
    assert.equal(issues.length, 1);
    assert.match(issues[0]!, /Unknown GitHub search qualifier/);
    assert.match(issues[0]!, /merged-by/);
  });

  test("allows an explicit date range when the structured window is unset", () => {
    assert.deepEqual(githubSearchQueryIssues({ query: "merged:2026-10-01..2026-10-31" }), []);
    assert.deepEqual(githubSearchQueryIssues({ query: "closed:<2026-10-31" }), []);
    assert.deepEqual(githubSearchQueryIssues({ query: "created:>=2026-06-01T00:00:00+00:00" }), []);
  });

  test("rejects malformed free-form date qualifier values before GitHub 422s", () => {
    const bareOperatorIssues = githubSearchQueryIssues({ query: "closed:>" });
    assert.equal(bareOperatorIssues.length, 1);
    assert.match(bareOperatorIssues[0]!, /Malformed GitHub date qualifier/);
    assert.match(bareOperatorIssues[0]!, /closed:>/);

    const bareInclusiveOperatorIssues = githubSearchQueryIssues({ query: "merged:>=" });
    assert.equal(bareInclusiveOperatorIssues.length, 1);
    assert.match(bareInclusiveOperatorIssues[0]!, /Malformed GitHub date qualifier/);
    assert.match(bareInclusiveOperatorIssues[0]!, /merged:>=/);
  });

  test("rejects contradictory structured state/window combinations", () => {
    assert.match(
      githubSearchQueryIssues({ state: "open", closedWithinDays: 7 })[0]!,
      /closedWithinDays.*state:'open'/,
    );
    assert.match(
      githubSearchQueryIssues({ state: "open", mergedWithinDays: 7 })[0]!,
      /mergedWithinDays.*state:'open'/,
    );
  });

  test("rejects merged filters on type:'issue' (issues are never merged)", () => {
    assert.match(
      githubSearchQueryIssues({ type: "issue", state: "merged" })[0]!,
      /conflict with `type:'issue'`/,
    );
    assert.match(
      githubSearchQueryIssues({ type: "issue", mergedWithinDays: 7 })[0]!,
      /conflict with `type:'issue'`/,
    );
  });

  test("allows closed-unmerged searches but rejects unmerged merged-window collisions", () => {
    assert.deepEqual(githubSearchQueryIssues({ state: "closed", query: "is:unmerged" }), []);

    const stateIssues = githubSearchQueryIssues({ state: "merged", query: "is:unmerged" });
    assert.equal(stateIssues.length, 1);
    assert.match(stateIssues[0]!, /is:unmerged.*conflicts/);

    const windowIssues = githubSearchQueryIssues({ query: "is:unmerged", mergedWithinDays: 7 });
    assert.equal(windowIssues.length, 1);
    assert.match(windowIssues[0]!, /is:unmerged.*conflicts/);
  });
});

describe("queryHasNarrowingScope (author-default gate, ADR-0071)", () => {
  test("true when the query names a repo/org/user or a person", () => {
    assert.equal(queryHasNarrowingScope("repo:99Yash/alfred"), true);
    assert.equal(queryHasNarrowingScope("org:anthropics is:open"), true);
    assert.equal(queryHasNarrowingScope("assignee:octocat"), true);
    assert.equal(queryHasNarrowingScope("author:99Yash"), true);
    assert.equal(queryHasNarrowingScope("involves:@me label:bug"), true);
  });

  test("false for pure filters that don't scope to a place or person", () => {
    assert.equal(queryHasNarrowingScope("label:bug is:open sort:updated"), false);
    assert.equal(queryHasNarrowingScope("is:draft review:approved"), false);
    assert.equal(queryHasNarrowingScope(undefined), false);
    assert.equal(queryHasNarrowingScope(""), false);
  });
});
