/**
 * Row access for MCP servers, connections, and catalog revisions. No network I/O.
 * The invocation ledger lives in `tool-runtime/mcp`; never import it here.
 */

import { BUILT_IN_MCP_CATALOG } from "@alfred/contracts";
import { db, rowsFromExecute, type DbTransaction } from "@alfred/db";
import { requireRow, runAtomic, type DbRunner } from "@alfred/db/helpers";
import {
  mcpCatalogRevisions,
  mcpConnections,
  mcpOauthCredentials,
  mcpApiKeyCredentials,
  mcpServers,
  type McpCatalogRevision,
  type McpConnection,
  type McpServer,
  type NewMcpConnection,
  type NewMcpServer,
} from "@alfred/db/schemas";
import type { Tool } from "@modelcontextprotocol/client";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { MCP_DISCOVERY_SCAN_BUDGET } from "./discovery-policy";
import { compareMcpToolNames, projectCatalogRevision } from "./hash";

import { BUILT_IN_REGISTRY, type BuiltInProvider } from "./built-ins";

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

/** A connection plus its current tool count, `null` before the first revision. */
export type McpConnectionSummary = McpConnectionWithServer & {
  readonly toolCount: McpCatalogRevision["toolCount"] | null;
};

/** `instanceKey` is the idempotency key: same key, same row; new key, a second instance. */
export type EnsureMcpConnectionInput = Pick<NewMcpConnection, "userId" | "label" | "instanceKey"> &
  Pick<NewMcpServer, "canonicalResource"> & {
    endpoint: URL;
    /** `"caller"` refuses to retarget a stored endpoint. `"registry"` retargets it to the pinned URL. */
    endpointAuthority?: "caller" | "registry";
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

/**
 * Oldest-first page for background recovery: `connecting` and `failed` rows.
 * `auth_required` is skipped because only the owner can fix it.
 */
export async function listRecoverableCredentialedConnectionIds(
  cutoff: Date,
  limit: number,
  runner: DbRunner = db(),
): Promise<string[]> {
  const rows = await runner
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .leftJoin(
      mcpOauthCredentials,
      and(
        eq(mcpOauthCredentials.id, mcpConnections.credentialId),
        eq(mcpOauthCredentials.connectionId, mcpConnections.id),
        eq(mcpOauthCredentials.userId, mcpConnections.userId),
      ),
    )
    .leftJoin(
      mcpApiKeyCredentials,
      and(
        eq(mcpApiKeyCredentials.id, mcpConnections.apiKeyCredentialId),
        eq(mcpApiKeyCredentials.connectionId, mcpConnections.id),
        eq(mcpApiKeyCredentials.userId, mcpConnections.userId),
      ),
    )
    .where(
      and(
        inArray(mcpConnections.status, ["connecting", "failed"]),
        isNotNull(mcpConnections.lastError),
        lt(mcpConnections.updatedAt, cutoff),
        or(
          and(isNotNull(mcpOauthCredentials.accessToken), isNotNull(mcpOauthCredentials.tokenType)),
          isNotNull(mcpApiKeyCredentials.id),
        ),
      ),
    )
    .orderBy(asc(mcpConnections.updatedAt), asc(mcpConnections.id))
    .limit(limit);

  return rows.map((row) => row.id);
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
  input: Pick<
    EnsureMcpConnectionInput,
    "userId" | "canonicalResource" | "endpoint" | "endpointAuthority"
  >,
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

  if (server.endpointUrl === endpointUrl && server.endpointOrigin === endpointOrigin) {
    return server;
  }

  if (input.endpointAuthority !== "registry") {
    throw new Error(
      `MCP resource '${input.canonicalResource}' already uses endpoint ${server.endpointUrl}`,
    );
  }

  const [retargeted] = await runner
    .update(mcpServers)
    .set({ endpointUrl, endpointOrigin })
    .where(eq(mcpServers.id, server.id))
    .returning();

  return requireRow(retargeted, "ensureServerDefinition");
}

/** Ensure a connection and its server. A replay keeps account state and updates only `label` and `updatedAt`. */
export async function ensureConnection(
  input: EnsureMcpConnectionInput,
  runner: DbRunner = db(),
): Promise<McpConnectionWithServer> {
  return runAtomic(runner, async (tx) => {
    const server = await ensureServerDefinition(input, tx);

    const [connection] = await tx
      .insert(mcpConnections)
      .values({
        userId: input.userId,
        serverId: server.id,
        instanceKey: input.instanceKey,
        label: input.label,
        ...(input.initialState?.authServerIdentity !== undefined
          ? { authServerIdentity: input.initialState.authServerIdentity }
          : {}),
        ...(input.initialState?.status !== undefined ? { status: input.initialState.status } : {}),
      })
      .onConflictDoUpdate({
        target: [mcpConnections.userId, mcpConnections.serverId, mcpConnections.instanceKey],
        // A re-add that fixes the name must not keep the old one.
        set: { label: input.label, updatedAt: new Date() },
      })
      .returning();

    return joinConnection({
      connection: requireRow(connection, "ensureConnection"),
      server,
    });
  });
}

/**
 * Ensure a built-in's one slot, with endpoint and resource from the registry.
 * `addUserMcpServer` refuses built-in URLs, so no row skips the ADR-0094/0095 pins.
 */
export async function ensureBuiltInConnection(
  userId: string,
  provider: BuiltInProvider,
  runner: DbRunner = db(),
): Promise<McpConnectionWithServer> {
  const builtIn = BUILT_IN_REGISTRY[provider];

  return ensureConnection(
    {
      userId,
      // The label is the catalog tile title, so card and row agree.
      label: BUILT_IN_MCP_CATALOG[provider].label,
      instanceKey: builtIn.instanceKey,
      canonicalResource: builtIn.canonicalResource,
      endpoint: new URL(builtIn.endpointHref),
      endpointAuthority: "registry",
      initialState: builtIn.initialState,
    },
    runner,
  );
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
): Promise<McpConnectionSummary[]> {
  const rows = await runner
    .select({
      ...connectionWithServerSelection,
      toolCount: mcpCatalogRevisions.toolCount,
    })
    .from(mcpConnections)
    .innerJoin(mcpServers, eq(mcpConnections.serverId, mcpServers.id))
    // LEFT join: a connection lists before its first revision.
    .leftJoin(
      mcpCatalogRevisions,
      eq(mcpCatalogRevisions.id, mcpConnections.currentCatalogRevisionId),
    )
    .where(eq(mcpConnections.userId, userId))
    .orderBy(desc(mcpConnections.updatedAt))
    .limit(100);

  return rows.map(({ toolCount, ...row }) => ({ ...joinConnection(row), toolCount }));
}

/** One owned connection and its current catalog revision. */
export type OwnedCurrentCatalogRow = Pick<McpConnection, "instanceKey" | "label"> & {
  namespace: McpServer["id"];
  connectionId: McpConnection["id"];
  revisionId: McpCatalogRevision["id"];
  descriptorCount: McpCatalogRevision["toolCount"];
} & Pick<McpCatalogRevision, "revisionHash">;

export type OwnedCurrentCatalogSliceRow = OwnedCurrentCatalogRow & {
  /** Absolute zero-based position of the first projected descriptor. */
  descriptorOffset: number;
  /** `{ name, title, description }` summaries projected in SQL, so full descriptors stay in the database. */
  summaries: unknown[];
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
  /** Both limits are clamped again. `catalogLimit: 0` only answers `hasMore`. */
  catalogLimit: number;
  descriptorLimit: number;
};

export interface OwnedCurrentCatalogSlicePage {
  rows: OwnedCurrentCatalogSliceRow[];
  /** One more owned current catalog follows the last row in stable order. */
  hasMore: boolean;
}

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

function boundedLimit(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `MCP catalog projection limit must be a non-negative integer; received ${value}`,
    );
  }

  return Math.min(value, maximum);
}

