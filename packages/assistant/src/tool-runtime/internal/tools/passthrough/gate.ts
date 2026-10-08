import type {
  GraphqlPassthroughRequest,
  ReadGateReason,
  ReadGateResult,
  RestPassthroughRequest,
} from "@alfred/contracts";
import { Kind, OperationTypeNode, parse } from "graphql";
import type { RestProviderGateConfig } from "./config";

/**
 * The read gate: the security boundary of the passthrough tier. Deny by default.
 * The method gate and POST allowlist, not token scope, keep writes out (ADR-0074).
 * The model supplies only a relative path and params, never an origin or headers.
 */

const READ_METHODS = new Set(["GET", "HEAD", "POST"]);

// C0 controls plus DEL.
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

/** Reject any path that could escape the pinned namespace or smuggle authority or query text. */
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

  // An encoded separator would slip past the per-segment dot check below.
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

/** Pass GET/HEAD (minus the denylists) and allowlisted POST reads. New GET endpoints pass without curation. */
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

  if (!matchesAny(request.path, config.readViaPostAllowlist)) {
    return rejectAllowlist(
      "POST is permitted only for this provider's allowlisted read endpoints (e.g. a query/search). This path is not one of them.",
    );
  }

  return { ok: true };
}

/**
 * GraphQL is all POST, so parse the AST (a text scan is fooled by strings and comments).
 * Reject the whole document if any operation mutates or subscribes, even an unselected one.
 */
export function assertReadableGraphqlRequest(request: GraphqlPassthroughRequest): ReadGateResult {
  let document;

  try {
    document = parse(request.document);
  } catch {
    // An unparseable document cannot be proven read-only.
    return rejectGraphqlNonQuery(
      "The GraphQL document could not be parsed. Send a single valid, read-only query document.",
    );
  }

  const operations = document.definitions.filter(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );

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
