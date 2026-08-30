/**
 * MCP server + connection + catalog persistence (PRD #540) — pure durable row
 * access over their three tables.
 *
 * This module holds NO live SDK clients and performs NO network I/O: it is the
 * seam between the in-memory `McpRawClient` world and the three connection-side
 * `mcp_*` tables (`packages/db/src/schema/mcp.ts`). Everything here is either a
 * single-row read, a single-row write, or the one genuinely-atomic multi-row
 * operation that MUST be a transaction to be crash-safe:
 *
 *  - named connection creation — immutable server definition + fresh instance;
 *  - built-in connection ensure — one closed, stable slot per built-in provider;
 *  - `publishCatalogRevision` — idempotent insert of an immutable revision +
 *    advance of the connection's current-revision pointer.
 *
 * The invocation ledger and the per-tool policy rows are NOT here. They belong to
 * the tool runtime, which owns durable invocation and the ADR-0088 approval
 * derivation, and they live in `@alfred/assistant/tool-runtime/mcp`. That split is
 * one-way on purpose: nothing in this module may reach the invocation half.
 */

import { db, rowsFromExecute } from "@alfred/db";
import { createId, requireRow, runAtomic, type DbRunner } from "@alfred/db/helpers";
import {
  mcpCatalogRevisions,
  mcpConnections,
  mcpServers,
  type McpCatalogRevision,
  type McpConnection,
  type McpServer,
  type NewMcpConnection,
  type NewMcpServer,
} from "@alfred/db/schemas";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";

// ===========================================================================
// Connections
// ===========================================================================

/** Columns a caller may mutate on a connection after creation. */
export type McpConnectionUpdate = Partial<
  Pick<
    NewMcpConnection,
    | "label"
    | "status"
    | "negotiatedProtocolVersion"
    | "serverIdentity"
    | "currentCatalogRevisionId"
    | "lastConnectedAt"
    | "lastError"
    | "authServerIdentity"
    | "grantedScopes"
    | "requiredScopes"
  >
>;

type McpServerDefinition = Pick<McpServer, "canonicalResource" | "endpointUrl" | "endpointOrigin">;

export type McpConnectionWithServer = McpConnection & {
  readonly server: McpServerDefinition;
};

export type CreateNamedMcpConnectionInput = Pick<NewMcpConnection, "userId" | "label"> &
  Pick<NewMcpServer, "canonicalResource"> & {
    endpoint: URL;
    initialState?: Partial<Pick<NewMcpConnection, "authServerIdentity" | "status">>;
  };

const connectionWithServerSelection = {
  connection: mcpConnections,
  server: {
    canonicalResource: mcpServers.canonicalResource,
    endpointUrl: mcpServers.endpointUrl,
    endpointOrigin: mcpServers.endpointOrigin,
  },
};

function joinConnection(input: {
  connection: McpConnection;
  server: McpServerDefinition;
}): McpConnectionWithServer {
  return { ...input.connection, server: input.server };
}

export async function readConnection(
  id: string,
  runner: DbRunner = db(),
): Promise<McpConnectionWithServer | undefined> {
  const [row] = await runner
    .select(connectionWithServerSelection)
    .from(mcpConnections)
    .innerJoin(mcpServers, eq(mcpConnections.serverId, mcpServers.id))
    .where(eq(mcpConnections.id, id))
    .limit(1);
  return row ? joinConnection(row) : undefined;
}

async function readServerByResource(
  userId: string,
  canonicalResource: string,
  runner: DbRunner = db(),
): Promise<McpServer | undefined> {
  const [row] = await runner
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.userId, userId), eq(mcpServers.canonicalResource, canonicalResource)))
    .limit(1);
  return row;
}

