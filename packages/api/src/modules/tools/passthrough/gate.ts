import type {
  GraphqlPassthroughRequest,
  ReadGateReason,
  ReadGateResult,
  RestPassthroughRequest,
} from "@alfred/contracts";
import { Kind, OperationTypeNode, parse } from "graphql";
import type { RestProviderGateConfig } from "./config";

/**
 * The read gate — the security boundary of the general read-only passthrough
 * tier. A single pure function that decides reachability and never trusts a
 * caller/author label. Deny-by-default on authority and capability.
 *
 * This module owns the **REST** gate. GraphQL (Railway) parses the document into
 * an AST and lands with the Railway vertical slice (it needs the `graphql`
 * dependency); it will compose here behind a `PassthroughRequest`-discriminating
 * `assertReadableRequest`.
 *
 * Posture (ADR-0074): the pinned namespace + method gate + exact read-via-POST
 * allowlist — not the (broad-grant, single-user) token scope — is the
 * write-safety guarantee. The model supplies only a namespace-relative path and
 * params; it can never choose an origin, headers, or an absolute URL. Redirects
 * are never followed and binary bytes never enter the transcript — both enforced
 * in the transport adapter, not here.
 */

const READ_METHODS = new Set(["GET", "HEAD", "POST"]);

// C0 control range (U+0000–U+001F) plus DEL (U+007F) — never legal in a path.
// oxlint-disable-next-line no-control-regex -- rejecting control chars is the purpose here
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]");

function reject(reason: ReadGateReason) {
  return (detail: string): ReadGateResult => ({ ok: false, reason, detail });
}

const rejectInvalidPath = reject("invalid_path");
const rejectMethod = reject("method_not_read");
const rejectAllowlist = reject("path_not_allowlisted");
const rejectAuthScope = reject("auth_scope_unreachable");
const rejectGraphqlNonQuery = reject("graphql_non_query");
const rejectGraphqlAmbiguous = reject("graphql_operation_ambiguous");

/** Decode one path segment, returning null on malformed percent-encoding. */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Path hardening — runs before any URL construction. Requires exactly one
 * namespace-relative path beginning with `/`, and rejects every shape that could
 * escape the pinned namespace or smuggle authority/query/control data:
 * scheme-relative `//`, schemes/authority (`://`), backslashes, dot segments
 * (raw and percent-encoded), encoded slash/backslash ambiguity, fragments,
 * query text embedded in the path, and control characters. Query parameters
 * travel only in the separate `query` field.
 */
function hardenPath(path: string): ReadGateResult {
  if (path.length === 0 || path[0] !== "/") {
    return rejectInvalidPath(
      "Path must be a single namespace-relative path beginning with '/'. Put query parameters in the separate 'query' field.",
    );
  }
  if (path.startsWith("//")) {
    return rejectInvalidPath("Path must not begin with '//' (no scheme-relative authority).");
  }
  if (path.includes("://")) {
    return rejectInvalidPath("Path must not contain a scheme or authority; use a relative path.");
  }
  if (path.includes("\\")) {
    return rejectInvalidPath("Path must not contain backslashes.");
  }
  if (CONTROL_CHARS.test(path)) {
    return rejectInvalidPath("Path must not contain control characters.");
  }
  if (path.includes("#")) {
    return rejectInvalidPath("Fragments are not allowed; drop the '#…' portion.");
  }
  if (path.includes("?")) {
    return rejectInvalidPath("Query text must travel in the separate 'query' field, not the path.");
  }
  // Encoded slash/backslash would let a segment smuggle a separator past the
  // segment-wise dot-segment check below.
  if (/%2f/i.test(path) || /%5c/i.test(path)) {
    return rejectInvalidPath("Encoded slashes/backslashes ('%2F'/'%5C') are not allowed.");
  }

  for (const segment of path.split("/")) {
    if (segment.length === 0) continue; // leading '/' and any empty run
    const decoded = safeDecode(segment);
    if (decoded === null) {
      return rejectInvalidPath("Path contains malformed percent-encoding.");
    }
    if (decoded === "." || decoded === "..") {
      return rejectInvalidPath(
        "Path must not contain '.' or '..' segments (including encoded forms).",
      );
    }
  }
  return { ok: true };
}

