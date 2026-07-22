import type {
  McpAttemptLifecycle,
  McpConnectionStatus,
  McpEffectClass,
  McpEffectOutcome,
  McpResultProvenance,
  McpRetryContract,
  McpRetryDisposition,
  McpServerIdentity,
  ToolRiskTier,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { actionStagings } from "./action-policies";
import { user } from "./auth";

// ===========================================================================
// MCP persistence (PRD #540). The layer ABOVE `McpRawClient`: durable
// connection/catalog facts, a reviewed per-tool policy, and a durable operation
// ledger for ambiguous writes. Amends ADR-0018.
//
// Definition order matters: `mcpCatalogRevisions` is declared FIRST because the
// composite "current revision" pointer FK on `mcpConnections` references its
// columns directly (evaluated synchronously in the table callback). The reverse
// `connectionId` FK uses a lazy `() => mcpConnections.id` thunk, so the forward
// reference resolves fine.
// ===========================================================================

/**
 * Immutable, append-only catalog authority + history. One row per atomically
 * published catalog snapshot; a revision is NEVER mutated tool-by-tool, so there
 * is no `updatedAt`. The connection row holds only a pointer to the current
 * revision (see `mcpConnections.currentCatalogRevisionId`).
 */
export const mcpCatalogRevisions = pgTable(
  "mcp_catalog_revisions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mcpr")),
    connectionId: text("connection_id")
      .notNull()
      // Explicit `AnyPgColumn` return breaks the TS inference cycle between this
      // table and `mcpConnections` (whose composite pointer FK references this
      // table's columns).
      .references((): AnyPgColumn => mcpConnections.id, { onDelete: "cascade" }),
    /** Stable authority hash = `McpCatalogSnapshot.revision` ("sha256:..."). */
    revisionHash: text("revision_hash").notNull(),
    /** Raw, validated descriptors exactly as admitted (`Tool[]`); the audit source. */
    descriptors: jsonb("descriptors").notNull(),
    /**
     * Per-tool descriptor hashes `{ [remoteName]: "sha256:..." }`, so an
     * approval/downgrade binds to ONE tool's descriptor: an unrelated tool
     * changing (which bumps the whole `revisionHash`) need not churn it.
     */
    descriptorHashes: jsonb("descriptor_hashes").$type<Record<string, string>>().notNull(),
    toolCount: integer("tool_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("mcp_catalog_revisions_conn_hash_idx").on(t.connectionId, t.revisionHash),
    // FK target for the connection's current-revision pointer: `(connectionId,
    // id)` must be unique so the composite FK below can bind a pointer to a
    // revision of the SAME connection (issue clarification #6).
    uniqueIndex("mcp_catalog_revisions_conn_id_idx").on(t.connectionId, t.id),
  ],
);

/**
 * Durable connection FACTS — owner, pinned endpoint/origin, negotiated identity,
 * status, and a pointer to the current catalog revision. NOT live SDK objects
 * (the connection manager re-hydrates a `McpRawClient` in memory on demand) and
 * NOT the catalog history.
 */