async function ensureServerDefinition(
  input: Pick<CreateNamedMcpConnectionInput, "userId" | "canonicalResource" | "endpoint">,
  runner: DbRunner,
): Promise<McpServer> {
  const endpointUrl = input.endpoint.href;
  const endpointOrigin = input.endpoint.origin;
  const [insertedServer] = await runner
    .insert(mcpServers)
    .values({
      userId: input.userId,
      canonicalResource: input.canonicalResource,
      endpointUrl,
      endpointOrigin,
    })
    .onConflictDoNothing({
      target: [mcpServers.userId, mcpServers.canonicalResource],
    })
    .returning();
  const server =
    insertedServer ?? (await readServerByResource(input.userId, input.canonicalResource, runner));
  if (!server) {
    throw new Error(
      `ensureServerDefinition: server vanished for resource ${input.canonicalResource}`,
    );
  }
  if (server.endpointUrl !== endpointUrl || server.endpointOrigin !== endpointOrigin) {
    throw new Error(
      `MCP resource '${input.canonicalResource}' already uses endpoint ${server.endpointUrl}`,
    );
  }
  return server;
}

function connectionInsertValues(
  input: CreateNamedMcpConnectionInput,
  serverId: string,
  instanceKey: string,
): NewMcpConnection {
  return {
    userId: input.userId,
    serverId,
    instanceKey,
    label: input.label,
    ...(input.initialState?.authServerIdentity !== undefined
      ? { authServerIdentity: input.initialState.authServerIdentity }
      : {}),
    ...(input.initialState?.status !== undefined ? { status: input.initialState.status } : {}),
  };
}

/** Create one fresh named instance. The persistence owner mints its immutable identity. */
export async function createNamedConnection(
  input: CreateNamedMcpConnectionInput,
  runner: DbRunner = db(),
): Promise<McpConnectionWithServer> {
  return runAtomic(runner, async (tx) => {
    const server = await ensureServerDefinition(input, tx);
    const [connection] = await tx
      .insert(mcpConnections)
      .values(connectionInsertValues(input, server.id, createId("mcpc")))
      .returning();
    return joinConnection({
      connection: requireRow(connection, "createNamedConnection"),
      server,
    });
  });
}

const BUILT_IN_CONNECTIONS = {
  github: {
    // Migration 0108 gives every historic server its one server-scoped built-in slot.
    instanceKey: "default",
    label: "GitHub MCP",
    canonicalResource: "https://api.githubcopilot.com/mcp",
    endpoint: new URL("https://api.githubcopilot.com/mcp"),
    initialState: {
      authServerIdentity: "oauth:pending",
      status: "disconnected",
    },
  },
} as const satisfies Record<
  string,
  Omit<CreateNamedMcpConnectionInput, "userId"> & { instanceKey: string }
>;

/** Ensure the one stable connection slot owned by a closed built-in provider definition. */
export async function ensureBuiltInConnection(
  userId: string,
  provider: keyof typeof BUILT_IN_CONNECTIONS,
  runner: DbRunner = db(),
): Promise<McpConnectionWithServer> {
  const builtIn = BUILT_IN_CONNECTIONS[provider];
  return runAtomic(runner, async (tx) => {
    const input: CreateNamedMcpConnectionInput = { userId, ...builtIn };
    const server = await ensureServerDefinition(input, tx);
    const [connection] = await tx
      .insert(mcpConnections)
      .values(connectionInsertValues(input, server.id, builtIn.instanceKey))
      .onConflictDoUpdate({
        target: [mcpConnections.userId, mcpConnections.serverId, mcpConnections.instanceKey],
        set: { updatedAt: new Date() },
      })
      .returning();
    return joinConnection({
      connection: requireRow(connection, "ensureBuiltInConnection"),
      server,
    });
  });
}

export async function readOwnedConnection(
  id: string,
  userId: string,
  runner: DbRunner = db(),
): Promise<McpConnectionWithServer | undefined> {
  const [row] = await runner
    .select(connectionWithServerSelection)
    .from(mcpConnections)
    .innerJoin(mcpServers, eq(mcpConnections.serverId, mcpServers.id))
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.userId, userId)))
    .limit(1);
  return row ? joinConnection(row) : undefined;
}

export async function listOwnedConnections(
  userId: string,
  runner: DbRunner = db(),
): Promise<McpConnectionWithServer[]> {
  const rows = await runner
    .select(connectionWithServerSelection)
    .from(mcpConnections)
    .innerJoin(mcpServers, eq(mcpConnections.serverId, mcpServers.id))
    .where(eq(mcpConnections.userId, userId))
    .orderBy(desc(mcpConnections.updatedAt))
    .limit(100);
  return rows.map(joinConnection);
}