/** SQL summary projection over a bounded slice. Takes SQL inputs so it works on a table or a CTE. */
function descriptorSummarySlice(descriptors: SQL, offset: SQL, limit: SQL): SQL<unknown> {
  return sql`coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'name', selected.descriptor -> 'name',
               'title', selected.descriptor -> 'title',
               'description', selected.descriptor -> 'description'
             )
             order by projected."index"
           )
      from generate_series(
             0::bigint,
             greatest(
               least(
                 ${limit}::bigint,
                 jsonb_array_length(${descriptors})::bigint - ${offset}::bigint
               ),
               0::bigint
             ) - 1::bigint
           ) as projected("index")
     cross join lateral (
       select ${descriptors} -> (${offset}::bigint + projected."index")::integer
     ) as selected(descriptor)
  ), '[]'::jsonb)`;
}

function toCatalogSliceRow(
  row: OwnedCurrentCatalogRow & { summaries: unknown },
  descriptorOffset: number,
): OwnedCurrentCatalogSliceRow {
  if (!Array.isArray(row.summaries)) {
    throw new Error("MCP catalog summary slice is not a JSON array");
  }

  return { ...row, descriptorOffset, summaries: row.summaries };
}

function ownedServerJoin(userId: string) {
  return and(eq(mcpServers.id, mcpConnections.serverId), eq(mcpServers.userId, userId));
}

