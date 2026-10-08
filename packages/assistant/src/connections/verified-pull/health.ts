/**
 * Owner-reviewed MCP health reads for briefing loops (#1196).
 * Results reach the store only through the broker, which re-checks the mapping and logs the call.
 * Any doubtful read mints nothing, and no result grants closure directly.
 */

import {
  deriveLoopEntityRef,
  isBuiltInObjectStateProvider,
  mcpHealthMappingDefinitionSchema,
  mcpHealthObjectTitleSchema,
  mcpHealthObjectUrlSchema,
  getPath,
  getStringPath,
  jsonValueSchema,
  MCP_HEALTH_MAPPING_OBJECT_TITLE_MAX,
  MCP_HEALTH_MAPPING_OBJECT_URL_MAX,
  MCP_HEALTH_MAPPING_RESULT_ITEM_MAX,
  MCP_HEALTH_MAPPING_TOKEN_MAX,
  redactSecrets,
  toMessage,
  type LoopEntityProvider,
  type LoopEntityRef,
  type McpHealthMappingDefinition,
  type StateCategory,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  mcpCatalogRevisions,
  mcpConnections,
  mcpHealthMapping,
  type McpHealthMappingRow,
} from "@alfred/db/schemas";
import { parseMcpToolResult, type McpCallEnvelope } from "@alfred/assistant/connections/mcp";
import {
  approvedMcpHealthExternalId,
  deliveryInstantNow,
  MCP_APPROVED_HEALTH_EVENT_TYPE,
  MCP_APPROVED_HEALTH_KEY_KIND,
  MCP_APPROVED_HEALTH_KIND,
  objectStateStore,
  type CandidateKey,
  type ObjectState,
} from "@alfred/assistant/connections";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

/** Subject and from are untrusted text. */
export interface ApprovedMcpHealthLoop {
  documentId: string;
  subject: string | null;
  from: string | null;
}

export interface ApprovedMcpHealthLoopResult {
  documentId: string;
  /** Set only after one unique exact match folded. */
  candidate: CandidateKey<"about"> | null;
  /** The row after the store guards, never the raw provider claim. */
  state: ObjectState | null;
  /** For display only; it closes nothing. */
  detail: string;
}

export type CurrentMcpHealthMapping = Pick<
  McpHealthMappingRow,
  "connectionId" | "remoteName" | "descriptorHash" | "mappingRevision" | "definition"
> & {
  catalogRevision: string;
  definition: McpHealthMappingDefinition;
};

/** No raw `call` seam on purpose: without the broker, the read is can't-check. */
export interface ApprovedMcpHealthCallInput {
  userId: string;
  connectionId: string;
  remoteName: string;
  catalogRevision: string;
  descriptorHash: string;
  mappingRevision: number;
}

export interface ApprovedMcpHealthDependencies {
  callApprovedHealthRead(input: ApprovedMcpHealthCallInput): Promise<McpCallEnvelope | null>;
}

const MAX_APPROVED_HEALTH_MAPPINGS = 5;

const MAX_APPROVED_LOOP_KEY_LENGTH = 512;

const MAX_APPROVED_IDENTITY_LENGTH = 512;

interface ParsedHealthItem {
  identity: string;
  state: StateCategory;
  title: string | null;
  url: string | null;
}

interface MappingRead {
  connectionId: string;
  identityProvider: LoopEntityProvider;
  items: ParsedHealthItem[];
}

/** Current owner reviews whose descriptor hash still matches. The broker re-checks at call time. */
async function listCurrentMappings(userId: string): Promise<readonly CurrentMcpHealthMapping[]> {
  const descriptorHashExpr = sql<
    string | null
  >`${mcpCatalogRevisions.descriptorHashes} ->> ${mcpHealthMapping.remoteName}`;

  const readOnlyExpr = sql<boolean>`coalesce(
    ${mcpCatalogRevisions.readOnlyHints} -> ${mcpHealthMapping.remoteName} = 'true'::jsonb,
    false
  )`;

  const rows = await db()
    .select({
      connectionId: mcpHealthMapping.connectionId,
      remoteName: mcpHealthMapping.remoteName,
      descriptorHash: mcpHealthMapping.descriptorHash,
      mappingRevision: mcpHealthMapping.mappingRevision,
      catalogRevision: mcpCatalogRevisions.revisionHash,
      definition: mcpHealthMapping.definition,
    })
    .from(mcpHealthMapping)
    .innerJoin(
      mcpConnections,
      and(
        eq(mcpConnections.id, mcpHealthMapping.connectionId),
        eq(mcpConnections.userId, userId),
        eq(mcpConnections.status, "ready"),
      ),
    )
    .innerJoin(
      mcpCatalogRevisions,
      eq(mcpCatalogRevisions.id, mcpConnections.currentCatalogRevisionId),
    )
    .where(
      and(
        eq(mcpHealthMapping.userId, userId),
        eq(mcpHealthMapping.descriptorHash, descriptorHashExpr),
        readOnlyExpr,
      ),
    )
    .orderBy(desc(mcpHealthMapping.updatedAt), desc(mcpHealthMapping.id))
    .limit(MAX_APPROVED_HEALTH_MAPPINGS);

  const mappings: CurrentMcpHealthMapping[] = [];

  for (const row of rows) {
    const parsed = mcpHealthMappingDefinitionSchema.safeParse(row.definition);

    if (!parsed.success || isBuiltInObjectStateProvider(parsed.data.identityProvider)) continue;

    mappings.push({ ...row, definition: parsed.data });
  }

  return mappings;
}

