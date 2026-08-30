/**
 * Browser-safe MCP cross-boundary contracts: the `mcp.call` / `mcp.list_tools`
 * argument envelopes and the literal unions that back the persisted MCP tables
 * (`packages/db/src/schema/mcp.ts`) and the execution broker
 * (`packages/assistant/src/tool-runtime/mcp/`).
 *
 * These are the shapes the web client, the model-facing tool surface, and the
 * DB layer must all agree on. Everything that depends on the MCP SDK or
 * `node:crypto` (the raw client, the protocol, the SHA-256 ambiguity-barrier
 * hash) stays server-side in `@alfred/assistant`; only the wire-visible enums and the
 * two projected-tool argument schemas live here.
 */

import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "./user-model";

// ---------------------------------------------------------------------------
// Connection state machine (durable half). Owned here so the DB column
// (`mcp_connections.status`) and any future web surface share one vocabulary.
// disconnected → connecting → ready → stale → auth_required → failed.
// ---------------------------------------------------------------------------
export const mcpConnectionStatusValues = [
  "disconnected",
  "connecting",
  "ready",
  "stale",
  "auth_required",
  "failed",
] as const;
export type McpConnectionStatus = (typeof mcpConnectionStatusValues)[number];
export const mcpConnectionStatusSchema = z.enum(mcpConnectionStatusValues);

// ---------------------------------------------------------------------------
// Browser-safe mirror of the negotiated server identity. The runtime type
// lives in `packages/assistant/src/connections/mcp/protocol.ts` (SDK-bound); this is the
// persisted/`$type` snapshot stored on `mcp_connections.server_identity`.
// ---------------------------------------------------------------------------
export const mcpServerIdentitySchema = z.object({
  protocolVersion: z.string(),
  serverName: z.string(),
  serverVersion: z.string(),
  hasTools: z.boolean(),
  toolsListChanged: z.boolean(),
});
export type McpServerIdentity = z.infer<typeof mcpServerIdentitySchema>;

// ---------------------------------------------------------------------------
// Reviewed per-tool effect/retry semantics (mcp_tool_policy). These are
// deliberately SEPARATE from the approval risk tier: a low-risk write still
// receives ambiguous-write protection, and a reviewed read can use read-safe
// failure handling independently of its approval tier (issue clarification #3).
// Defaults are conservative: unknown effect handled as effectful, never retry.
// ---------------------------------------------------------------------------
export const mcpEffectClassValues = ["read", "write", "unknown"] as const;
export type McpEffectClass = (typeof mcpEffectClassValues)[number];
export const mcpEffectClassSchema = z.enum(mcpEffectClassValues);

export const mcpRetryContractValues = ["never", "same_key", "reconcile"] as const;
export type McpRetryContract = (typeof mcpRetryContractValues)[number];
export const mcpRetryContractSchema = z.enum(mcpRetryContractValues);

// ---------------------------------------------------------------------------
// Operation-ledger axes (mcp_invocation). Three distinct concepts, per the
// ambiguous-write design (docs/research/mcp-ambiguous-write-outcomes.md):
//
//  - attempt lifecycle: what Alfred knows it locally did. `delivery_possible`
//    is persisted BEFORE the raw-client call so a crash mid-flight still leaves
//    durable evidence the write is ambiguous (issue clarification #1).
//  - effect outcome: what Alfred can prove about the remote effect.
//  - retry disposition: what the broker may do next.
// ---------------------------------------------------------------------------
export const mcpAttemptLifecycleValues = [
  "prepared",
  "delivery_possible",
  "response_received",
] as const;
export type McpAttemptLifecycle = (typeof mcpAttemptLifecycleValues)[number];
export const mcpAttemptLifecycleSchema = z.enum(mcpAttemptLifecycleValues);

export const mcpEffectOutcomeValues = ["succeeded", "rejected", "failed", "unknown"] as const;
export type McpEffectOutcome = (typeof mcpEffectOutcomeValues)[number];
export const mcpEffectOutcomeSchema = z.enum(mcpEffectOutcomeValues);

export const mcpRetryDispositionValues = ["safe", "blocked", "reconcile", "same_key_only"] as const;
export type McpRetryDisposition = (typeof mcpRetryDispositionValues)[number];
export const mcpRetryDispositionSchema = z.enum(mcpRetryDispositionValues);