const currentRevisionJoin = and(
  eq(mcpCatalogRevisions.connectionId, mcpConnections.id),
  eq(mcpCatalogRevisions.id, mcpConnections.currentCatalogRevisionId),
);

function ownedConnectionWhere(userId: string, connectionId: string) {
  return and(eq(mcpConnections.userId, userId), eq(mcpConnections.id, connectionId));
}

/** Read one bounded summary slice from an owned connection's exact current catalog. */
export async function readOwnedCurrentCatalogSlice(
  input: ReadOwnedCurrentCatalogSliceInput,
  runner: DbRunner = db(),
): Promise<OwnedCurrentCatalogSliceRow | undefined> {
  const descriptorOffset = boundedLimit(input.descriptorOffset, Number.MAX_SAFE_INTEGER);

  const descriptorLimit = boundedLimit(
    input.descriptorLimit,
    MCP_DISCOVERY_SCAN_BUDGET.descriptorLimit,
  );

  const [row] = await runner
    .select({
      ...ownedCurrentCatalogSelection,
      summaries: descriptorSummarySlice(
        sql`${mcpCatalogRevisions.descriptors}`,
        sql`${descriptorOffset}`,
        sql`${descriptorLimit}`,
      ),
    })
    .from(mcpConnections)
    .innerJoin(mcpServers, ownedServerJoin(input.userId))
    .innerJoin(mcpCatalogRevisions, currentRevisionJoin)
    .where(ownedConnectionWhere(input.userId, input.connectionId))
    .limit(1);

  return row ? toCatalogSliceRow(row, descriptorOffset) : undefined;
}

/**
 * Read one descriptor by `name` in SQL. Does not depend on array order, so
 * legacy revisions also resolve. Ingest caps a catalog at 1,000 descriptors.
 */
export async function readOwnedCurrentCatalogDescriptor(
  input: ReadOwnedCurrentCatalogDescriptorInput,
  runner: DbRunner = db(),
): Promise<OwnedCurrentCatalogDescriptorRow | undefined> {
  const [row] = await runner
    .select({
      ...ownedCurrentCatalogSelection,
      descriptor: sql<unknown>`(
        select candidate.descriptor
          from jsonb_array_elements(${mcpCatalogRevisions.descriptors}) as candidate(descriptor)
         where candidate.descriptor ->> 'name' = ${input.remoteName}
         limit 1
      )`,
    })
    .from(mcpConnections)
    .innerJoin(mcpServers, ownedServerJoin(input.userId))
    .innerJoin(mcpCatalogRevisions, currentRevisionJoin)
    .where(ownedConnectionWhere(input.userId, input.connectionId))
    .limit(1);

  return row ? { ...row, descriptor: row.descriptor ?? null } : undefined;
}

