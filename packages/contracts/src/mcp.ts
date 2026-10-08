/**
 * Browser-safe MCP contracts: tool argument envelopes and the enums behind the MCP tables.
 * Anything that needs the MCP SDK or `node:crypto` stays in `@alfred/assistant`.
 */

import { z } from "zod";
import { enumGuard } from "./guards";
import type { CatalogSlug } from "./integrations";
import { LOOP_ENTITY_PROVIDERS } from "./loop-key";
import { OBJECT_STATE_CATEGORIES } from "./integration-objects";
import { TOOL_RISK_TIERS } from "./tools";
import { jsonObjectSchema, jsonValueSchema } from "./user-model";

// Durable connection status (`mcp_connections.status`).
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

// Snapshot of the negotiated server identity, stored on `mcp_connections.server_identity`.
export const mcpServerIdentitySchema = z.object({
  protocolVersion: z.string(),
  serverName: z.string(),
  serverVersion: z.string(),
  hasTools: z.boolean(),
  toolsListChanged: z.boolean(),
});

export type McpServerIdentity = z.infer<typeof mcpServerIdentitySchema>;

// Reviewed per-tool effect and retry rules (`mcp_tool_policy`), separate from the risk tier:
// a low-risk write still gets ambiguous-write protection.
// Defaults: unknown is effectful, never retry.
export const mcpEffectClassValues = ["read", "write", "unknown"] as const;

export type McpEffectClass = (typeof mcpEffectClassValues)[number];

export const mcpEffectClassSchema = z.enum(mcpEffectClassValues);

export const mcpRetryContractValues = ["never", "same_key", "reconcile"] as const;

export type McpRetryContract = (typeof mcpRetryContractValues)[number];

export const mcpRetryContractSchema = z.enum(mcpRetryContractValues);

// Ledger axes on `mcp_invocation` (docs/research/mcp-ambiguous-write-outcomes.md):
// lifecycle is what Alfred did, outcome is what it can prove,
// disposition is what the broker may do next.
// `delivery_possible` is written before the call, so a crash still marks the write ambiguous.
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

// Recovery operations as the browser sees them. The raw staging input stays on the server.
export const mcpRecoveryDecisionSchema = z.enum(["confirmed_succeeded", "confirmed_not_applied"]);

export type McpRecoveryDecision = z.infer<typeof mcpRecoveryDecisionSchema>;

/** Body of the resolve route. */
export const mcpRecoveryDecisionBodySchema = z
  .object({ decision: mcpRecoveryDecisionSchema })
  .strict();

export type McpRecoveryDecisionBody = z.infer<typeof mcpRecoveryDecisionBodySchema>;

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
 * Either an ambiguous call that may have been delivered, or a reserved successor that was not.
 * The successor's null outcome and timestamps prove a restart did not send or classify it.
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

/**
 * One page of the recovery list. The read never repairs a row.
 * `awaitingRepair` counts calls that finished but have no broker settlement yet;
 * they join `operations` after the broker repairs them.
 */