/**
 * One owned connection and the exact immutable catalog revision it currently
 * points at. The renamed fields are projections of the named Drizzle row types;
 * no parallel database shape is maintained here.
 */
export type OwnedCurrentCatalogRow = Pick<McpConnection, "instanceKey" | "label"> & {
  namespace: McpServer["id"];
  connectionId: McpConnection["id"];
  revisionId: McpCatalogRevision["id"];
  descriptorCount: McpCatalogRevision["toolCount"];
} & Pick<McpCatalogRevision, "revisionHash">;

export type OwnedCurrentCatalogSliceRow = OwnedCurrentCatalogRow & {
  /** Absolute zero-based position of the first projected descriptor. */
  descriptorOffset: number;
  /** A database-projected slice. The complete persisted JSONB array never crosses this boundary. */
  descriptors: unknown[];
};

export type OwnedCurrentCatalogDescriptorRow = OwnedCurrentCatalogRow & {
  /** The exact selected descriptor, or null when the current catalog has no such name. */
  descriptor: unknown | null;
};

export type OwnedCurrentCatalogPosition = Pick<
  OwnedCurrentCatalogRow,
  "namespace" | "instanceKey" | "connectionId"
>;

export type ReadOwnedCurrentCatalogSliceInput = Pick<McpConnection, "userId"> & {
  connectionId: McpConnection["id"];
  descriptorOffset: number;
  descriptorLimit: number;
};

export type ReadOwnedCurrentCatalogDescriptorInput = Pick<McpConnection, "userId"> & {
  connectionId: McpConnection["id"];
  remoteName: string;
};

export type ListOwnedCurrentCatalogSlicesInput = Pick<McpConnection, "userId"> & {
  namespace?: McpServer["id"];
  connectionId?: McpConnection["id"];
  /** Exclusive stable-order position from the last catalog row already scanned. */
  after?: OwnedCurrentCatalogPosition;
  /** Both limits are clamped again here so no caller can issue an unbounded scan. */
  catalogLimit: number;
  descriptorLimit: number;
};

const ownedCurrentCatalogSelection = {
  namespace: mcpServers.id,
  connectionId: mcpConnections.id,
  instanceKey: mcpConnections.instanceKey,
  label: mcpConnections.label,
  revisionId: mcpCatalogRevisions.id,
  revisionHash: mcpCatalogRevisions.revisionHash,
  descriptorCount: sql<number>`jsonb_array_length(${mcpCatalogRevisions.descriptors})`.mapWith(
    Number,
  ),
} as const;

const MAX_DISCOVERY_CATALOGS = 4;
const MAX_DISCOVERY_DESCRIPTORS = 200;

function boundedLimit(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `MCP catalog projection limit must be a non-negative integer; received ${value}`,
    );
  }
  return Math.min(value, maximum);
}

function descriptorSlice(offset: number, limit: number) {
  return sql<unknown>`coalesce((
    select jsonb_agg(projected.descriptor order by projected.ordinality)
     from jsonb_array_elements(${mcpCatalogRevisions.descriptors})
           with ordinality as projected(descriptor, ordinality)
     where projected.ordinality > ${offset}::bigint
       and projected.ordinality <= (${offset}::bigint + ${limit}::bigint)
  ), '[]'::jsonb)`;
}

function toCatalogSliceRow(
  row: OwnedCurrentCatalogRow & { descriptors: unknown },
  descriptorOffset: number,
): OwnedCurrentCatalogSliceRow {
  if (!Array.isArray(row.descriptors)) {
    throw new Error("MCP catalog descriptor slice is not a JSON array");
  }
  return { ...row, descriptorOffset, descriptors: row.descriptors };
}

function afterOwnedCurrentCatalog(position: OwnedCurrentCatalogPosition | undefined) {
  if (!position) return undefined;
  return or(
    gt(mcpServers.id, position.namespace),
    and(
      eq(mcpServers.id, position.namespace),
      gt(mcpConnections.instanceKey, position.instanceKey),
    ),
    and(
      eq(mcpServers.id, position.namespace),
      eq(mcpConnections.instanceKey, position.instanceKey),
      gt(mcpConnections.id, position.connectionId),
    ),
  );
}

