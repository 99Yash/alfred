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
  check,
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
import type { SealedCredentialSecret } from "../credential-vault";
import { createId, lifecycle_dates } from "../helpers";
import { actionStagings } from "./action-policies";
import { user } from "./auth";

// MCP persistence above `McpRawClient` (PRD #540, amends ADR-0018).
// `mcpCatalogRevisions` comes first: the composite revision-pointer FK on
// `mcpConnections` reads its columns eagerly.

/** One owner's MCP endpoint. Never shared across owners. */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mcps")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The OAuth `resource` indicator. */
    canonicalResource: text("canonical_resource").notNull(),
    /** Pinned. The model never supplies these. */
    endpointUrl: text("endpoint_url").notNull(),
    endpointOrigin: text("endpoint_origin").notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("mcp_servers_user_resource_idx").on(t.userId, t.canonicalResource),
    uniqueIndex("mcp_servers_id_user_idx").on(t.id, t.userId),
  ],
);

/** Append-only catalog snapshots. A revision is never edited, so there is no `updatedAt`. */
export const mcpCatalogRevisions = pgTable(
  "mcp_catalog_revisions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mcpr")),
    connectionId: text("connection_id")
      .notNull()
      // The explicit return type breaks the inference cycle with `mcpConnections`.
      .references((): AnyPgColumn => mcpConnections.id, { onDelete: "cascade" }),
    /** `McpCatalogSnapshot.revision` ("sha256:..."). */
    revisionHash: text("revision_hash").notNull(),
    /** Validated `Tool[]` as admitted. The audit source. */
    descriptors: jsonb("descriptors").notNull(),
    /** Per-tool hashes, so a review binds to one tool and survives changes to other tools. */
    descriptorHashes: jsonb("descriptor_hashes").$type<Record<string, string>>().notNull(),
    /**
     * Per-tool `readOnlyHint === true`. A missing hint is `false`.
     * Stored so the risk gate checks persisted data, not the assumption that
     * admission ran (ADR-0094 amendment, ADR-0096).
     */
    readOnlyHints: jsonb("read_only_hints")
      .$type<Record<string, boolean>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    toolCount: integer("tool_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("mcp_catalog_revisions_conn_hash_idx").on(t.connectionId, t.revisionHash),
    // Target of the composite pointer FK, so a connection can only point at its own revision.
    uniqueIndex("mcp_catalog_revisions_conn_id_idx").on(t.connectionId, t.id),
  ],
);

/**
 * Alfred's OAuth grant for one MCP connection. Kept apart from `integration_credentials`.
 * JSON columns stay `unknown`; the MCP OAuth provider validates them on read.
 */
export const mcpOauthCredentials = pgTable(
  "mcp_oauth_credentials",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mcpo")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references((): AnyPgColumn => mcpConnections.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    discoveryState: jsonb("discovery_state"),
    /** Public DCR fields. `client_secret` lives sealed in `clientSecret`. */
    clientInformation: jsonb("client_information"),
    clientSecret: text("client_secret").$type<SealedCredentialSecret>(),
    accessToken: text("access_token").$type<SealedCredentialSecret>(),
    refreshToken: text("refresh_token").$type<SealedCredentialSecret>(),
    idToken: text("id_token").$type<SealedCredentialSecret>(),
    tokenType: text("token_type"),
    expiresIn: integer("expires_in"),
    scope: text("scope"),
    lastAuthorizedAt: timestamp("last_authorized_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("mcp_oauth_credentials_connection_idx").on(t.connectionId),
    uniqueIndex("mcp_oauth_credentials_id_user_idx").on(t.id, t.userId),
    uniqueIndex("mcp_oauth_credentials_id_connection_idx").on(t.id, t.connectionId),
    index("mcp_oauth_credentials_user_issuer_idx").on(t.userId, t.issuer),
  ],
);

/** Owner-supplied API key for one MCP connection. */
export const mcpApiKeyCredentials = pgTable(
  "mcp_api_key_credentials",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mcpk")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references((): AnyPgColumn => mcpConnections.id, { onDelete: "cascade" }),
    /** `{ in: "header" | "query", name }`. The store parses it. */
    placement: jsonb("placement").notNull(),
    secret: text("secret").$type<SealedCredentialSecret>().notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("mcp_api_key_credentials_connection_idx").on(t.connectionId),
    uniqueIndex("mcp_api_key_credentials_id_user_idx").on(t.id, t.userId),
    uniqueIndex("mcp_api_key_credentials_id_connection_idx").on(t.id, t.connectionId),
  ],
);