export const mcpRecoveryOperationsPageSchema = z
  .object({
    operations: z.array(mcpRecoveryOperationSchema).max(MCP_RECOVERY_PAGE_SIZE),
    nextCursor: z.string().min(1).nullable(),
    awaitingRepair: z.number().int().nonnegative(),
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

// Add a server by URL. The label defaults to the endpoint host.
export const MCP_ADD_SERVER_MAX_URL_LENGTH = 2_048;

export const MCP_ADD_SERVER_MAX_LABEL_LENGTH = 100;

// Owner-supplied API key, placed in one header or one query parameter.
// The store seals the value after the route parses it.
export const MCP_API_KEY_MAX_LENGTH = 4_096;

export const MCP_API_KEY_MAX_PLACEMENT_NAME_LENGTH = 128;

/**
 * Headers a stored key may not use, because `fetch` or the MCP transport sets them.
 * `authorization` is allowed: a bearer key there is the usual case. Compare lowercase.
 */
export const MCP_API_KEY_REFUSED_HEADERS = [
  "host",
  "content-type",
  "accept",
  "content-length",
  "connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "mcp-session-id",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "last-event-id",
] as const;

const MCP_API_KEY_REFUSED_HEADER_SET: ReadonlySet<string> = new Set(MCP_API_KEY_REFUSED_HEADERS);

/**
 * RFC 9110 `token` characters. Other header names make `Headers.set` throw at request time.
 * Query names use the same rule.
 */
const MCP_API_KEY_PLACEMENT_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isPlacementNameToken(name: string): boolean {
  return MCP_API_KEY_PLACEMENT_NAME_TOKEN.test(name);
}

const mcpApiKeyPlacementNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MCP_API_KEY_MAX_PLACEMENT_NAME_LENGTH);

export const mcpApiKeyPlacementSchema = z.discriminatedUnion("in", [
  z
    .object({ in: z.literal("header"), name: mcpApiKeyPlacementNameSchema })
    .strict()
    .refine((placement) => !MCP_API_KEY_REFUSED_HEADER_SET.has(placement.name.toLowerCase()), {
      path: ["name"],
      message: "This header is owned by the MCP transport or the HTTP stack",
    })
    .refine((placement) => isPlacementNameToken(placement.name), {
      path: ["name"],
      message: "A placement name must be an RFC 9110 token",
    }),
  z
    .object({ in: z.literal("query"), name: mcpApiKeyPlacementNameSchema })
    .strict()
    .refine((placement) => isPlacementNameToken(placement.name), {
      path: ["name"],
      message: "A placement name must be an RFC 9110 token",
    }),
]);

export type McpApiKeyPlacement = z.infer<typeof mcpApiKeyPlacementSchema>;

export const mcpApiKeyAuthSchema = z
  .object({
    kind: z.literal("api_key"),
    placement: mcpApiKeyPlacementSchema,
    value: z.string().min(1).max(MCP_API_KEY_MAX_LENGTH),
  })
  .strict();

/** The plaintext key, sent once to the create route. */
export type McpApiKeyAuth = z.infer<typeof mcpApiKeyAuthSchema>;

/** No `auth` means no-auth. OAuth is discovered from the endpoint, not sent here. */
export const mcpAddServerAuthSchema = z.discriminatedUnion("kind", [mcpApiKeyAuthSchema]);

export type McpAddServerAuth = z.infer<typeof mcpAddServerAuthSchema>;

export const mcpAddServerBodySchema = z
  .object({
    endpointUrl: z.url().max(MCP_ADD_SERVER_MAX_URL_LENGTH),
    label: z.string().trim().min(1).max(MCP_ADD_SERVER_MAX_LABEL_LENGTH).optional(),
    auth: mcpAddServerAuthSchema.optional(),
  })
  .strict();

export type McpAddServerBody = z.infer<typeof mcpAddServerBodySchema>;

/** Rename changes only the label. It shares the create length limit. */
export const mcpRenameConnectionBodySchema = z
  .object({ label: z.string().trim().min(1).max(MCP_ADD_SERVER_MAX_LABEL_LENGTH) })
  .strict();

export type McpRenameConnectionBody = z.infer<typeof mcpRenameConnectionBodySchema>;

// Built-in MCP servers. The keys are the provider names (ADR-0093).
// This is the display half; `BUILT_IN_REGISTRY` in `@alfred/assistant` is the server half,
// and each must cover the other's keys or the build fails.
export interface McpBuiltInEntry {
  /** The slug whose logo the tile uses. Only `CatalogSlug` entries have a logo. */
  readonly slug: CatalogSlug;
  /** Names the server, not the product: one product can have more than one server. */
  readonly label: string;
  readonly blurb: string;
}

export const BUILT_IN_MCP_CATALOG = {
  github: {
    slug: "github",
    label: "GitHub MCP",
    blurb: "Read pull requests, issues, and code.",
  },
  linear: {
    slug: "linear",
    label: "Linear MCP",
    blurb: "Work with Linear issues, projects, and cycles.",
  },
  notion: {
    slug: "notion",
    label: "Notion MCP",
    blurb: "Work with Notion pages and databases.",
  },
  sentry: {
    slug: "sentry",
    label: "Sentry MCP",
    blurb: "Investigate Sentry issues and error events.",
  },
  railway: {
    slug: "railway",
    label: "Railway MCP",
    blurb: "Read Railway deployment status.",
  },
  vercel: {
    slug: "vercel",
    label: "Vercel MCP",
    blurb: "Read Vercel projects and deployment status.",
  },
  polylane: {
    slug: "polylane",
    label: "Polylane MCP",
    blurb: "Read production logs, metrics, traces, and tracked issues.",
  },
} as const satisfies Record<string, McpBuiltInEntry>;

export type BuiltInMCPProvider = keyof typeof BUILT_IN_MCP_CATALOG;

/** In catalog order, which is also the page order. */
export const BUILT_IN_MCP_PROVIDERS: readonly BuiltInMCPProvider[] =
  // SAFETY: the keys of this literal are exactly `BuiltInMCPProvider`.
  Object.keys(BUILT_IN_MCP_CATALOG) as BuiltInMCPProvider[];

export const isBuiltInMCPProvider = enumGuard(BUILT_IN_MCP_PROVIDERS);

// MCP `ContentBlock` types, plus `unknown` for any future shape.
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

// What the server returned, without the payload (`mcp_invocation.result_provenance`).
// Counts and flags only; resource links are counted, never fetched.
export const mcpResultProvenanceSchema = z.object({
  /** The server reported a tool problem after execution; this does not prove no effect. */
  isError: z.boolean(),
  hasStructuredContent: z.boolean(),
  /**
   * True only when an output schema exists and the content passed it.
   * False also means no schema, or a tool error.
   * An `invalid_output` error still carries this envelope.
   */
  outputSchemaValidated: z.boolean(),
  contentBlockCount: z.number().int().nonnegative(),
  /** Block count per kind. Only kinds that occur appear. */
  contentKinds: z.partialRecord(mcpContentKindSchema, z.number().int().nonnegative()),
  /** The text the model saw was clipped. */
  truncated: z.boolean(),
});

export type McpResultProvenance = z.infer<typeof mcpResultProvenanceSchema>;

// The remote tool ref rides in the args, not in `ToolName`, so it is part of the staging
// input hash and a call under a new catalog revision stages again.
// `McpRawClient.callTool` validates `arguments`; this file does not.
export const mcpExternalToolRefSchema = z
  .object({
    kind: z.literal("mcp"),
    connectionId: z.string().min(1),
    remoteName: z.string().min(1),
    /** The revision the model saw. A mismatch throws `catalog_stale`. */
    catalogRevision: z.string().min(1),
  })
  .strict();

export type ExternalToolRef = z.infer<typeof mcpExternalToolRefSchema>;

export const mcpCallInput = z
  .object({
    ...mcpExternalToolRefSchema.omit({ kind: true }).shape,
    /** Passed through unchanged. A record schema keeps every key on re-parse. */
    arguments: jsonObjectSchema,
  })
  .strict();

export type McpCallInput = z.infer<typeof mcpCallInput>;

/** Page cap, so one result never dumps the whole catalog (up to 1,000 tools). */
export const MCP_LIST_TOOLS_MAX_LIMIT = 50;

export const MCP_LIST_TOOLS_DEFAULT_LIMIT = 25;

/**
 * Page detail: `summary` (default) is name, title, and short description; `names` is name only.
 * No `full` tier: a descriptor can be 128 KB, so full descriptors come one at a time via `ref`.
 */
export const mcpListToolsDetailValues = ["names", "summary"] as const;

export type McpListToolsDetail = (typeof mcpListToolsDetailValues)[number];

export const mcpListToolsDetailSchema = z.enum(mcpListToolsDetailValues);

export const mcpToolSearchInputSchema = z
  .object({
    /** Matches name, title, and description, not the connection label. */
    query: z.string().max(200).optional(),
    namespace: z.string().min(1).optional(),
    connectionId: z.string().min(1).optional(),
    detail: mcpListToolsDetailSchema.optional(),
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

/** Search or inspect as one object, because providers require a root `type: "object"`. */
export const mcpListToolsInput = z
  .object({
    ...mcpToolSearchInputSchema.shape,
    ref: mcpExternalToolRefSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const inputKeys = Object.keys(input);

    if (!inputKeys.includes("ref")) return;

    if (input.ref === undefined || inputKeys.some((key) => key !== "ref")) {
      ctx.addIssue({
        code: "custom",
        message: "MCP tool inspection accepts only an exact ref",
      });
    }
  });

export type McpListToolsInput = z.infer<typeof mcpListToolsInput>;

export type McpListToolsOperation =
  | { operation: "inspect"; input: McpToolInspectInput }
  | { operation: "search"; input: McpToolSearchInput };

export function parseMcpListToolsOperation(input: unknown): McpListToolsOperation {
  const parsed = mcpListToolsInput.parse(input);

  if (parsed.ref !== undefined) {
    return { operation: "inspect", input: { ref: parsed.ref } };
  }

  return { operation: "search", input: mcpToolSearchInputSchema.parse(parsed) };
}

export const mcpDiscoveryConnectionSchema = z
  .object({
    id: z.string().min(1),
    instanceKey: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

export type McpDiscoveryConnection = z.infer<typeof mcpDiscoveryConnectionSchema>;

function enforceConnectionRefIdentity(
  input: { ref: ExternalToolRef; connection: McpDiscoveryConnection },
  ctx: z.RefinementCtx,
): void {
  if (input.connection.id !== input.ref.connectionId) {
    ctx.addIssue({
      code: "custom",
      path: ["connection", "id"],
      message: "MCP discovery connection id must match the tool reference",
    });
  }
}

function enforceInspectionIdentity(
  input: {
    ref: ExternalToolRef;
    connection: McpDiscoveryConnection;
    tool: z.infer<typeof jsonObjectSchema>;
  },
  ctx: z.RefinementCtx,
): void {
  enforceConnectionRefIdentity(input, ctx);

  if (input.tool.name !== input.ref.remoteName) {
    ctx.addIssue({
      code: "custom",
      path: ["tool", "name"],
      message: "MCP inspected tool name must match the tool reference",
    });
  }
}

export const mcpToolDiscoveryHitSchema = z
  .object({
    ref: mcpExternalToolRefSchema,
    namespace: z.string().min(1),
    connection: mcpDiscoveryConnectionSchema,
    title: z.string().optional(),
    description: z.string().optional(),
  })
  .strict()
  .superRefine(enforceConnectionRefIdentity);

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
  .strict()
  .superRefine(enforceInspectionIdentity);

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

// Policy review of one exact descriptor (ADR-0088, ADR-0096).
// The server derives `descriptorHash` and `policyRevision`, so the client cannot send them.
export const MCP_TOOL_POLICY_NOTE_MAX = 500;

/** `ref` carries the revision the owner saw. The server refuses a stale one. */
export const mcpToolPolicyReviewInputSchema = z
  .object({
    ref: mcpExternalToolRefSchema,
    riskTier: z.enum(TOOL_RISK_TIERS),
    effectClass: mcpEffectClassSchema,
    retryContract: mcpRetryContractSchema,
    note: z.string().trim().max(MCP_TOOL_POLICY_NOTE_MAX).nullable(),
  })
  .strict();

export type McpToolPolicyReviewInput = z.infer<typeof mcpToolPolicyReviewInputSchema>;

/** `policyRevision` only goes up. */
export const mcpToolPolicySchema = z
  .object({
    riskTier: z.enum(TOOL_RISK_TIERS),
    effectClass: mcpEffectClassSchema,
    retryContract: mcpRetryContractSchema,
    note: z.string().nullable(),
    policyRevision: z.number().int().positive(),
    reviewedAt: z.string().nullable(),
  })
  .strict();

export type McpToolPolicy = z.infer<typeof mcpToolPolicySchema>;

/**
 * `drifted`: reviewed under an older descriptor, so the default floor applies again.
 * A missing connection is a 404, not a state.
 */
export const mcpToolPolicyStateSchema = z.union([
  z
    .object({
      status: z.literal("reviewed"),
      ref: mcpExternalToolRefSchema,
      policy: mcpToolPolicySchema,
    })
    .strict(),
  z.object({ status: z.literal("unreviewed"), ref: mcpExternalToolRefSchema }).strict(),
  z
    .object({
      status: z.literal("drifted"),
      ref: mcpExternalToolRefSchema,
      previous: mcpToolPolicySchema,
    })
    .strict(),
  z.object({ status: z.literal("catalog_stale"), ref: mcpExternalToolRefSchema }).strict(),
  z.object({ status: z.literal("not_found"), ref: mcpExternalToolRefSchema }).strict(),
]);

export type McpToolPolicyState = z.infer<typeof mcpToolPolicyStateSchema>;

// Health mapping: how one read-only MCP result becomes object-state rows.
// It binds to the same descriptor as the policy review but is a separate record.

export const MCP_HEALTH_MAPPING_NOTE_MAX = 500;

export const MCP_HEALTH_MAPPING_PATH_MAX = 200;

export const MCP_HEALTH_MAPPING_TOKEN_MAX = 80;

export const MCP_HEALTH_MAPPING_STATE_TOKEN_MAX = 32;

export const MCP_HEALTH_MAPPING_ARGUMENT_MAX_BYTES = 16_384;

export const MCP_HEALTH_MAPPING_RESULT_ITEM_MAX = 50;

export const MCP_HEALTH_MAPPING_OBJECT_TITLE_MAX = 300;

export const MCP_HEALTH_MAPPING_OBJECT_URL_MAX = 2_048;

export const mcpHealthObjectTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MCP_HEALTH_MAPPING_OBJECT_TITLE_MAX);

/** HTTPS only. */
export const mcpHealthObjectUrlSchema = z
  .url()
  .max(MCP_HEALTH_MAPPING_OBJECT_URL_MAX)
  .refine((value) => value.startsWith("https://"), "Object URL must use HTTPS");

/**
 * Dot-separated keys, not JSONPath, so there is no expression language to inject.
 * `""` is the response root and only makes sense for `itemsPath`.
 */
const mcpHealthMappingPathSchema = z
  .string()
  .trim()
  .max(MCP_HEALTH_MAPPING_PATH_MAX)
  .refine(
    (value) =>
      value === "" ||
      value
        .split(".")
        .every(
          (segment) =>
            /^[A-Za-z0-9_-]{1,64}$/.test(segment) &&
            !["__proto__", "prototype", "constructor"].includes(segment),
        ),
    "Use dot-separated object keys, for example data.items",
  );

const mcpHealthMappingFieldPathSchema = mcpHealthMappingPathSchema.refine(
  (value) => value.length > 0,
  "A field path must name at least one object key",
);

const mcpHealthStateMappingSchema = z
  .object({
    token: z.string().trim().min(1).max(MCP_HEALTH_MAPPING_TOKEN_MAX),
    state: z.enum(OBJECT_STATE_CATEGORIES),
  })
  .strict();

/**
 * `itemsPath` finds an array; field paths read from each item.
 * `stateMappings` match tokens exactly and case-sensitively. An unmapped token changes nothing.
 */
export const mcpHealthMappingDefinitionSchema = z
  .object({
    itemsPath: mcpHealthMappingPathSchema,
    /**
     * The loop-key provider this mapping answers for.
     * Not `issue`: that is the fallback for any sender, so a human email could trigger the fold.
     */
    identityProvider: z.enum(LOOP_ENTITY_PROVIDERS).exclude(["issue"]),
    fields: z
      .object({
        identity: mcpHealthMappingFieldPathSchema,
        state: mcpHealthMappingFieldPathSchema,
        title: mcpHealthMappingPathSchema,
        url: mcpHealthMappingPathSchema,
      })
      .strict(),
    stateMappings: z
      .array(mcpHealthStateMappingSchema)
      .min(1)
      .max(MCP_HEALTH_MAPPING_STATE_TOKEN_MAX)
      .superRefine((mappings, ctx) => {
        const seen = new Set<string>();

        mappings.forEach((mapping, index) => {
          if (seen.has(mapping.token)) {
            ctx.addIssue({
              code: "custom",
              message: `State token '${mapping.token}' is mapped more than once`,
              path: [index, "token"],
            });
          }

          seen.add(mapping.token);
        });
      }),
    /** The MCP client validates these again at call time. */
    arguments: jsonObjectSchema.refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).length <=
        MCP_HEALTH_MAPPING_ARGUMENT_MAX_BYTES,
      `Health mapping arguments must be at most ${MCP_HEALTH_MAPPING_ARGUMENT_MAX_BYTES} bytes`,
    ),
  })
  .strict();

export type McpHealthMappingDefinition = z.infer<typeof mcpHealthMappingDefinitionSchema>;

/** `readOnly: true` is the owner's own statement that the tool only reads. */
export const mcpHealthMappingReviewInputSchema = z
  .object({
    ref: mcpExternalToolRefSchema,
    readOnly: z.literal(true),
    definition: mcpHealthMappingDefinitionSchema,
    note: z.string().trim().max(MCP_HEALTH_MAPPING_NOTE_MAX).nullable(),
  })
  .strict();

export type McpHealthMappingReviewInput = z.infer<typeof mcpHealthMappingReviewInputSchema>;

export const mcpHealthMappingSchema = z
  .object({
    definition: mcpHealthMappingDefinitionSchema,
    note: z.string().nullable(),
    mappingRevision: z.number().int().positive(),
    reviewedAt: z.string().nullable(),
  })
  .strict();

export type McpHealthMapping = z.infer<typeof mcpHealthMappingSchema>;

/** Only `reviewed` lets the mapping run. */
export const mcpHealthMappingStateSchema = z.union([
  z
    .object({
      status: z.literal("reviewed"),
      ref: mcpExternalToolRefSchema,
      mapping: mcpHealthMappingSchema,
    })
    .strict(),
  z.object({ status: z.literal("unreviewed"), ref: mcpExternalToolRefSchema }).strict(),
  z
    .object({
      status: z.literal("drifted"),
      ref: mcpExternalToolRefSchema,
      previous: mcpHealthMappingSchema,
    })
    .strict(),
  z.object({ status: z.literal("invalid"), ref: mcpExternalToolRefSchema }).strict(),
  z.object({ status: z.literal("catalog_stale"), ref: mcpExternalToolRefSchema }).strict(),
  z.object({ status: z.literal("not_found"), ref: mcpExternalToolRefSchema }).strict(),
  z.object({ status: z.literal("not_read_only"), ref: mcpExternalToolRefSchema }).strict(),
]);

export type McpHealthMappingState = z.infer<typeof mcpHealthMappingStateSchema>;