type RawOwnedCurrentCatalogSliceRow = OwnedCurrentCatalogRow & { summaries: unknown };

/**
 * One page of owned current catalogs in `(server_id, instance_key)` order, in one query.
 * Fetches `catalogLimit + 1` rows; the extra one only answers `hasMore`.
 */
export async function listOwnedCurrentCatalogSlices(
  input: ListOwnedCurrentCatalogSlicesInput,
  runner: DbRunner = db(),
): Promise<OwnedCurrentCatalogSlicePage> {
  const catalogLimit = boundedLimit(input.catalogLimit, MCP_DISCOVERY_SCAN_BUDGET.catalogLimit);

  const descriptorLimit = boundedLimit(
    input.descriptorLimit,
    MCP_DISCOVERY_SCAN_BUDGET.descriptorLimit,
  );

  const ownedCurrentCatalog = and(
    eq(mcpConnections.userId, input.userId),
    sql`${mcpConnections.currentCatalogRevisionId} is not null`,
    input.namespace !== undefined ? eq(mcpConnections.serverId, input.namespace) : undefined,
    input.connectionId !== undefined ? eq(mcpConnections.id, input.connectionId) : undefined,
    input.after
      ? sql`(${mcpConnections.serverId}, ${mcpConnections.instanceKey}) > (${input.after.namespace}, ${input.after.instanceKey})`
      : undefined,
  );

  const result = await runner.execute(sql`
    with selected_catalogs as (
      select pointer."namespace",
             pointer."connectionId",
             pointer."instanceKey",
             pointer."label",
             ${mcpCatalogRevisions.id} as "revisionId",
             ${mcpCatalogRevisions.revisionHash} as "revisionHash",
             jsonb_array_length(${mcpCatalogRevisions.descriptors}) as "descriptorCount",
             ${mcpCatalogRevisions.descriptors} as "catalogDescriptors",
             pointer."ordinal"
        from (
          select ${mcpConnections.serverId} as "namespace",
                 ${mcpConnections.id} as "connectionId",
                 ${mcpConnections.instanceKey} as "instanceKey",
                 ${mcpConnections.label} as "label",
                 ${mcpConnections.currentCatalogRevisionId} as "revisionId",
                 row_number() over (
                   order by ${mcpConnections.serverId}, ${mcpConnections.instanceKey}
                 ) as "ordinal"
            from ${mcpConnections}
           where ${ownedCurrentCatalog}
           order by ${mcpConnections.serverId}, ${mcpConnections.instanceKey}
           limit ${catalogLimit + 1}
        ) pointer
        join ${mcpServers}
          on ${mcpServers.id} = pointer."namespace"
         and ${mcpServers.userId} = ${input.userId}
        join ${mcpCatalogRevisions}
          on ${mcpCatalogRevisions.connectionId} = pointer."connectionId"
         and ${mcpCatalogRevisions.id} = pointer."revisionId"
    ), budgeted_catalogs as (
      select selected_catalogs.*,
             coalesce(
               sum("descriptorCount") over (
                 order by "ordinal"
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
           "ordinal",
           ${descriptorSummarySlice(
             sql`"catalogDescriptors"`,
             sql`0`,
             sql`case when "ordinal" <= ${catalogLimit} then ${descriptorLimit} - "descriptorsBefore" else 0 end`,
           )} as "summaries"
      from budgeted_catalogs
     order by "ordinal"
  `);

  const fetched = rowsFromExecute<RawOwnedCurrentCatalogSliceRow & { ordinal: unknown }>(result);

  return {
    rows: fetched
      .slice(0, catalogLimit)
      .map(({ ordinal: _ordinal, ...row }) => toCatalogSliceRow(row, 0)),
    hasMore: fetched.length > catalogLimit,
  };
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

/** Rename an owned connection. Owner check is in the `WHERE`; only `label` changes. */
export async function renameOwnedConnection(
  input: { connectionId: string; userId: string; label: string },
  runner: DbRunner = db(),
): Promise<McpConnection | undefined> {
  const [row] = await runner
    .update(mcpConnections)
    .set({ label: input.label })
    .where(and(eq(mcpConnections.id, input.connectionId), eq(mcpConnections.userId, input.userId)))
    .returning();

  return row;
}

/** Caller-supplied refusal check, run under the row lock, so this module never imports the ledger. */
export interface McpConnectionRemovalGate {
  /** Runs inside the removal transaction, after the owner row lock. True = refuse. */
  blocks(tx: DbTransaction, input: { connectionId: string; userId: string }): Promise<boolean>;
}

export type McpConnectionRemovalOutcome = "removed" | "not_found" | "blocked";

/**
 * Delete an owned connection; credentials cascade. Lock `FOR UPDATE`, run the gate, delete.
 * The lock makes the gate race-free: an invocation insert takes `FOR KEY SHARE` on the row.
 * `gate` is required; skip it with an explicit `"none"`.
 */
export async function deleteOwnedConnection(
  input: { connectionId: string; userId: string; gate: McpConnectionRemovalGate | "none" },
  runner: DbRunner = db(),
): Promise<McpConnectionRemovalOutcome> {
  return runAtomic(runner, async (tx) => {
    const [locked] = await tx
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(
        and(eq(mcpConnections.id, input.connectionId), eq(mcpConnections.userId, input.userId)),
      )
      .for("update")
      .limit(1);

    if (!locked) return "not_found";

    if (
      input.gate !== "none" &&
      (await input.gate.blocks(tx, {
        connectionId: input.connectionId,
        userId: input.userId,
      }))
    ) {
      return "blocked";
    }

    const deleted = await tx
      .delete(mcpConnections)
      .where(
        and(eq(mcpConnections.id, input.connectionId), eq(mcpConnections.userId, input.userId)),
      )
      .returning({ id: mcpConnections.id });

    return deleted.length > 0 ? "removed" : "not_found";
  });
}

export interface CompareAndSetCatalogRevisionInput {
  connectionId: string;
  expectedCurrentRevisionId: string | null;
  nextRevisionId: string | null;
  patch: Omit<McpConnectionUpdate, "currentCatalogRevisionId">;
}

/** Compare-and-set on the revision pointer, so a stale worker cannot overwrite a newer one. */
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
  /**
   * Admitted descriptors in `compareMcpToolNames` order. Hashes, read-only map,
   * and count derive from them ({@link projectCatalogRevision}).
   */
  descriptors: readonly Tool[];
}