/** Read one bounded slice from an owned connection's exact current catalog. */
export async function readOwnedCurrentCatalogSlice(
  input: ReadOwnedCurrentCatalogSliceInput,
  runner: DbRunner = db(),
): Promise<OwnedCurrentCatalogSliceRow | undefined> {
  const descriptorOffset = boundedLimit(input.descriptorOffset, Number.MAX_SAFE_INTEGER);
  const descriptorLimit = boundedLimit(input.descriptorLimit, MAX_DISCOVERY_DESCRIPTORS);
  const [row] = await runner
    .select({
      ...ownedCurrentCatalogSelection,
      descriptors: descriptorSlice(descriptorOffset, descriptorLimit),
    })
    .from(mcpConnections)
    .innerJoin(
      mcpServers,
      and(eq(mcpServers.id, mcpConnections.serverId), eq(mcpServers.userId, input.userId)),
    )
    .innerJoin(
      mcpCatalogRevisions,
      and(
        eq(mcpCatalogRevisions.connectionId, mcpConnections.id),
        eq(mcpCatalogRevisions.id, mcpConnections.currentCatalogRevisionId),
      ),
    )
    .where(and(eq(mcpConnections.userId, input.userId), eq(mcpConnections.id, input.connectionId)))
    .limit(1);
  return row ? toCatalogSliceRow(row, descriptorOffset) : undefined;
}

/**
 * Read one exact descriptor from an owned connection's current catalog. The
 * scalar subquery projects at most one JSONB value; the complete array is never
 * returned to node-postgres.
 */
export async function readOwnedCurrentCatalogDescriptor(
  input: ReadOwnedCurrentCatalogDescriptorInput,
  runner: DbRunner = db(),
): Promise<OwnedCurrentCatalogDescriptorRow | undefined> {
  const [row] = await runner
    .select({
      ...ownedCurrentCatalogSelection,
      descriptor: sql<unknown>`(
        select projected.descriptor
          from jsonb_array_elements(${mcpCatalogRevisions.descriptors})
               as projected(descriptor)
         where projected.descriptor ->> 'name' = ${input.remoteName}
         limit 1
      )`,
    })
    .from(mcpConnections)
    .innerJoin(
      mcpServers,
      and(eq(mcpServers.id, mcpConnections.serverId), eq(mcpServers.userId, input.userId)),
    )
    .innerJoin(
      mcpCatalogRevisions,
      and(
        eq(mcpCatalogRevisions.connectionId, mcpConnections.id),
        eq(mcpCatalogRevisions.id, mcpConnections.currentCatalogRevisionId),
      ),
    )
    .where(and(eq(mcpConnections.userId, input.userId), eq(mcpConnections.id, input.connectionId)))
    .limit(1);
  return row;
}

type RawOwnedCurrentCatalogSliceRow = OwnedCurrentCatalogRow & { descriptors: unknown };

/**
 * Read a stable-order batch of owned current catalogs in one query. PostgreSQL
 * allocates one descriptor budget across the selected catalog rows before the
 * JSONB values cross the driver boundary. Namespace and connection filters are
 * exact and combine with AND; the current-revision join is still one batched
 * query rather than one revision read per connection.
 */
