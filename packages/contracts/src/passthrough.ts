/**
 * Shared shapes for the read-only passthrough tier (ADR-0074 rung-a): one raw read request
 * per integration, for what the curated tools do not cover. Coverage comes from
 * `INTEGRATIONS[slug].passthrough` (ADR-0093). The read gate and transport live in `@alfred/assistant`.
 */

import { z } from "zod";
import {
  INTEGRATIONS,
  SUPPORTED_PASSTHROUGH_SLUGS,
  type PassthroughTransportKind,
  type SupportedPassthroughSlug,
} from "./integrations";
import { isToolName, type ToolName } from "./tools";

/** Tool action per transport: `<slug>.request` or `<slug>.graphql`. */
export const PASSTHROUGH_TOOL_ACTION = {
  rest: "request",
  graphql: "graphql",
} as const satisfies Record<PassthroughTransportKind, string>;

/** Every passthrough tool name. The per-run passthrough ceiling counts calls against this set. */
export const PASSTHROUGH_TOOL_NAMES: readonly ToolName[] = SUPPORTED_PASSTHROUGH_SLUGS.map(
  (slug) => {
    const name = `${slug}.${PASSTHROUGH_TOOL_ACTION[INTEGRATIONS[slug].passthrough.transport]}`;

    // Validate, not cast, so an unregistered name fails at module load.
    if (!isToolName(name)) throw new Error(`Passthrough tool name is not registered: ${name}`);

    return name;
  },
);

// ---------------------------------------------------------------------------
// Per-integration preference. Default OFF, so the tier can be turned off without a deploy.
// ---------------------------------------------------------------------------

/** Unlike other `feature.*` flags, an absent row means OFF. */
export const PASSTHROUGH_PREFERENCE_PREFIX = "feature.passthrough." as const;

export function passthroughPreferenceKey(slug: SupportedPassthroughSlug): string {
  return `${PASSTHROUGH_PREFERENCE_PREFIX}${slug}`;
}

export const PASSTHROUGH_PREFERENCE_KEYS: Record<SupportedPassthroughSlug, string> =
  // SAFETY: the keys are exactly SUPPORTED_PASSTHROUGH_SLUGS; `fromEntries` erases that.
  Object.fromEntries(
    SUPPORTED_PASSTHROUGH_SLUGS.map((slug) => [slug, passthroughPreferenceKey(slug)]),
  ) as Record<SupportedPassthroughSlug, string>;

/** Only an explicit `true`, `"true"`, or `1` turns the tier on. */
export function isPassthroughPreferenceOn(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

// ---------------------------------------------------------------------------
// Request shapes. No URL, origin, or headers: Alfred pins those.
// `method` and `path` stay loose so a bad value reaches the read gate and comes back
// as a visible `rejected` result the model can correct, not a Zod error.
// ---------------------------------------------------------------------------

export const restPassthroughRequestSchema = z.object({
  method: z
    .string()
    .min(1)
    .describe(
      "HTTP method. Only GET, HEAD, and a small set of provider-allowlisted read-via-POST endpoints are permitted; any write method is rejected at the boundary.",
    ),
  path: z
    .string()
    .min(1)
    .describe(
      "A namespace-relative path beginning with '/' (e.g. '/repos/owner/name/actions/runs'). Never an absolute URL, origin, or host — those are pinned by Alfred. Put query parameters in the separate 'query' field, not here.",
    ),
  query: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
    .optional()
    .describe("Query-string parameters, appended and encoded by Alfred."),
  body: z
    .unknown()
    .optional()
    .describe(
      "JSON request body — accepted only for an allowlisted read-via-POST endpoint (e.g. a Notion search/query). Ignored for GET/HEAD.",
    ),
});

export type RestPassthroughRequest = z.infer<typeof restPassthroughRequestSchema>;

export const graphqlPassthroughRequestSchema = z.object({
  document: z
    .string()
    .min(1)
    .describe(
      'A read-only GraphQL query document. Must contain only `query`/introspection operations — any `mutation` or `subscription` is rejected. Prefer a targeted `__type(name: "…")` over a full `__schema` dump, which is truncated.',
    ),
  variables: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("JSON-compatible variables referenced by the document."),
  operationName: z
    .string()
    .optional()
    .describe("Required only when the document defines more than one operation."),
});

export type GraphqlPassthroughRequest = z.infer<typeof graphqlPassthroughRequestSchema>;

export type PassthroughRequest = RestPassthroughRequest | GraphqlPassthroughRequest;

// ---------------------------------------------------------------------------
// Read gate result. Deny by default.
// ---------------------------------------------------------------------------

export const READ_GATE_REASONS = [
  "method_not_read",
  "path_not_allowlisted",
  "invalid_path",
  "graphql_non_query",
  "graphql_operation_ambiguous",
  "auth_scope_unreachable",
] as const;

export type ReadGateReason = (typeof READ_GATE_REASONS)[number];

export type ReadGateResult = { ok: true } | { ok: false; reason: ReadGateReason; detail: string };

// ---------------------------------------------------------------------------
// Result envelope (ADR-0071 #6). Explicit about failure, so a wrong-path error never reads as "nothing".
// ---------------------------------------------------------------------------

export const TRANSPORT_ERROR_KINDS = ["timeout", "dns", "connection_reset", "tls"] as const;

export type TransportErrorKind = (typeof TRANSPORT_ERROR_KINDS)[number];

/** Present when a result was clipped. Marks it handle-eligible (ADR-0074). */
export interface PassthroughTruncation {
  handleEligible: true;
  originalBytesApprox: number;
  returnedBytes: number;
  causes: Array<
    | { kind: "string_chars"; droppedApprox: number }
    | { kind: "array_items"; droppedApprox: number }
    | { kind: "body_bytes"; droppedApprox: number }
  >;
}

export type PassthroughResult =
  | {
      /** The API answered, including 4xx/5xx. */
      outcome: "http";
      /** Real HTTP status; a GraphQL error may still be HTTP 200. */
      status: number;
      /** 2xx and, for GraphQL, no `errors[]`. */
      succeeded: boolean;
      /** Sanitized + bounded, including API error bodies. */
      body: unknown;
      truncation?: PassthroughTruncation;
    }
  | {
      /** The read gate denied it; nothing was sent. */
      outcome: "rejected";
      reason: ReadGateReason;
      message: string;
    }
  | {
      /** The request left Alfred but no HTTP response arrived. */
      outcome: "transport";
      kind: TransportErrorKind;
      retryable: boolean;
      message: string;
    };