export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mcpc")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Human label shown in the (future) connection UI. */
    label: text("label").notNull(),
    /** Canonical MCP resource URI — the OAuth `resource` indicator. */
    canonicalResource: text("canonical_resource").notNull(),
    /** Pinned endpoint + origin. The model NEVER supplies these. */
    endpointUrl: text("endpoint_url").notNull(),
    endpointOrigin: text("endpoint_origin").notNull(),
    /** Selected authorization-server identity. Null for unauthenticated servers. */
    authServerIdentity: text("auth_server_identity"),
    /**
     * Reference to the Alfred→MCP-server credential. A nullable plain-text
     * column with NO foreign key in this slice: the dedicated MCP-credential
     * store is shaped in the OAuth slice, and `integration_credentials` is
     * deliberately NOT reused (the Alfred→MCP bearer is a distinct audience from
     * any downstream provider grant). Null = no auth required (offline fake).
     */
    credentialId: text("credential_id"),
    /** Granted scopes parsed to an array (mirrors `integration_credentials.scopes`). */
    grantedScopes: jsonb("granted_scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** disconnected | connecting | ready | stale | auth_required | failed. */
    status: text("status").$type<McpConnectionStatus>().notNull().default("disconnected"),
    /** Negotiated protocol version — v1 pins "2025-11-25". */
    negotiatedProtocolVersion: text("negotiated_protocol_version"),
    /** Server identity + capabilities snapshot. */
    serverIdentity: jsonb("server_identity").$type<McpServerIdentity>(),
    /**
     * Pointer to the currently-authoritative immutable revision. Nullable at
     * creation (a connection is inserted before its first catalog load). The
     * composite FK below guarantees a non-null pointer references a revision of
     * THIS connection — a connection can never point at another connection's
     * revision (issue clarification #6).
     */
    currentCatalogRevisionId: text("current_catalog_revision_id"),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("mcp_connections_user_resource_idx").on(t.userId, t.canonicalResource),
    index("mcp_connections_user_status_idx").on(t.userId, t.status),
    foreignKey({
      columns: [t.id, t.currentCatalogRevisionId],
      foreignColumns: [mcpCatalogRevisions.connectionId, mcpCatalogRevisions.id],
      name: "mcp_connections_current_revision_fk",
    }),
  ],
);

/**
 * Reviewed per-tool policy. The base risk tier of `mcp.call` is a static `high`
 * floor; this table carries the effective downgrade, bound to the EXACT reviewed
 * descriptor (descriptor drift → the resolver falls back to `high`). Effect and
 * retry semantics are persisted SEPARATELY from the approval risk tier: a
 * low-risk write still receives ambiguous-write protection, and a reviewed read
 * can use read-safe failure handling independently of its tier (clarification #3).
 */
export const mcpToolPolicy = pgTable(
  "mcp_tool_policy",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mcpp")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    remoteName: text("remote_name").notNull(),
    /** Binds the review to the exact descriptor it was granted for. */
    descriptorHash: text("descriptor_hash").notNull(),
    /** Bumped on each review edit; recorded on the invocation for audit. */
    policyRevision: integer("policy_revision").notNull().default(1),
    /** The reviewed approval tier (e.g. "low" for a routine read). */
    riskTier: text("risk_tier").$type<ToolRiskTier>().notNull(),
    /** read | write | unknown. Default unknown = handled conservatively as effectful. */
    effectClass: text("effect_class").$type<McpEffectClass>().notNull().default("unknown"),
    /** never | same_key | reconcile. v1 only ships "never". */
    retryContract: text("retry_contract").$type<McpRetryContract>().notNull().default("never"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedNote: text("reviewed_note"),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("mcp_tool_policy_conn_remote_desc_idx").on(
      t.connectionId,
      t.remoteName,
      t.descriptorHash,
    ),
  ],
);

/**
 * The operation ledger. A companion row 1:1 with an `action_stagings` row for an
 * effectful (`write`/`unknown`) MCP call, minted BEFORE network dispatch so a
 * crash mid-flight still leaves durable evidence the write is ambiguous.
 *
 * Three distinct axes (docs/research/mcp-ambiguous-write-outcomes.md):
 *  - `attemptLifecycle`: what Alfred locally did (`delivery_possible` is written
 *    before the raw-client call).
 *  - `effectOutcome`: what Alfred can prove about the remote effect.
 *  - `retryDisposition`: what the broker may do next.
 *
 * Kept LEAN (clarification #7): no pre-modeled `remote_idempotency_key` / `task_id`
 * / `business_correlation_id` columns — those are deferred, server-contract-
 * specific, and added by the implementation that can use them. This ledger
 * persists only the evidence for the blocked-unknown + explicit-successor path.
 */