// ---------------------------------------------------------------------------
// Explicit recovery operations. These are safe product projections: the raw
// staging proposal and decided input remain server-side.
// ---------------------------------------------------------------------------
export const mcpRecoveryDecisionSchema = z.enum(["confirmed_succeeded", "confirmed_not_applied"]);
export type McpRecoveryDecision = z.infer<typeof mcpRecoveryDecisionSchema>;

const mcpRecoveryOperationBaseSchema = z.object({
  invocationId: z.string(),
  connection: z.object({ id: z.string(), label: z.string() }).strict(),
  remoteName: z.string(),
  displayInput: jsonValueSchema.nullable(),
  lastError: z.string().nullable(),
  traceId: z.string().nullable(),
  stepId: z.string().nullable(),
  toolCallId: z.string().nullable(),
});

/**
 * A product recovery row is one of two exact durable states:
 *
 * - an ambiguous call that crossed the delivery boundary; or
 * - a user-authorized successor that was reserved but did not reach delivery.
 *
 * Keeping the prepared successor's outcome, disposition, and delivery timestamp
 * null is load-bearing. It proves that a restart or failed pre-claim attempt did
 * not silently classify or send the operation.
 */
export const mcpRecoveryOperationSchema = z.union([
  mcpRecoveryOperationBaseSchema
    .extend({
      successorOf: z.string(),
      attemptLifecycle: z.literal("prepared"),
      effectOutcome: z.null(),
      retryDisposition: z.null(),
      deliveryPossibleAt: z.null(),
      responseReceivedAt: z.null(),
    })
    .strict(),
  mcpRecoveryOperationBaseSchema
    .extend({
      successorOf: z.string().nullable(),
      attemptLifecycle: z.enum(["delivery_possible", "response_received"]),
      effectOutcome: z.literal("unknown"),
      retryDisposition: z.literal("blocked"),
      deliveryPossibleAt: z.coerce.date(),
      responseReceivedAt: z.coerce.date().nullable(),
    })
    .strict(),
]);
export type McpRecoveryOperation = z.infer<typeof mcpRecoveryOperationSchema>;

/** Twenty keeps the card-heavy recovery view bounded while showing a useful batch. */
export const MCP_RECOVERY_PAGE_SIZE = 20;
export const mcpRecoveryCursorSchema = z.string().min(1);
export const mcpRecoveryOperationsPageQuerySchema = z
  .object({ cursor: mcpRecoveryCursorSchema.optional() })
  .strict();
export type McpRecoveryOperationsPageQuery = z.infer<typeof mcpRecoveryOperationsPageQuerySchema>;
export const mcpRecoveryOperationsPageInputSchema = mcpRecoveryOperationsPageQuerySchema
  .extend({ userId: z.string().min(1) })
  .strict();