/** Durable facts about a named connection. The live client is rebuilt in memory on demand. */
export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mcpc")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** FK is the composite `mcp_connections_server_owner_fk`, which also binds the owner. */
    serverId: text("server_id").notNull(),
    /** Idempotency key within one server. Immutable. */
    instanceKey: text("instance_key").notNull(),
    label: text("label").notNull(),
    /** Null for unauthenticated servers. */
    authServerIdentity: text("auth_server_identity"),
    credentialId: text("credential_id").references(() => mcpOauthCredentials.id, {
      onDelete: "set null",
    }),
    apiKeyCredentialId: text("api_key_credential_id").references(() => mcpApiKeyCredentials.id, {
      onDelete: "set null",
    }),
    grantedScopes: jsonb("granted_scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Scopes awaiting user re-consent. Empty otherwise. */
    requiredScopes: jsonb("required_scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status").$type<McpConnectionStatus>().notNull().default("disconnected"),
    negotiatedProtocolVersion: text("negotiated_protocol_version"),
    serverIdentity: jsonb("server_identity").$type<McpServerIdentity>(),
    /** Null until the first catalog load. The composite FK keeps it on this connection. */
    currentCatalogRevisionId: text("current_catalog_revision_id"),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...lifecycle_dates,
  },
  (t) => [
    // Target of the health-mapping owner FK.
    uniqueIndex("mcp_connections_id_user_idx").on(t.id, t.userId),
    uniqueIndex("mcp_connections_user_server_instance_idx").on(t.userId, t.serverId, t.instanceKey),
    index("mcp_connections_user_status_idx").on(t.userId, t.status),
    foreignKey({
      columns: [t.serverId, t.userId],
      foreignColumns: [mcpServers.id, mcpServers.userId],
      name: "mcp_connections_server_owner_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.credentialId, t.userId],
      foreignColumns: [mcpOauthCredentials.id, mcpOauthCredentials.userId],
      name: "mcp_connections_credential_owner_fk",
    }),
    foreignKey({
      columns: [t.credentialId, t.id],
      foreignColumns: [mcpOauthCredentials.id, mcpOauthCredentials.connectionId],
      name: "mcp_connections_credential_connection_fk",
    }),
    foreignKey({
      columns: [t.apiKeyCredentialId, t.userId],
      foreignColumns: [mcpApiKeyCredentials.id, mcpApiKeyCredentials.userId],
      name: "mcp_connections_api_key_credential_owner_fk",
    }),
    foreignKey({
      columns: [t.apiKeyCredentialId, t.id],
      foreignColumns: [mcpApiKeyCredentials.id, mcpApiKeyCredentials.connectionId],
      name: "mcp_connections_api_key_credential_connection_fk",
    }),
    // At most one credential source: OAuth or API key.
    check(
      "mcp_connections_single_credential_chk",
      sql`num_nonnulls(${t.credentialId}, ${t.apiKeyCredentialId}) <= 1`,
    ),
    foreignKey({
      columns: [t.id, t.currentCatalogRevisionId],
      foreignColumns: [mcpCatalogRevisions.connectionId, mcpCatalogRevisions.id],
      name: "mcp_connections_current_revision_fk",
    }),
  ],
);

/** One browser authorization attempt, so two tabs cannot consume each other's PKCE verifier. */
export const mcpOauthAuthorizationAttempts = pgTable(
  "mcp_oauth_authorization_attempts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mcpa")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    /** Hash only. The signed state travels through the browser. */
    stateHash: text("state_hash").notNull(),
    codeVerifier: text("code_verifier").$type<SealedCredentialSecret>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("mcp_oauth_attempts_state_idx").on(t.stateHash),
    index("mcp_oauth_attempts_connection_idx").on(t.connectionId),
  ],
);

/**
 * Reviewed per-tool policy, bound to one exact descriptor. Without a match,
 * `mcp.call` stays `high` risk. Effect and retry are separate from the risk tier.
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
    descriptorHash: text("descriptor_hash").notNull(),
    /** Bumped on each review edit. */
    policyRevision: integer("policy_revision").notNull().default(1),
    riskTier: text("risk_tier").$type<ToolRiskTier>().notNull(),
    /** `unknown` is treated as effectful. */
    effectClass: text("effect_class").$type<McpEffectClass>().notNull().default("unknown"),
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
 * Owner-reviewed mapping from a read-only MCP result to object state (#1196).
 * `definition` stays `unknown`; readers parse it with `mcpHealthMappingDefinitionSchema`.
 * When the descriptor changes, the hash stops matching and the mapping goes inert.
 */
export const mcpHealthMapping = pgTable(
  "mcp_health_mapping",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mcph")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    remoteName: text("remote_name").notNull(),
    /** Derived by the server from the descriptor the owner inspected. */
    descriptorHash: text("descriptor_hash").notNull(),
    mappingRevision: integer("mapping_revision").notNull().default(1),
    definition: jsonb("definition").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedNote: text("reviewed_note"),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("mcp_health_mapping_conn_remote_desc_idx").on(
      t.connectionId,
      t.remoteName,
      t.descriptorHash,
    ),
    index("mcp_health_mapping_owner_pair_idx").on(t.userId, t.connectionId, t.remoteName),
    foreignKey({
      columns: [t.connectionId, t.userId],
      foreignColumns: [mcpConnections.id, mcpConnections.userId],
      name: "mcp_health_mapping_connection_owner_fk",
    }).onDelete("cascade"),
  ],
);