/** Require strict `compareMcpToolNames` order, which also proves names are unique. */
function assertCanonicalCatalogPublication(descriptors: readonly Tool[]): void {
  for (let index = 1; index < descriptors.length; index += 1) {
    const previous = descriptors[index - 1];
    const current = descriptors[index];

    if (
      previous === undefined ||
      current === undefined ||
      compareMcpToolNames(previous.name, current.name) >= 0
    ) {
      throw new Error("MCP catalog descriptors must use unique canonical tool-name order");
    }
  }
}

/**
 * Publish or reuse a revision and point the connection at it, atomically.
 * Idempotent on `(connectionId, revisionHash)`. A re-publish never repairs an old
 * row, so pre-`read_only_hints` revisions keep `{}` and the `high` floor (ADR-0096).
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

  return runAtomic(runner, run);
}

/** Insert a revision without making it current. The manager promotes it once its generation is still live. */
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
  assertCanonicalCatalogPublication(input.descriptors);
  const projection = projectCatalogRevision(input.descriptors);

  const [inserted] = await tx
    .insert(mcpCatalogRevisions)
    .values({
      connectionId: input.connectionId,
      revisionHash: input.revisionHash,
      descriptors: input.descriptors,
      descriptorHashes: projection.descriptorHashes,
      readOnlyHints: projection.readOnlyHints,
      toolCount: input.descriptors.length,
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