export type McpRecoveryOperationsPageInput = z.infer<typeof mcpRecoveryOperationsPageInputSchema>;
export const mcpRecoveryOperationsPageSchema = z
  .object({
    operations: z.array(mcpRecoveryOperationSchema).max(MCP_RECOVERY_PAGE_SIZE),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();
export type McpRecoveryOperationsPage = z.infer<typeof mcpRecoveryOperationsPageSchema>;

export const mcpRecoveryMutationStatusSchema = z.enum([
  "resolved",
  "completed",
  "tool_error",
  "ambiguous",
  "blocked",
]);
export const mcpRecoveryMutationResultSchema = z
  .object({
    status: mcpRecoveryMutationStatusSchema,
    invocationId: z.string(),
    successorInvocationId: z.string().nullable(),
  })
  .strict();
export type McpRecoveryMutationResult = z.infer<typeof mcpRecoveryMutationResultSchema>;

// ---------------------------------------------------------------------------
// Content-block kinds (#541). The CLOSED set the MCP `ContentBlock` union
// admits, plus an explicit `unknown` tail. The SDK validates every block
// against this union before a result reaches Alfred, so an out-of-set `type`
// cannot occur for a validated result; `unknown` is the documented fallback for
// any future/degraded shape rather than an open string space. Keeping the key
// space closed lets an audit-view reader switch on a finite set and matches the
// repo rule that an enum-keyed map uses `z.partialRecord`, not `z.record`.
// ---------------------------------------------------------------------------
export const mcpContentKindValues = [
  "text",
  "image",
  "audio",
  "resource_link",
  "resource",
  "unknown",
] as const;
export type McpContentKind = (typeof mcpContentKindValues)[number];
export const mcpContentKindSchema = z.enum(mcpContentKindValues);

// ---------------------------------------------------------------------------
// Result-provenance envelope (#541). The durable, bounded record of what a
// remote MCP server ACTUALLY returned — persisted on the invocation ledger row
// (`mcp_invocation.result_provenance`) independently of the sanitized prose the
// model reads (`action_stagings.execute_result`). It keeps the facts an operator
// needs to reconstruct an effectful attempt — the server's own error signal,
// structured-output validity, a content-kind census, and whether the model
// projection was clipped — WITHOUT the payload itself: no block content, no
// fetched resource links (they are counted, never dereferenced), no unbounded
// remote text. Connection/tool/catalog provenance is NOT duplicated here — it is
// already on the invocation row this envelope hangs off, and the audit view is
// the join of the two.
// ---------------------------------------------------------------------------
export const mcpResultProvenanceSchema = z.object({
  /** The server reported a tool problem after execution; this does not prove no effect. */
  isError: z.boolean(),
  /** The raw result carried a `structuredContent` field at all. */
  hasStructuredContent: z.boolean(),
  /**
   * A declared output schema was present AND the structured content validated
   * against it. `false` covers three cases: no output schema was declared; the
   * call was a tool-level error (validation is skipped); OR the structured
   * output FAILED its declared schema. The failure case still records an
   * envelope: the raw client throws `invalid_output` AFTER the response crossed
   * the wire and carries this census on the error, so the broker persists it for
   * the (ambiguous) outcome rather than leaving prose as the only durable copy.
   */
  outputSchemaValidated: z.boolean(),
  /** Number of content blocks the raw result carried. */
  contentBlockCount: z.number().int().nonnegative(),
  /**
   * Census of content blocks by their MCP `type`. Keyed by the closed
   * `ContentBlock` set (`text`/`image`/`audio`/`resource`/`resource_link`), with
   * `unknown` as the explicit tail for any degraded/future shape. Counts only —
   * never block content, and a returned resource link is recorded here, never
   * dereferenced. Partial: only kinds actually present appear.
   */
  contentKinds: z.partialRecord(mcpContentKindSchema, z.number().int().nonnegative()),
  /** The model projection was bounded/clipped on the way out. */
  truncated: z.boolean(),
});
export type McpResultProvenance = z.infer<typeof mcpResultProvenanceSchema>;

// ---------------------------------------------------------------------------
// Projected-tool argument envelopes. The open-ended external tool reference
// (connection + remote name + catalog revision) rides in the ARGS, never in the
// closed `ToolName`. The opaque MCP `arguments` object is carried as a JSON
// record and is NOT reshaped here — the authoritative, exact-schema,
// no-coercion validation stays in `McpRawClient.callTool`. Because `mcp.call`'s
// external ref lives in args, `canonicalJson(input)` folds it into the generic
// staging input hash for free, so a catalog-drifted re-proposal re-stages.
// ---------------------------------------------------------------------------
export const mcpExternalToolRefSchema = z
  .object({
    kind: z.literal("mcp"),
    connectionId: z.string().min(1),
    remoteName: z.string().min(1),
    /**
     * The catalog revision the model selected this tool under. A mismatch against
     * the live catalog is a VISIBLE re-resolve signal (the raw client throws
     * `catalog_stale`), not a silent Zod strip.
     */
    catalogRevision: z.string().min(1),
  })
  .strict();
export type ExternalToolRef = z.infer<typeof mcpExternalToolRefSchema>;

export const mcpCallInput = z
  .object({
    ...mcpExternalToolRefSchema.omit({ kind: true }).shape,
    /**
     * Opaque MCP arguments — a JSON object, unreshaped. `z.record` keeps all
     * string keys (no stripping) so nothing a JSON-Schema-valid MCP call needs is
     * lost crossing dispatch's envelope re-parse.
     */
    arguments: jsonObjectSchema,
  })
  .strict();
export type McpCallInput = z.infer<typeof mcpCallInput>;

/**
 * Discovery is a bounded, local read of Alfred's already-validated catalog. It
 * never dumps the raw client's 1 MB / 1,000-tool ceiling into one result:
 * compact summaries by default, a bounded full descriptor only for an
 * explicitly selected `remoteName` (issue clarification #5).
 */
export const MCP_LIST_TOOLS_MAX_LIMIT = 50;
export const MCP_LIST_TOOLS_DEFAULT_LIMIT = 25;

/**
 * How much of each tool a page carries. Two tiers only, and deliberately no
 * `"full"`: a full descriptor is bounded at 128 KB at ingest, so a page of them
 * would reinstate exactly the catalog dump clarification #5 exists to prevent.
 * The full descriptor is reachable one tool at a time, via `remoteName`.
 *
 *  - `summary` (default): name + title + clipped description — enough to choose.
 *  - `names`: name only. A survey tier for a wide catalog, where the descriptions
 *    dominate the page and the model only needs to know what exists before
 *    narrowing with `query` or asking for one descriptor.
 */
export const mcpListToolsDetailValues = ["names", "summary"] as const;
export type McpListToolsDetail = (typeof mcpListToolsDetailValues)[number];
export const mcpListToolsDetailSchema = z.enum(mcpListToolsDetailValues);

export const mcpToolSearchInputSchema = z
  .object({
    /** Free-text filter over visible tool and connection fields. */
    query: z.string().max(200).optional(),
    /** Exact owned MCP server id. */
    namespace: z.string().min(1).optional(),
    /** Exact owned named-connection id. */
    connectionId: z.string().min(1).optional(),
    /** Page density; see {@link mcpListToolsDetailValues}. Defaults to `summary`. */
    detail: mcpListToolsDetailSchema.optional(),
    /** Opaque pagination cursor returned by a prior page. */
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().positive().max(MCP_LIST_TOOLS_MAX_LIMIT).optional(),
  })
  .strict();
export type McpToolSearchInput = z.infer<typeof mcpToolSearchInputSchema>;

export const mcpToolInspectInputSchema = z
  .object({
    ref: mcpExternalToolRefSchema,
  })
  .strict();
export type McpToolInspectInput = z.infer<typeof mcpToolInspectInputSchema>;

/**
 * The same strict search-or-inspect union, represented as one top-level object
 * because model providers require every tool input JSON Schema to declare
 * `type: "object"` at the root.
 */
export const mcpListToolsInput = z
  .object({
    ...mcpToolSearchInputSchema.shape,
    ref: mcpExternalToolRefSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.ref === undefined) return;
    const searchKeys = ["query", "namespace", "connectionId", "detail", "cursor", "limit"] as const;
    if (searchKeys.some((key) => input[key] !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "MCP tool inspection accepts only an exact ref",
      });
    }
  });