export const mcpInvocation = pgTable(
  "mcp_invocation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mcpi")),
    /** 1:1 with the staging row that carries this call's approval/idempotency. */
    stagingId: text("staging_id")
      .notNull()
      .references(() => actionStagings.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    remoteName: text("remote_name").notNull(),
    /** Server-resolved catalog revision in effect for this call. */
    catalogRevisionId: text("catalog_revision_id").references(() => mcpCatalogRevisions.id, {
      onDelete: "cascade",
    }),
    /** The exact descriptor hash the call was authorized against. */
    descriptorHash: text("descriptor_hash"),
    /** The `mcp_tool_policy.policyRevision` that governed the effect/retry decision. */
    policyRevision: integer("policy_revision"),
    /**
     * SHA-256 over the canonical EFFECTIVE arguments — the security-relevant
     * ambiguity barrier key. Deliberately NOT the generic FNV-1a
     * `proposedInputHash` (clarification #6).
     */
    argsHash: text("args_hash").notNull(),
    /** read | write | unknown — the class that governed the ambiguity decision. */
    effectClass: text("effect_class").$type<McpEffectClass>().notNull().default("unknown"),
    /** prepared → delivery_possible → response_received. */
    attemptLifecycle: text("attempt_lifecycle")
      .$type<McpAttemptLifecycle>()
      .notNull()
      .default("prepared"),
    /** succeeded | rejected | failed | unknown. Null while in-flight. */
    effectOutcome: text("effect_outcome").$type<McpEffectOutcome>(),
    /** safe | blocked | reconcile | same_key_only. Null while in-flight. */
    retryDisposition: text("retry_disposition").$type<McpRetryDisposition>(),
    /**
     * A one-use host-minted successor authorization points here at the prior
     * invocation it supersedes. Only the authenticated approval boundary sets
     * this — the model cannot mint it (clarification #4).
     */
    successorOf: text("successor_of"),
    /**
     * Set when the operation reaches a terminal, non-blocking state (success,
     * definitive rejection, abandoned-before-delivery, or user-resolved
     * successor supersede). While NULL the operation is unresolved and, if
     * possibly delivered, blocks an identical repeat.
     */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionReason: text("resolution_reason"),
    lastError: text("last_error"),
    /**
     * Bounded, payload-free record of what the server actually returned (#541),
     * persisted SEPARATELY from the sanitized model projection in
     * `action_stagings.execute_result` so an effectful attempt stays
     * reconstructable for audit without prose being its only durable copy.
     * Null while in-flight and for any outcome with no received response
     * (blocked / ambiguous / pre-delivery failure). Shape: `McpResultProvenance`.
     */
    resultProvenance: jsonb("result_provenance").$type<McpResultProvenance>(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("mcp_invocation_staging_idx").on(t.stagingId),
    index("mcp_invocation_barrier_lookup_idx").on(t.connectionId, t.remoteName, t.argsHash),
    // The partial-barrier invariant: at most one UNRESOLVED operation may match a
    // proposal on (owner, connection, remote tool, canonical args hash). This is
    // broader than "unknown" on purpose — it protects unresolved possibly-
    // delivered work too (a `delivery_possible` row not yet normalized to
    // `unknown`), per clarification #1. Inserting the row IS the reservation; a
    // duplicate proposal violates this and is surfaced as "blocked".
    uniqueIndex("mcp_invocation_unresolved_barrier_idx")
      .on(t.userId, t.connectionId, t.remoteName, t.argsHash)
      .where(sql`${t.resolvedAt} IS NULL`),
    foreignKey({
      columns: [t.successorOf],
      foreignColumns: [t.id],
      name: "mcp_invocation_successor_of_fk",
    }).onDelete("set null"),
  ],
);

export type McpConnection = typeof mcpConnections.$inferSelect;
export type NewMcpConnection = typeof mcpConnections.$inferInsert;
export type McpCatalogRevision = typeof mcpCatalogRevisions.$inferSelect;
export type NewMcpCatalogRevision = typeof mcpCatalogRevisions.$inferInsert;
export type McpToolPolicyRow = typeof mcpToolPolicy.$inferSelect;
export type NewMcpToolPolicyRow = typeof mcpToolPolicy.$inferInsert;
export type McpInvocation = typeof mcpInvocation.$inferSelect;
export type NewMcpInvocation = typeof mcpInvocation.$inferInsert;
