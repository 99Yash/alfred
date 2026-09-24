/**
 * Owner-reviewed MCP health reads for briefing loops (#1196).
 *
 * This is a verified pull, not model-selected relevance. For each bounded set of
 * current owner reviews, it calls the exact read-only descriptor over the user's
 * MCP connection, parses the result through the reviewed selector/token map,
 * and matches the returned identity to a deterministic notification loop key.
 * Only a unique exact match is minted into the generic `mcp` object provider;
 * that delta goes through `objectStateStore.applyEvent`, so unknown kinds and
 * tokens, per-kind closure policy, absorption, locking, and recency remain the
 * store's existing guards rather than a second fold implementation.
 *
 * Unmapped, drifted, malformed, unknown-token, non-matching, and ambiguous reads
 * mint nothing. The caller receives only presentation evidence for its still-open
 * loops; no result shape can grant closure directly.
 */

import {
  deriveLoopEntityRef,
  getPath,
  getStringPath,
  jsonValueSchema,
  MCP_HEALTH_MAPPING_RESULT_ITEM_MAX,
  MCP_HEALTH_MAPPING_TOKEN_MAX,
  mcpHealthMappingDefinitionSchema,
  redactSecrets,
  toMessage,
  type ExternalToolRef,
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
import {
  descriptorHash,
  getMcpConnectionManager,
  parseMcpToolResult,
  type McpPreparedToolCall,
} from "@alfred/assistant/connections/mcp";
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

/** One live notification loop. Subject/from remain untrusted text. */
export interface ApprovedMcpHealthLoop {
  documentId: string;
  subject: string | null;
  from: string | null;
}

export interface ApprovedMcpHealthLoopResult {
  documentId: string;
  /** Present only after one unique, successfully folded exact match. */
  candidate: CandidateKey<"about"> | null;
  /** The row re-read AFTER the store guards ran, never the raw provider claim. */
  state: ObjectState | null;
  /** Presentation-only evidence for the existing non-closing relevance verdict. */
  detail: string;
}

export type CurrentMcpHealthMapping = Pick<
  McpHealthMappingRow,
  "connectionId" | "remoteName" | "descriptorHash" | "definition"
> & { definition: McpHealthMappingDefinition };

export interface ApprovedMcpHealthDependencies {
  listCurrentMappings(userId: string): Promise<readonly CurrentMcpHealthMapping[]>;
  prepareToolCall(connectionId: string): Promise<McpPreparedToolCall>;
  foldAndRead(input: {
    userId: string;
    connectionId: string;
    loopKey: string;
    state: StateCategory;
    title: string | null;
    url: string | null;
  }): Promise<ObjectState | null>;
}

const MAX_APPROVED_HEALTH_MAPPINGS = 5;

const MAX_APPROVED_LOOP_KEY_LENGTH = 512;

const MAX_APPROVED_IDENTITY_LENGTH = 512;

const MAX_APPROVED_OBJECT_TITLE_LENGTH = 300;

const MAX_APPROVED_OBJECT_URL_LENGTH = 2_048;

const objectTitleSchema = z.string().trim().min(1).max(MAX_APPROVED_OBJECT_TITLE_LENGTH);

const objectUrlSchema = z
  .url()
  .max(MAX_APPROVED_OBJECT_URL_LENGTH)
  .refine((value) => value.startsWith("https://"), "Object URL must use HTTPS");

interface ParsedHealthItem {
  identity: string;
  state: StateCategory;
  title: string | null;
  url: string | null;
}

interface MappingRead {
  connectionId: string;
  items: ParsedHealthItem[];
}

/**
 * Current, owner-scoped reviews only. The SQL descriptor-hash equality is the
 * first half of catalog-drift invalidation; the live descriptor hash check in
 * {@link readMapping} is the second, closing the refresh-to-call race.
 */
async function listCurrentMappings(userId: string): Promise<readonly CurrentMcpHealthMapping[]> {
  const descriptorHashExpr = sql<
    string | null
  >`${mcpCatalogRevisions.descriptorHashes} ->> ${mcpHealthMapping.remoteName}`;

  const rows = await db()
    .select({
      connectionId: mcpHealthMapping.connectionId,
      remoteName: mcpHealthMapping.remoteName,
      descriptorHash: mcpHealthMapping.descriptorHash,
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
      ),
    )
    .orderBy(desc(mcpHealthMapping.updatedAt), desc(mcpHealthMapping.id))
    .limit(MAX_APPROVED_HEALTH_MAPPINGS);

  const mappings: CurrentMcpHealthMapping[] = [];

  for (const row of rows) {
    const parsed = mcpHealthMappingDefinitionSchema.safeParse(row.definition);

    if (parsed.success) mappings.push({ ...row, definition: parsed.data });
  }

  return mappings;
}

async function foldAndRead(input: Parameters<ApprovedMcpHealthDependencies["foldAndRead"]>[0]) {
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

const DEFAULT_DEPENDENCIES: ApprovedMcpHealthDependencies = {
  listCurrentMappings,
  prepareToolCall: (connectionId) => getMcpConnectionManager().prepareToolCall(connectionId),
  foldAndRead,
};

function pathKeys(path: string): string[] {
  return path.length === 0 ? [] : path.split(".");
}

function optionalString(value: unknown, schema: z.ZodType<string>): string | null {
  const parsed = schema.safeParse(value);

  return parsed.success ? parsed.data : null;
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
    const identity = getBoundedString(rawItem, identityPath, MAX_APPROVED_IDENTITY_LENGTH);
    const token = getBoundedString(rawItem, statePath, MCP_HEALTH_MAPPING_TOKEN_MAX);
    const state = token === null ? undefined : stateByToken.get(token);

    if (!identity || !state) continue;

    const title = definition.fields.title
      ? optionalString(
          getBoundedString(rawItem, titlePath, MAX_APPROVED_OBJECT_TITLE_LENGTH),
          objectTitleSchema,
        )
      : null;

    const url = definition.fields.url
      ? optionalString(
          getBoundedString(rawItem, urlPath, MAX_APPROVED_OBJECT_URL_LENGTH),
          objectUrlSchema,
        )
      : null;

    parsed.push({ identity, state, title, url });
  }

  return parsed;
}

function getBoundedString(
  value: unknown,
  path: readonly string[],
  maxLength: number,
): string | null {
  const result = getStringPath(value, ...path);

  if (result === undefined) return null;

  const trimmed = result.trim();

  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function liveDescriptor(
  prepared: McpPreparedToolCall,
  remoteName: string,
): { descriptorHash: string; ref: ExternalToolRef } | null {
  const tool = prepared.catalog.tools.find((candidate) => candidate.name === remoteName);

  if (!tool) return null;

  return {
    descriptorHash: descriptorHash(tool),
    ref: {
      kind: "mcp",
      connectionId: prepared.catalog.connectionId,
      remoteName,
      catalogRevision: prepared.catalog.revision,
    },
  };
}

async function readMapping(
  mapping: CurrentMcpHealthMapping,
  dependencies: ApprovedMcpHealthDependencies,
): Promise<MappingRead | null> {
  const prepared = await dependencies.prepareToolCall(mapping.connectionId);
  const live = liveDescriptor(prepared, mapping.remoteName);

  // The row was selected under the current persisted hash; compare the LIVE
  // descriptor again so a refresh between list and call voids the old review.
  if (!live || live.descriptorHash !== mapping.descriptorHash) return null;

  const envelope = await prepared.call(live.ref, mapping.definition.arguments);

  if (envelope.outcome !== "completed" || envelope.truncation) return null;

  const payload = parseMcpToolResult(envelope.result, jsonValueSchema);

  if (payload === null) return null;

  const items = parseItems(payload, mapping.definition);

  return items ? { connectionId: mapping.connectionId, items } : null;
}

function exactIdentityMatch(loopRef: LoopEntityRef, outputIdentity: string, sender: string | null) {
  if (outputIdentity === loopRef.key) return true;

  const outputRef = deriveLoopEntityRef(outputIdentity, { sender });

  return outputRef?.key === loopRef.key && outputRef.provider === loopRef.provider;
}

function loopReference(loop: ApprovedMcpHealthLoop): LoopEntityRef | null {
  const reference = deriveLoopEntityRef(loop.subject, { sender: loop.from });

  return reference && reference.key.length <= MAX_APPROVED_LOOP_KEY_LENGTH ? reference : null;
}

function uniqueMatch(args: {
  reads: readonly MappingRead[];
  loopRef: LoopEntityRef;
  sender: string | null;
}): { connectionId: string; item: ParsedHealthItem } | "ambiguous" | null {
  const byConnection = new Map<string, ParsedHealthItem>();

  for (const read of args.reads) {
    for (const item of read.items) {
      if (!exactIdentityMatch(args.loopRef, item.identity, args.sender)) continue;

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
  dependencies: ApprovedMcpHealthDependencies;
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

  const match = uniqueMatch({ reads: args.reads, loopRef, sender: args.loop.from });

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
    state = await args.dependencies.foldAndRead({
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

/**
 * Verify every supplied loop through the owner's current mapping rows. Faults
 * are local to one mapping/loop and degrade to can't-check; this function does
 * not throw and never returns closure authority outside the store-backed state.
 */
export async function verifyApprovedMcpHealth(
  args: {
    userId: string;
    loops: readonly ApprovedMcpHealthLoop[];
  },
  dependencies: ApprovedMcpHealthDependencies = DEFAULT_DEPENDENCIES,
): Promise<ApprovedMcpHealthLoopResult[]> {
  if (args.loops.length === 0) return [];

  let mappings: readonly CurrentMcpHealthMapping[];

  try {
    mappings = await dependencies.listCurrentMappings(args.userId);
  } catch (error) {
    console.warn(`[mcp.health] mapping read failed :: ${redactSecrets(toMessage(error))}`);
    mappings = [];
  }

  const reads = await Promise.all(
    mappings.map(async (mapping) => {
      try {
        return await readMapping(mapping, dependencies);
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
        dependencies,
      }),
    ),
  );
}