async function foldAndRead(input: {
  userId: string;
  connectionId: string;
  loopKey: string;
  state: StateCategory;
  title: string | null;
  url: string | null;
}): Promise<ObjectState | null> {
  const externalId = approvedMcpHealthExternalId(input);

  if (!externalId) return null;

  await objectStateStore.applyEvent({
    userId: input.userId,
    provider: "mcp",
    eventType: MCP_APPROVED_HEALTH_EVENT_TYPE,
    action: null,
    payload: {
      connectionId: input.connectionId,
      loopKey: input.loopKey,
      state: input.state,
      title: input.title,
      url: input.url,
    },
    deliveredAt: deliveryInstantNow(),
  });

  return objectStateStore.getByIdentity(input.userId, {
    provider: "mcp",
    kind: MCP_APPROVED_HEALTH_KIND,
    externalId,
  });
}

const UNGOVERNED_DEPENDENCIES: ApprovedMcpHealthDependencies = {
  async callApprovedHealthRead() {
    return null;
  },
};

function pathKeys(path: string): string[] {
  return path.length === 0 ? [] : path.split(".");
}

function optionalString(value: unknown, schema: z.ZodType<string>): string | null {
  const parsed = schema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

function getBoundedString(
  value: unknown,
  path: readonly string[],
  maxLength: number,
  options: { trim?: boolean } = {},
): string | null {
  const result = getStringPath(value, ...path);

  if (result === undefined) return null;

  const bounded = options.trim === false ? result : result.trim();

  return bounded.length > 0 && bounded.length <= maxLength ? bounded : null;
}

function parseItems(
  payload: unknown,
  definition: McpHealthMappingDefinition,
): ParsedHealthItem[] | null {
  const rawItems = getPath(payload, ...pathKeys(definition.itemsPath));

  if (!Array.isArray(rawItems) || rawItems.length > MCP_HEALTH_MAPPING_RESULT_ITEM_MAX) return null;

  const identityPath = pathKeys(definition.fields.identity);
  const statePath = pathKeys(definition.fields.state);
  const titlePath = pathKeys(definition.fields.title);
  const urlPath = pathKeys(definition.fields.url);

  const stateByToken = new Map(
    definition.stateMappings.map((mapping) => [mapping.token, mapping.state]),
  );

  const parsed: ParsedHealthItem[] = [];

  for (const rawItem of rawItems) {
    // Exact byte match: do not trim.
    const identity = getBoundedString(rawItem, identityPath, MAX_APPROVED_IDENTITY_LENGTH, {
      trim: false,
    });

    const token = getBoundedString(rawItem, statePath, MCP_HEALTH_MAPPING_TOKEN_MAX, {
      trim: false,
    });

    const state = token === null ? undefined : stateByToken.get(token);

    if (!identity || !state) continue;

    const title = definition.fields.title
      ? optionalString(
          getBoundedString(rawItem, titlePath, MCP_HEALTH_MAPPING_OBJECT_TITLE_MAX),
          mcpHealthObjectTitleSchema,
        )
      : null;

    const url = definition.fields.url
      ? optionalString(
          getBoundedString(rawItem, urlPath, MCP_HEALTH_MAPPING_OBJECT_URL_MAX),
          mcpHealthObjectUrlSchema,
        )
      : null;

    parsed.push({ identity, state, title, url });
  }

  return parsed;
}

async function readMapping(
  userId: string,
  mapping: CurrentMcpHealthMapping,
  dependencies: ApprovedMcpHealthDependencies,
): Promise<MappingRead | null> {
  const envelope = await dependencies.callApprovedHealthRead({
    userId,
    connectionId: mapping.connectionId,
    remoteName: mapping.remoteName,
    catalogRevision: mapping.catalogRevision,
    descriptorHash: mapping.descriptorHash,
    mappingRevision: mapping.mappingRevision,
  });

  if (!envelope || envelope.outcome !== "completed" || envelope.truncation) return null;

  const payload = parseMcpToolResult(envelope.result, jsonValueSchema);

  if (payload === null) return null;

  const items = parseItems(payload, mapping.definition);

  return items
    ? {
        connectionId: mapping.connectionId,
        identityProvider: mapping.definition.identityProvider,
        items,
      }
    : null;
}

/** Exact match within the mapping's provider. Built-in providers keep their own readers. */
function exactIdentityMatch(
  loopRef: LoopEntityRef,
  outputIdentity: string,
  identityProvider: LoopEntityProvider,
): boolean {
  return (
    !isBuiltInObjectStateProvider(loopRef.provider) &&
    loopRef.provider === identityProvider &&
    outputIdentity === loopRef.key
  );
}

function loopReference(loop: ApprovedMcpHealthLoop): LoopEntityRef | null {
  const reference = deriveLoopEntityRef(loop.subject, { sender: loop.from });

  return reference && reference.key.length <= MAX_APPROVED_LOOP_KEY_LENGTH ? reference : null;
}

function uniqueMatch(args: {
  reads: readonly MappingRead[];
  loopRef: LoopEntityRef;
}): { connectionId: string; item: ParsedHealthItem } | "ambiguous" | null {
  const byConnection = new Map<string, ParsedHealthItem>();

  for (const read of args.reads) {
    for (const item of read.items) {
      if (!exactIdentityMatch(args.loopRef, item.identity, read.identityProvider)) continue;

      const previous = byConnection.get(read.connectionId);

      if (previous && previous.state !== item.state) return "ambiguous";

      if (!previous) byConnection.set(read.connectionId, item);
    }
  }

  if (byConnection.size > 1) return "ambiguous";

  if (byConnection.size === 0) return null;

  const [connectionId, item] = [...byConnection][0] ?? [];

  return connectionId && item ? { connectionId, item } : null;
}

async function verifyLoop(args: {
  userId: string;
  loop: ApprovedMcpHealthLoop;
  reads: readonly MappingRead[];
  availableMappings: number;
  attemptedMappings: number;
}): Promise<ApprovedMcpHealthLoopResult> {
  const loopRef = loopReference(args.loop);

  if (!loopRef) {
    return {
      documentId: args.loop.documentId,
      candidate: null,
      state: null,
      detail: "The notification has no deterministic work-object key; loop can't be checked.",
    };
  }

  const match = uniqueMatch({ reads: args.reads, loopRef });

  if (match === "ambiguous") {
    return {
      documentId: args.loop.documentId,
      candidate: null,
      state: null,
      detail: "Approved MCP health reads disagreed about this loop; it can't be checked.",
    };
  }

  if (!match) {
    return {
      documentId: args.loop.documentId,
      candidate: null,
      state: null,
      detail:
        args.availableMappings === 0
          ? "No current owner-approved MCP health mapping is available; loop can't be checked."
          : args.attemptedMappings === 0
            ? "The approved MCP health read failed or returned an unusable shape; loop can't be checked."
            : "Approved MCP health output did not match this loop; it can't be checked.",
    };
  }

  const externalId = approvedMcpHealthExternalId({
    connectionId: match.connectionId,
    loopKey: loopRef.key,
  });

  if (!externalId) {
    return {
      documentId: args.loop.documentId,
      candidate: null,
      state: null,
      detail: "The approved MCP health identity is invalid; loop can't be checked.",
    };
  }

  let state: ObjectState | null;

  try {
    state = await foldAndRead({
      userId: args.userId,
      connectionId: match.connectionId,
      loopKey: loopRef.key,
      state: match.item.state,
      title: match.item.title,
      url: match.item.url,
    });
  } catch (error) {
    console.warn(
      `[mcp.health] object-state fold failed connection=${match.connectionId} :: ${redactSecrets(toMessage(error))}`,
    );
    state = null;
  }

  if (!state) {
    return {
      documentId: args.loop.documentId,
      candidate: null,
      state: null,
      detail: "The approved MCP health read could not be stored; loop stays unverified.",
    };
  }

  return {
    documentId: args.loop.documentId,
    candidate: {
      provider: "mcp",
      keyKind: MCP_APPROVED_HEALTH_KEY_KIND,
      keyValue: externalId,
      match: "exact",
      reading: "about",
    },
    state,
    detail: `Approved MCP health read reports this loop as ${state.nativeState ?? state.stateCategory}.`,
  };
}

/** Never throws. A fault makes only its own mapping or loop can't-check. */
export async function verifyApprovedMcpHealth(
  args: {
    userId: string;
    loops: readonly ApprovedMcpHealthLoop[];
  },
  dependencies: ApprovedMcpHealthDependencies = UNGOVERNED_DEPENDENCIES,
): Promise<ApprovedMcpHealthLoopResult[]> {
  if (args.loops.length === 0) return [];

  let mappings: readonly CurrentMcpHealthMapping[];

  try {
    mappings = await listCurrentMappings(args.userId);
  } catch (error) {
    console.warn(`[mcp.health] mapping read failed :: ${redactSecrets(toMessage(error))}`);
    mappings = [];
  }

  const reads = await Promise.all(
    mappings.map(async (mapping) => {
      try {
        return await readMapping(args.userId, mapping, dependencies);
      } catch (error) {
        console.warn(
          `[mcp.health] mapped read failed connection=${mapping.connectionId} :: ${redactSecrets(toMessage(error))}`,
        );

        return null;
      }
    }),
  );

  const successfulReads = reads.filter((read): read is MappingRead => read !== null);

  return Promise.all(
    args.loops.map((loop) =>
      verifyLoop({
        userId: args.userId,
        loop,
        reads: successfulReads,
        availableMappings: mappings.length,
        attemptedMappings: successfulReads.length,
      }),
    ),
  );
}