function matchesAny(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

/**
 * Assert a REST passthrough request is a read Alfred is willing to issue.
 * Deny-by-default: only same-namespace GET/HEAD (minus the side-effecting-GET
 * denylist) and exactly-allowlisted read-via-POST paths pass. Every other method
 * is denied; a known-unreachable auth-scope path is pre-flight-rejected with a
 * clear reason. New GET/HEAD endpoints on a supported provider remain reachable
 * without curation — breadth is the point.
 */
export function assertReadableRestRequest(
  config: RestProviderGateConfig,
  request: RestPassthroughRequest,
): ReadGateResult {
  const method = request.method.toUpperCase();

  if (!READ_METHODS.has(method)) {
    return rejectMethod(
      `Method '${request.method}' is not a read method. Only GET, HEAD, and allowlisted read-via-POST endpoints are permitted; writes stay in the curated tools.`,
    );
  }

  const pathResult = hardenPath(request.path);
  if (!pathResult.ok) return pathResult;

  if (method === "GET" || method === "HEAD") {
    if (matchesAny(request.path, config.sideEffectingGetDenylist)) {
      return rejectAllowlist(
        "This GET/HEAD endpoint is known to side-effect and is denied by the read gate.",
      );
    }
    const authDenial = config.authScopeDenylist.find((entry) => entry.pattern.test(request.path));
    if (authDenial) {
      return rejectAuthScope(authDenial.detail);
    }
    return { ok: true };
  }

  // POST: allowed only for an exactly-allowlisted read endpoint.
  if (!matchesAny(request.path, config.readViaPostAllowlist)) {
    return rejectAllowlist(
      "POST is permitted only for this provider's allowlisted read endpoints (e.g. a query/search). This path is not one of them.",
    );
  }
  return { ok: true };
}

/**
 * Assert a GraphQL passthrough document is read-only (Railway). GraphQL is
 * all-POST, so method gating can't help; instead the document is parsed into an
 * AST — never scanned as text — and the *entire* document is rejected if it
 * contains any `mutation` or `subscription` operation, even when another
 * operation was selected via `operationName`. A source-text scan would be fooled
 * by the words appearing in a string/alias/comment; the AST cannot.
 *
 * Queries and fragments pass. A document with multiple operations requires
 * `operationName` (GraphQL's own rule, surfaced here as a clear reason rather
 * than a downstream upstream error). Introspection (`__schema`/`__type`) is a
 * query and passes the gate; the tool description steers away from a full
 * `__schema` dump because it truncates, but the gate does not reject it.
 */
export function assertReadableGraphqlRequest(request: GraphqlPassthroughRequest): ReadGateResult {
  let document;
  try {
    document = parse(request.document);
  } catch {
    // An unparseable document can't be *proven* read-only, so deny-by-default.
    // (Our parser is spec-compliant; Railway speaks standard GraphQL.)
    return rejectGraphqlNonQuery(
      "The GraphQL document could not be parsed. Send a single valid, read-only query document.",
    );
  }

  const operations = document.definitions.filter(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );

  // Reject the whole document if ANY operation mutates or subscribes — even one
  // the caller didn't select. A read-only gate can't ship a document that also
  // carries a write the model (or an injected payload) could later select.
  for (const operation of operations) {
    if (
      operation.operation === OperationTypeNode.MUTATION ||
      operation.operation === OperationTypeNode.SUBSCRIPTION
    ) {
      return rejectGraphqlNonQuery(
        `This document contains a ${operation.operation} operation. The general tier is read-only; only 'query' operations are permitted.`,
      );
    }
  }

  if (operations.length === 0) {
    return rejectGraphqlNonQuery(
      "The GraphQL document has no query operation to execute. Send a single read-only query.",
    );
  }

  if (operations.length > 1 && !request.operationName) {
    return rejectGraphqlAmbiguous(
      "This document defines multiple operations; set operationName to pick exactly one query.",
    );
  }

  if (request.operationName) {
    const named = operations.some((operation) => operation.name?.value === request.operationName);
    if (!named) {
      return rejectGraphqlAmbiguous(
        `No operation named '${request.operationName}' exists in this document.`,
      );
    }
  }

  return { ok: true };
}

/**
 * The single read-gate entry point, discriminating on transport. REST providers
 * carry their per-provider policy config; Railway (GraphQL) needs none. Keeps the
 * two gates behind one call so a future REST provider slots in without a new
 * dispatch branch.
 */
export type PassthroughGateInput =
  | { transport: "rest"; config: RestProviderGateConfig; request: RestPassthroughRequest }
  | { transport: "graphql"; request: GraphqlPassthroughRequest };

export function assertReadableRequest(input: PassthroughGateInput): ReadGateResult {
  return input.transport === "graphql"
    ? assertReadableGraphqlRequest(input.request)
    : assertReadableRestRequest(input.config, input.request);
}