export async function listOwnedCurrentCatalogSlices(
  input: ListOwnedCurrentCatalogSlicesInput,
  runner: DbRunner = db(),
): Promise<OwnedCurrentCatalogSliceRow[]> {
  const catalogLimit = boundedLimit(input.catalogLimit, MAX_DISCOVERY_CATALOGS);
  const descriptorLimit = boundedLimit(input.descriptorLimit, MAX_DISCOVERY_DESCRIPTORS);
  if (catalogLimit === 0) return [];

  const ownedAndPositioned = and(
    eq(mcpConnections.userId, input.userId),
    input.namespace !== undefined ? eq(mcpServers.id, input.namespace) : undefined,
    input.connectionId !== undefined ? eq(mcpConnections.id, input.connectionId) : undefined,
    afterOwnedCurrentCatalog(input.after),
  );
  const result = await runner.execute(sql`
    with selected_catalogs as materialized (
      select ${mcpServers.id} as "namespace",
             ${mcpConnections.id} as "connectionId",
             ${mcpConnections.instanceKey} as "instanceKey",
             ${mcpConnections.label} as "label",
             ${mcpCatalogRevisions.id} as "revisionId",
             ${mcpCatalogRevisions.revisionHash} as "revisionHash",
             jsonb_array_length(${mcpCatalogRevisions.descriptors}) as "descriptorCount",
             ${mcpCatalogRevisions.descriptors} as "catalogDescriptors"
        from ${mcpConnections}
        inner join ${mcpServers}
          on ${mcpServers.id} = ${mcpConnections.serverId}
         and ${mcpServers.userId} = ${input.userId}
        inner join ${mcpCatalogRevisions}
          on ${mcpCatalogRevisions.connectionId} = ${mcpConnections.id}
         and ${mcpCatalogRevisions.id} = ${mcpConnections.currentCatalogRevisionId}
       where ${ownedAndPositioned}
       order by ${mcpServers.id}, ${mcpConnections.instanceKey}, ${mcpConnections.id}
       limit ${catalogLimit}
    ), budgeted_catalogs as (
      select selected_catalogs.*,
             coalesce(
               sum("descriptorCount") over (
                 order by "namespace", "instanceKey", "connectionId"
                 rows between unbounded preceding and 1 preceding
               ),
               0
             )::integer as "descriptorsBefore"
        from selected_catalogs
    )
    select "namespace",
           "connectionId",
           "instanceKey",
           "label",
           "revisionId",
           "revisionHash",
           "descriptorCount",
           coalesce((
             select jsonb_agg(projected.descriptor order by projected.ordinality)
               from jsonb_array_elements("catalogDescriptors")
                    with ordinality as projected(descriptor, ordinality)
              where projected.ordinality <= greatest(
                least(${descriptorLimit} - "descriptorsBefore", "descriptorCount"),
                0
              )
           ), '[]'::jsonb) as "descriptors"
      from budgeted_catalogs
     order by "namespace", "instanceKey", "connectionId"
  `);
  return rowsFromExecute<RawOwnedCurrentCatalogSliceRow>(result).map((row) =>
    toCatalogSliceRow(row, 0),
  );
}

export async function updateConnection(
  id: string,
  patch: McpConnectionUpdate,
  runner: DbRunner = db(),
): Promise<McpConnection | undefined> {
  const [row] = await runner
    .update(mcpConnections)
    .set(patch)
    .where(eq(mcpConnections.id, id))
    .returning();
  return row;
}

export interface CompareAndSetCatalogRevisionInput {
  connectionId: string;
  expectedCurrentRevisionId: string | null;
  nextRevisionId: string | null;
  patch: Omit<McpConnectionUpdate, "currentCatalogRevisionId">;
}

/**
 * Change catalog authority only if no other worker changed the durable pointer
 * since this operation began. A losing publisher must fetch again; a stale
 * invalidator must not clear a newer worker's revision.
 */
export async function compareAndSetCatalogRevision(
  input: CompareAndSetCatalogRevisionInput,
  runner: DbRunner = db(),
): Promise<McpConnection | undefined> {
  const expectedPointer = input.expectedCurrentRevisionId
    ? eq(mcpConnections.currentCatalogRevisionId, input.expectedCurrentRevisionId)
    : isNull(mcpConnections.currentCatalogRevisionId);
  const [row] = await runner
    .update(mcpConnections)
    .set({
      ...input.patch,
      currentCatalogRevisionId: input.nextRevisionId,
    })
    .where(and(eq(mcpConnections.id, input.connectionId), expectedPointer))
    .returning();
  return row;
}

// ===========================================================================
// Catalog revisions (immutable, append-only)
// ===========================================================================