/**
 * Operation ledger. An effectful call writes its row before network dispatch,
 * so a crash still leaves proof the write may have happened.
 * Health reads have no staging row and must be `read`.
 * See docs/research/mcp-ambiguous-write-outcomes.md for the three status axes.
 */
export const mcpInvocation = pgTable(
  "mcp_invocation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mcpi")),
    /** 1:1 with a model call's staging row. Null for owner-approved health reads. */
    stagingId: text("staging_id").references(() => actionStagings.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    remoteName: text("remote_name").notNull(),
    catalogRevisionId: text("catalog_revision_id").references(() => mcpCatalogRevisions.id, {
      onDelete: "cascade",
    }),
    descriptorHash: text("descriptor_hash"),
    policyRevision: integer("policy_revision"),
    /** SHA-256 of the effective args. The barrier key, not the FNV-1a `proposedInputHash`. */
    argsHash: text("args_hash").notNull(),
    effectClass: text("effect_class").$type<McpEffectClass>().notNull().default("unknown"),
    attemptLifecycle: text("attempt_lifecycle")
      .$type<McpAttemptLifecycle>()
      .notNull()
      .default("prepared"),
    /** Null while in flight. */
    effectOutcome: text("effect_outcome").$type<McpEffectOutcome>(),
    /** Null while in flight. */
    retryDisposition: text("retry_disposition").$type<McpRetryDisposition>(),
    /** The invocation this one supersedes. Only the approval boundary sets it, never the model. */
    successorOf: text("successor_of"),
    /** Null means unresolved. An unresolved, possibly delivered row blocks an identical repeat. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionReason: text("resolution_reason"),
    lastError: text("last_error"),
    // Copies of the staging row's run_id, step_id, and tool_call_id, for trace lookup only.
    // Never a key. Null for health reads and older rows.
    traceId: text("trace_id"),
    /** Currently always "dispatch-tools". `toolCallId` tells calls apart. */
    stepId: text("step_id"),
    toolCallId: text("tool_call_id"),
    deliveryPossibleAt: timestamp("delivery_possible_at", { withTimezone: true }),
    responseReceivedAt: timestamp("response_received_at", { withTimezone: true }),
    /** What the server returned, without payload (#541). Null when no response arrived. */
    resultProvenance: jsonb("result_provenance").$type<McpResultProvenance>(),
    ...lifecycle_dates,
  },
  (t) => [
    check(
      "mcp_invocation_staging_or_read_chk",
      sql`${t.stagingId} IS NOT NULL OR ${t.effectClass} = 'read'`,
    ),
    uniqueIndex("mcp_invocation_staging_idx").on(t.stagingId),
    index("mcp_invocation_barrier_lookup_idx").on(t.connectionId, t.remoteName, t.argsHash),
    // At most one unresolved call per (owner, connection, tool, args). The insert is the reservation.
    uniqueIndex("mcp_invocation_unresolved_barrier_idx")
      .on(t.userId, t.connectionId, t.remoteName, t.argsHash)
      .where(sql`${t.resolvedAt} IS NULL`),
    // A prior invocation grants at most one successor.
    uniqueIndex("mcp_invocation_successor_once_idx")
      .on(t.successorOf)
      .where(sql`${t.successorOf} IS NOT NULL`),
    foreignKey({
      columns: [t.successorOf],
      foreignColumns: [t.id],
      name: "mcp_invocation_successor_of_fk",
    }).onDelete("set null"),
  ],
);

export type McpConnection = typeof mcpConnections.$inferSelect;

export type NewMcpConnection = typeof mcpConnections.$inferInsert;

export type McpServer = typeof mcpServers.$inferSelect;

export type NewMcpServer = typeof mcpServers.$inferInsert;

export type McpOauthCredential = typeof mcpOauthCredentials.$inferSelect;

export type NewMcpOauthCredential = typeof mcpOauthCredentials.$inferInsert;

export type McpApiKeyCredential = typeof mcpApiKeyCredentials.$inferSelect;

export type NewMcpApiKeyCredential = typeof mcpApiKeyCredentials.$inferInsert;

export type McpOauthAuthorizationAttempt = typeof mcpOauthAuthorizationAttempts.$inferSelect;

export type NewMcpOauthAuthorizationAttempt = typeof mcpOauthAuthorizationAttempts.$inferInsert;

export type McpCatalogRevision = typeof mcpCatalogRevisions.$inferSelect;

export type NewMcpCatalogRevision = typeof mcpCatalogRevisions.$inferInsert;

export type McpToolPolicyRow = typeof mcpToolPolicy.$inferSelect;

export type NewMcpToolPolicyRow = typeof mcpToolPolicy.$inferInsert;

export type McpHealthMappingRow = typeof mcpHealthMapping.$inferSelect;

export type NewMcpHealthMappingRow = typeof mcpHealthMapping.$inferInsert;

export type McpInvocation = typeof mcpInvocation.$inferSelect;

export type NewMcpInvocation = typeof mcpInvocation.$inferInsert;
