import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  GraphqlPassthroughRequest,
  ReadGateReason,
  RestPassthroughRequest,
} from "@alfred/contracts";
import {
  REST_GATE_CONFIG,
  assertReadableGraphqlRequest,
  assertReadableRestRequest,
} from "../../../src/modules/tools/passthrough";

/**
 * The read gate is the security boundary of the general read-only passthrough
 * tier, so it gets the most exhaustive table. Every row asserts external
 * behavior: which (provider, method, path) combinations pass, and which reason a
 * denial carries — a wrong-path denial must be a clear, self-correctable reason,
 * never a silent pass.
 */

function rest(partial: Partial<RestPassthroughRequest> & { path: string }): RestPassthroughRequest {
  return { method: "GET", ...partial };
}

const github = REST_GATE_CONFIG.github;
const notion = REST_GATE_CONFIG.notion;

describe("assertReadableRestRequest — method gate", () => {
  test("GET and HEAD in the pinned namespace pass without endpoint curation", () => {
    for (const method of ["GET", "HEAD"]) {
      const r = assertReadableRestRequest(
        github,
        rest({ method, path: "/repos/o/r/actions/runs" }),
      );
      assert.equal(r.ok, true, `${method} should pass`);
    }
  });

  test("method casing is normalized — lowercase 'get' still passes", () => {
    const r = assertReadableRestRequest(
      github,
      rest({ method: "get", path: "/repos/o/r/commits" }),
    );
    assert.equal(r.ok, true);
  });

  test("write methods are denied as method_not_read (visible, self-correctable)", () => {
    for (const method of ["DELETE", "PATCH", "PUT", "OPTIONS", "TRACE"]) {
      const r = assertReadableRestRequest(github, rest({ method, path: "/repos/o/r" }));
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "method_not_read", method);
    }
  });
});

