/**
 * General invocation tier — read-only passthrough (ADR-0074 rung-a, epic #271).
 *
 * The curated typed tier (ADR-0071) is deliberately small and sized to the hot
 * path; it can never be an API mirror. This module owns the *browser-safe*
 * cross-boundary shapes for the general read-only passthrough tier that serves
 * the long tail the curated tier deliberately doesn't cover: one raw,
 * uncurated, read-only request per integration, executed by Alfred's trusted
 * boundary.
 *
 * Only the shared contracts live here (contracts is zod-only, client-safe),
 * plus the browser-safe payload bounding ({@link PassthroughTruncation};
 * `boundPassthroughBody` in `./passthrough-bounds`), which is shared with the
 * raw MCP client and so cannot sit inside either consuming tier. The rest of
 * the security boundary — the pure read gate, the per-provider transport
 * config, and the result shaper — lives beside the curated tools in
 * `@alfred/api` (`modules/tools/passthrough`). The Settings UI reads the
 * coverage/preference exports here so there is no third provider list.
 */

import { z } from "zod";
import {
  isToolName,
  LOADABLE_INTEGRATION_SLUGS,
  type LoadableIntegrationSlug,
  type ToolName,
} from "./tools";

/**
 * Whether the general tier covers an integration. Exhaustive by construction:
 * {@link GENERAL_INVOCATION_COVERAGE} is `Record<LoadableIntegrationSlug, …>`,
 * so adding a slug to {@link LOADABLE_INTEGRATION_SLUGS} without classifying it
 * here is a compile error — coverage can never silently drift from the canonical
 * slug list.
 */
export type CoverageDecision = "supported" | "deferred" | "not_applicable";

/**
 * The single source of truth for which integrations the general tier serves.
 *
 * - `supported`: has a live integration client, so a passthrough tool ships.
 * - `deferred`: no live integration client yet (Slack, Linear).
 * - `not_applicable`: no provider API to pass through (iMessage is ingest-only).
 */
export const GENERAL_INVOCATION_COVERAGE = {
  gmail: "supported",
  calendar: "supported",
  drive: "supported",
  docs: "supported",
  sheets: "supported",
  slides: "supported",
  slack: "deferred",
  linear: "deferred",
  github: "supported",
  notion: "supported",
  railway: "supported",
  vercel: "supported",
  imessage: "not_applicable",
} as const satisfies Record<LoadableIntegrationSlug, CoverageDecision>;

/**
 * The type-level subset of integrations marked `supported`. The API-side handler
 * registry is keyed by this, so flipping a coverage decision to `supported` is a
 * compile error until its config, gate, transport, tool action, and preference
 * are wired.
 */
export type SupportedIntegrationSlug = {
  [K in LoadableIntegrationSlug]: (typeof GENERAL_INVOCATION_COVERAGE)[K] extends "supported"
    ? K
    : never;
}[LoadableIntegrationSlug];

/** Runtime list of the supported slugs, derived from (and pinned to) the coverage map. */
export const SUPPORTED_PASSTHROUGH_SLUGS: readonly SupportedIntegrationSlug[] =
  LOADABLE_INTEGRATION_SLUGS.filter(
    (slug): slug is SupportedIntegrationSlug => GENERAL_INVOCATION_COVERAGE[slug] === "supported",
  );

export function isSupportedPassthroughSlug(value: string): value is SupportedIntegrationSlug {
  return (SUPPORTED_PASSTHROUGH_SLUGS as readonly string[]).includes(value);
}

/**
 * Transport shape per supported integration. REST providers take a
 * method/path/query/body request; Railway takes a GraphQL document. Keyed by the
 * supported subset so a new supported slug must declare its transport.
 */
export type PassthroughTransportKind = "rest" | "graphql";

export const PASSTHROUGH_TRANSPORT = {
  gmail: "rest",
  calendar: "rest",
  drive: "rest",
  docs: "rest",
  sheets: "rest",
  slides: "rest",
  github: "rest",
  notion: "rest",
  vercel: "rest",
  railway: "graphql",
} as const satisfies Record<SupportedIntegrationSlug, PassthroughTransportKind>;

/** Supported slugs whose transport is REST. */
export type SupportedRestSlug = {
  [K in SupportedIntegrationSlug]: (typeof PASSTHROUGH_TRANSPORT)[K] extends "rest" ? K : never;
}[SupportedIntegrationSlug];

/** Supported slugs whose transport is GraphQL. */
export type SupportedGraphqlSlug = {
  [K in SupportedIntegrationSlug]: (typeof PASSTHROUGH_TRANSPORT)[K] extends "graphql" ? K : never;
}[SupportedIntegrationSlug];

export const SUPPORTED_REST_PASSTHROUGH_SLUGS: readonly SupportedRestSlug[] =
  SUPPORTED_PASSTHROUGH_SLUGS.filter(
    (slug): slug is SupportedRestSlug => PASSTHROUGH_TRANSPORT[slug] === "rest",
  );