export async function readRevisionById(
  id: string,
  runner: DbRunner = db(),
): Promise<McpCatalogRevision | undefined> {
  const [row] = await runner
    .select()
    .from(mcpCatalogRevisions)
    .where(eq(mcpCatalogRevisions.id, id))
    .limit(1);
  return row;
}

export async function readRevisionByHash(
  connectionId: string,
  revisionHash: string,
  runner: DbRunner = db(),
): Promise<McpCatalogRevision | undefined> {
  const [row] = await runner
    .select()
    .from(mcpCatalogRevisions)
    .where(
      and(
        eq(mcpCatalogRevisions.connectionId, connectionId),
        eq(mcpCatalogRevisions.revisionHash, revisionHash),
      ),
    )
    .limit(1);
  return row;
}

/** The revision currently pointed at by the connection, if any. */
export async function readCurrentRevision(
  connectionId: string,
  runner: DbRunner = db(),
): Promise<McpCatalogRevision | undefined> {
  const connection = await readConnection(connectionId, runner);
  if (!connection?.currentCatalogRevisionId) return undefined;
  return readRevisionById(connection.currentCatalogRevisionId, runner);
}

export interface PublishCatalogRevisionInput {
  connectionId: string;
  /** Stable authority hash (`McpCatalogSnapshot.revision`, "sha256:..."). */
  revisionHash: string;
  /** Raw, validated descriptors exactly as admitted by the raw client (`Tool[]`). */
  descriptors: unknown;
  /** `{ [remoteName]: descriptorHash }` from `computeDescriptorHashes`. */
  descriptorHashes: Record<string, string>;
  toolCount: number;
}

/**
 * The ONE genuinely-atomic catalog operation: publish (or re-use) an immutable
 * revision and advance the connection's current-revision pointer to it, in a
 * single transaction. Idempotent on `(connectionId, revisionHash)` — refreshing
 * an unchanged catalog returns the existing revision without inserting a
 * duplicate, and re-publishing is a no-op pointer write.
 *
 * The insert uses `onConflictDoNothing` so a concurrent publisher racing on the
 * same hash cannot produce two rows; the loser reads the winner's row back.
 */
export async function publishCatalogRevision(
  input: PublishCatalogRevisionInput,
  runner: DbRunner = db(),
): Promise<McpCatalogRevision> {
  const run = async (tx: DbRunner) => {
    const revision = await insertCatalogRevisionInTx(input, tx);
    await tx
      .update(mcpConnections)
      .set({ currentCatalogRevisionId: revision.id })
      .where(eq(mcpConnections.id, input.connectionId));
    return revision;
  };
  // Atomic either way: a root client opens a transaction, and a caller's open
  // transaction gets a SAVEPOINT nested inside it, so a failure here rolls back
  // both writes and leaves the caller's transaction usable (see `runAtomic`).
  return runAtomic(runner, run);
}

/**
 * Idempotently insert an immutable catalog revision without making it current.
 * The connection manager uses this to verify that the in-memory generation is
 * still live before it promotes the durable pointer.
 */
export async function insertCatalogRevision(
  input: PublishCatalogRevisionInput,
  runner: DbRunner = db(),
): Promise<McpCatalogRevision> {
  const run = (tx: DbRunner) => insertCatalogRevisionInTx(input, tx);
  return runAtomic(runner, run);
}

async function insertCatalogRevisionInTx(
  input: PublishCatalogRevisionInput,
  tx: DbRunner,
): Promise<McpCatalogRevision> {
  const [inserted] = await tx
    .insert(mcpCatalogRevisions)
    .values({
      connectionId: input.connectionId,
      revisionHash: input.revisionHash,
      descriptors: input.descriptors,
      descriptorHashes: input.descriptorHashes,
      toolCount: input.toolCount,
    })
    .onConflictDoNothing({
      target: [mcpCatalogRevisions.connectionId, mcpCatalogRevisions.revisionHash],
    })
    .returning();

  const revision =
    inserted ?? (await readRevisionByHash(input.connectionId, input.revisionHash, tx));
  if (!revision) {
    // Unreachable: the row was either just inserted or already present.
    throw new Error(
      `publishCatalogRevision: revision vanished for connection ${input.connectionId}`,
    );
  }

  return revision;
}