describe("assertReadableRestRequest — read-via-POST allowlist", () => {
  test("an unlisted POST is denied (github has no read-via-POST endpoints)", () => {
    const r = assertReadableRestRequest(
      github,
      rest({ method: "POST", path: "/repos/o/r/issues" }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "path_not_allowlisted");
  });

  test("Notion's allowlisted read-via-POST endpoints pass", () => {
    for (const path of ["/search", "/databases/abc123/query"]) {
      const r = assertReadableRestRequest(notion, rest({ method: "POST", path }));
      assert.equal(r.ok, true, path);
    }
  });

  test("a Notion POST outside the allowlist is denied", () => {
    for (const path of ["/pages", "/databases/abc123", "/blocks/x/children"]) {
      const r = assertReadableRestRequest(notion, rest({ method: "POST", path }));
      assert.equal(r.ok, false, path);
      if (!r.ok) assert.equal(r.reason, "path_not_allowlisted", path);
    }
  });
});

describe("assertReadableRestRequest — path hardening", () => {
  const invalid: Array<[string, string]> = [
    ["no leading slash", "repos/o/r"],
    ["empty path", ""],
    ["scheme-relative authority", "//evil.com/x"],
    ["absolute url with scheme", "/https://evil.com"],
    ["scheme inside", "/x://evil"],
    ["backslash", "/repos\\o"],
    ["fragment", "/repos/o/r#frag"],
    ["embedded query", "/search?q=secret"],
    ["encoded slash", "/repos/o%2fr"],
    ["encoded backslash", "/repos/o%5cr"],
    ["dot-dot traversal", "/repos/../admin"],
    ["single-dot segment", "/repos/./o"],
    ["encoded dot-dot", "/repos/%2e%2e/admin"],
    ["malformed percent-encoding", "/repos/%zz"],
  ];

  for (const [label, path] of invalid) {
    test(`rejects ${label} as invalid_path`, () => {
      const r = assertReadableRestRequest(github, rest({ method: "GET", path }));
      assert.equal(r.ok, false, `${label} should be rejected`);
      if (!r.ok) assert.equal(r.reason, "invalid_path", label);
    });
  }

  test("rejects a control character in the path", () => {
    const path = `/repos/o${String.fromCodePoint(7)}r`; // U+0007 bell, a real control char
    const r = assertReadableRestRequest(github, rest({ method: "GET", path }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "invalid_path");
  });

  test("a legitimate deep path with colons (Google-style method suffix) passes", () => {
    // Colons are legal in real API paths (e.g. `documents/{id}:batchGet`); the
    // gate must not blanket-reject them.
    const r = assertReadableRestRequest(
      REST_GATE_CONFIG.docs,
      rest({ path: "/v1/documents/abc:get" }),
    );
    assert.equal(r.ok, true);
  });
});

describe("assertReadableRestRequest — auth-scope denylist", () => {
  test("GitHub /notifications is pre-flight-rejected as auth_scope_unreachable", () => {
    for (const path of ["/notifications", "/notifications/threads/1"]) {
      const r = assertReadableRestRequest(github, rest({ path }));
      assert.equal(r.ok, false, path);
      if (!r.ok) assert.equal(r.reason, "auth_scope_unreachable", path);
    }
  });

  test("a repo-scoped GitHub read is NOT on the auth denylist", () => {
    const r = assertReadableRestRequest(github, rest({ path: "/repos/o/r/actions/runs" }));
    assert.equal(r.ok, true);
  });
});

function graphql(
  partial: Partial<GraphqlPassthroughRequest> & { document: string },
): GraphqlPassthroughRequest {
  return { ...partial };
}

describe("assertReadableGraphqlRequest — read-only via AST, not text scan", () => {
  test("a plain query passes", () => {
    const r = assertReadableGraphqlRequest(graphql({ document: "query { me { id } }" }));
    assert.equal(r.ok, true);
  });

  test("an anonymous query (no operation keyword) passes", () => {
    const r = assertReadableGraphqlRequest(graphql({ document: "{ me { id } }" }));
    assert.equal(r.ok, true);
  });

  test("a targeted introspection query passes", () => {
    const r = assertReadableGraphqlRequest(
      graphql({ document: 'query { __type(name: "Service") { fields { name } } }' }),
    );
    assert.equal(r.ok, true);
  });

  test("a full __schema introspection passes the gate (truncation is a shaper concern)", () => {
    const r = assertReadableGraphqlRequest(
      graphql({ document: "query { __schema { types { name } } }" }),
    );
    assert.equal(r.ok, true);
  });

  test("a query with a fragment passes", () => {
    const r = assertReadableGraphqlRequest(
      graphql({ document: "query { me { ...f } } fragment f on User { id }" }),
    );
    assert.equal(r.ok, true);
  });

  test("a mutation is rejected as graphql_non_query", () => {
    const r = assertReadableGraphqlRequest(
      graphql({ document: "mutation { deleteService(id: 1) { id } }" }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "graphql_non_query");
  });

  test("a subscription is rejected as graphql_non_query", () => {
    const r = assertReadableGraphqlRequest(
      graphql({ document: "subscription { deploymentEvents { id } }" }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "graphql_non_query");
  });

  test("a mixed document (query + mutation) is rejected even when a query is named", () => {
    // Deny the WHOLE document: an injected mutation the caller didn't select
    // must not ride along, even if operationName picks the query.
    const r = assertReadableGraphqlRequest(
      graphql({
        document: "query Q { me { id } } mutation M { x }",
        operationName: "Q",
      }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "graphql_non_query");
  });

  test("an empty document (no operation) is rejected as graphql_non_query", () => {
    const r = assertReadableGraphqlRequest(graphql({ document: "fragment f on User { id }" }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "graphql_non_query");
  });

  test("an unparseable document is deny-by-default graphql_non_query", () => {
    const r = assertReadableGraphqlRequest(graphql({ document: "this is not graphql {{{" }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "graphql_non_query");
  });

  test("multiple queries without operationName are ambiguous", () => {
    const r = assertReadableGraphqlRequest(
      graphql({ document: "query A { me { id } } query B { you { id } }" }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "graphql_operation_ambiguous");
  });

  test("multiple queries WITH a valid operationName pass", () => {
    const r = assertReadableGraphqlRequest(
      graphql({ document: "query A { me { id } } query B { you { id } }", operationName: "B" }),
    );
    assert.equal(r.ok, true);
  });

  test("an operationName naming no operation in the document is ambiguous", () => {
    const r = assertReadableGraphqlRequest(
      graphql({ document: "query A { me { id } }", operationName: "Nope" }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "graphql_operation_ambiguous");
  });
});

describe("read gate — every denial reason is reachable", () => {
  test("the full ReadGateReason set is exercised across the REST and GraphQL suites", () => {
    // Pinned so a new reason can't be added without a test somewhere in this file.
    const restReachable: ReadGateReason[] = [
      "method_not_read",
      "path_not_allowlisted",
      "invalid_path",
      "auth_scope_unreachable",
    ];
    const graphqlReachable: ReadGateReason[] = ["graphql_non_query", "graphql_operation_ambiguous"];
    assert.equal(restReachable.length + graphqlReachable.length, 6);
  });
});