export type McpListToolsInput = McpToolInspectInput | McpToolSearchInput;

export const mcpDiscoveryConnectionSchema = z
  .object({
    id: z.string().min(1),
    instanceKey: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();
export type McpDiscoveryConnection = z.infer<typeof mcpDiscoveryConnectionSchema>;

export const mcpToolDiscoveryHitSchema = z
  .object({
    ref: mcpExternalToolRefSchema,
    namespace: z.string().min(1),
    connection: mcpDiscoveryConnectionSchema,
    title: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();
export type McpToolDiscoveryHit = z.infer<typeof mcpToolDiscoveryHitSchema>;

export const mcpToolDiscoveryPageSchema = z
  .object({
    status: z.literal("tools"),
    tools: z.array(mcpToolDiscoveryHitSchema).max(MCP_LIST_TOOLS_MAX_LIMIT),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();
export type McpToolDiscoveryPage = z.infer<typeof mcpToolDiscoveryPageSchema>;

export const mcpToolInspectionSuccessSchema = z
  .object({
    status: z.literal("tool"),
    ref: mcpExternalToolRefSchema,
    connection: mcpDiscoveryConnectionSchema,
    tool: jsonObjectSchema,
  })
  .strict();
export type McpToolInspectionSuccess = z.infer<typeof mcpToolInspectionSuccessSchema>;

export const mcpToolInspectionNotFoundSchema = z
  .object({
    status: z.literal("not_found"),
    ref: mcpExternalToolRefSchema,
    message: z.string(),
  })
  .strict();
export type McpToolInspectionNotFound = z.infer<typeof mcpToolInspectionNotFoundSchema>;

export const mcpToolInspectionCatalogStaleSchema = z
  .object({
    status: z.literal("catalog_stale"),
    ref: mcpExternalToolRefSchema,
    message: z.string(),
  })
  .strict();
export type McpToolInspectionCatalogStale = z.infer<typeof mcpToolInspectionCatalogStaleSchema>;

export const mcpToolInspectionResultSchema = z.union([
  mcpToolInspectionSuccessSchema,
  mcpToolInspectionNotFoundSchema,
  mcpToolInspectionCatalogStaleSchema,
]);
export type McpToolInspectionResult = z.infer<typeof mcpToolInspectionResultSchema>;
