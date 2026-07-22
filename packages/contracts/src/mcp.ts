/**
 * Browser-safe MCP cross-boundary contracts: the `mcp.call` / `mcp.list_tools`
 * argument envelopes and the literal unions that back the persisted MCP tables
 * (`packages/db/src/schema/mcp.ts`) and the execution broker
 * (`packages/api/src/modules/mcp/`).
 *
 * These are the shapes the web client, the model-facing tool surface, and the
 * DB layer must all agree on. Everything that depends on the MCP SDK or
 * `node:crypto` (the raw client, the protocol, the SHA-256 ambiguity-barrier
 * hash) stays server-side in `@alfred/api`; only the wire-visible enums and the
 * two projected-tool argument schemas live here.
 */

import { z } from "zod";
import { jsonObjectSchema } from "./user-model";

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
// lives in `packages/api/src/modules/mcp/protocol.ts` (SDK-bound); this is the
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

export const mcpRetryDispositionValues = [
  "safe",
  "blocked",
  "reconcile",
  "same_key_only",
] as const;
export type McpRetryDisposition = (typeof mcpRetryDispositionValues)[number];
export const mcpRetryDispositionSchema = z.enum(mcpRetryDispositionValues);

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
  /** The server's own `isError` signal — a tool-level rejection, not transport. */
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
export const mcpCallInput = z.object({
  connectionId: z.string().min(1),
  remoteName: z.string().min(1),
  /**
   * The catalog revision the model selected this tool under. A mismatch against
   * the live catalog is a VISIBLE re-resolve signal (the raw client throws
   * `catalog_stale`), not a silent Zod strip.
   */
  catalogRevision: z.string().min(1),
  /**
   * Opaque MCP arguments — a JSON object, unreshaped. `z.record` keeps all
   * string keys (no stripping) so nothing a JSON-Schema-valid MCP call needs is
   * lost crossing dispatch's envelope re-parse.
   */
  arguments: jsonObjectSchema,
});
export type McpCallInput = z.infer<typeof mcpCallInput>;

/**
 * Discovery is a bounded, local read of Alfred's already-validated catalog. It
 * never dumps the raw client's 1 MB / 1,000-tool ceiling into one result:
 * compact summaries by default, a bounded full descriptor only for an
 * explicitly selected `remoteName` (issue clarification #5).
 */
export const MCP_LIST_TOOLS_MAX_LIMIT = 50;
export const MCP_LIST_TOOLS_DEFAULT_LIMIT = 25;
export const mcpListToolsInput = z.object({
  connectionId: z.string().min(1),
  /** Free-text filter over tool name/description. Untrusted data, not instructions. */
  query: z.string().max(200).optional(),
  /** Opaque pagination cursor returned by a prior page. */
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().positive().max(MCP_LIST_TOOLS_MAX_LIMIT).optional(),
  /** When set, return the bounded full descriptor for just this one tool. */
  remoteName: z.string().min(1).optional(),
  /** Echoed-back revision for drift detection; discovery returns the current view. */
  catalogRevision: z.string().optional(),
});
export type McpListToolsInput = z.infer<typeof mcpListToolsInput>;