/**
 * The tool `action` each transport registers: REST providers expose
 * `<slug>.request`; Railway's GraphQL transport exposes `railway.graphql`. The
 * single source for that mapping — the registration test and the dispatcher's
 * per-run ceiling both derive passthrough tool identity from here rather than
 * re-hardcoding the action strings.
 */
export const PASSTHROUGH_TOOL_ACTION = {
  rest: "request",
  graphql: "graphql",
} as const satisfies Record<PassthroughTransportKind, string>;

/**
 * The exact registered tool names of the passthrough tier (`github.request`,
 * `railway.graphql`, …), derived from the supported slugs and their transports.
 * The dispatcher's per-run passthrough ceiling counts prior calls against this
 * set, so a new supported slug is bounded automatically.
 */
export const PASSTHROUGH_TOOL_NAMES: readonly ToolName[] = SUPPORTED_PASSTHROUGH_SLUGS.map(
  (slug) => {
    const name = `${slug}.${PASSTHROUGH_TOOL_ACTION[PASSTHROUGH_TRANSPORT[slug]]}`;
    // Constructed from registered slugs + actions; validate rather than cast so a
    // future drift (a supported slug whose action isn't registered) fails loudly
    // at module load instead of silently widening to a non-existent tool name.
    if (!isToolName(name)) throw new Error(`Passthrough tool name is not registered: ${name}`);
    return name;
  },
);

// ---------------------------------------------------------------------------
// Per-user rollout preference (default OFF — a security-sensitive tier must be
// killable per-integration without a deploy).
// ---------------------------------------------------------------------------

/**
 * Preference key prefix for the per-integration passthrough toggle. These live
 * under `feature.passthrough.<slug>` in `user_preferences` but, unlike the
 * background-agent `feature.*` flags (UNSET = ON), this tier is **default OFF**:
 * an absent row means the tool is unavailable. See {@link isPassthroughPreferenceOn}.
 */
export const PASSTHROUGH_PREFERENCE_PREFIX = "feature.passthrough." as const;

export function passthroughPreferenceKey(slug: SupportedIntegrationSlug): string {
  return `${PASSTHROUGH_PREFERENCE_PREFIX}${slug}`;
}

export const PASSTHROUGH_PREFERENCE_KEYS: Record<SupportedIntegrationSlug, string> =
  Object.fromEntries(
    SUPPORTED_PASSTHROUGH_SLUGS.map((slug) => [slug, passthroughPreferenceKey(slug)]),
  ) as Record<SupportedIntegrationSlug, string>;

/**
 * Resolve a stored passthrough preference value to on/off. **Default OFF**: only
 * an explicit truthy value (`true` / `"true"` / `1`) enables the tier — the
 * inverse of `flagOn` (background-agent flags default ON). An absent row is
 * `undefined`, which is OFF.
 */
export function isPassthroughPreferenceOn(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

// ---------------------------------------------------------------------------
// Request shapes. Deliberately smaller than `fetch`: the model composes a
// method + namespace-relative path + params (or a GraphQL document), never an
// absolute URL, origin, or headers — those are pinned by the trusted boundary.
//
// Note `method` is a free string, not a read-method enum: a mistaken write
// method must reach the *read gate* and come back as a VISIBLE `rejected`
// envelope the model can self-correct from — not a hidden `invalid_input` Zod
// failure. The same reasoning keeps `path` permissive here (the gate hardens it).
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
  /** Accepted only for an allowlisted read-via-POST path (enforced by the gate). */
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
// The read gate (security boundary) result. Pure, deny-by-default, per-integration.
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

/**
 * The read gate's decision. Encodes deny-by-default precisely: `ok: true` is the
 * only way through, and every denial carries a machine reason plus a
 * human/model-readable `detail` used to build the visible rejection envelope.
 */
export type ReadGateResult = { ok: true } | { ok: false; reason: ReadGateReason; detail: string };

// ---------------------------------------------------------------------------
// Result envelope (inherits ADR-0071 #6 result-honesty). Passthrough cannot
// pre-validate params, so it surfaces the raw outcome and is explicit about
// non-completion — the boss must never mistake a wrong-path error for "nothing".
// ---------------------------------------------------------------------------

export const TRANSPORT_ERROR_KINDS = ["timeout", "dns", "connection_reset", "tls"] as const;
export type TransportErrorKind = (typeof TRANSPORT_ERROR_KINDS)[number];

/**
 * Emitted whenever a passthrough result is clipped. The "thermometer" signal
 * (ADR-0074): its presence marks the result handle-eligible and drives the
 * telemetry that decides when to build the object-handle layer (L0).
 */
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
      /** The request never left Alfred — the read gate denied it. */
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
