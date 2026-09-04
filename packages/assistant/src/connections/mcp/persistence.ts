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
 *  - `ensureConnection` — server definition + one connection instance, keyed by
 *    the caller's instance key;
 *  - `publishCatalogRevision` — idempotent insert of an immutable revision +
 *    advance of the connection's current-revision pointer.
 *
 * The invocation ledger and the per-tool policy rows are NOT here. They belong to
 * the tool runtime, which owns durable invocation and the ADR-0088 approval
 * derivation, and they live in `@alfred/assistant/tool-runtime/mcp`. That split is
 * one-way on purpose: nothing in this module may reach the invocation half.
 */

import { db, rowsFromExecute } from "@alfred/db";
import { requireRow, runAtomic, type DbRunner } from "@alfred/db/helpers";
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
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { MCP_DISCOVERY_SCAN_BUDGET } from "./discovery-policy";
import { compareMcpToolNames } from "./hash";

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

/**
 * One connection ensure. `instanceKey` is the caller's idempotency key inside
 * one server definition: the same key returns the same row, and a different key
 * mints a second instance on the same endpoint. The caller always supplies it,
 * so the column carries one meaning — a built-in passes its stable slot, and the
 * connection-create operation will pass the key that identifies the click.
 */
export type EnsureMcpConnectionInput = Pick<NewMcpConnection, "userId" | "label" | "instanceKey"> &
  Pick<NewMcpServer, "canonicalResource"> & {
    endpoint: URL;
    /**
     * Who owns the endpoint of this server definition. `"caller"` refuses to
     * retarget a resource that already points elsewhere. `"registry"` says the
     * built-in table in `built-ins.ts` is the source of truth, so a pinned URL
     * that moves in code retargets the stored row instead of throwing for every
     * user who already connected.
     */
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

/**
 * Ensure one connection instance and the server definition it points at.
 *
 * The insert conflicts on `(userId, serverId, instanceKey)`, so a replay returns
 * the SAME row and touches only `updatedAt`. Account state — status, last error,
 * granted scopes, the credential, the catalog pointer — survives a replay,
 * because the caller that reconnects is not the caller that knows whether the
 * account is still good.
 */
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
        set: { updatedAt: new Date() },
      })
      .returning();
    return joinConnection({
      connection: requireRow(connection, "ensureConnection"),
      server,
    });
  });
}

/**
 * Ensure the one stable slot a closed built-in provider owns. This is the only
 * creation door the HTTP layer may open until the endpoint-authorizer slice
 * admits arbitrary URLs, so the registry — not a request — supplies the
 * endpoint, the canonical resource and the instance key.
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
      label: builtIn.label,
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
  /**
   * A database-projected slice of `{ name, title, description }` summaries.
   * Search reads only those three strings, so neither the full descriptors nor
   * the complete persisted JSONB array ever crosses this boundary.
   */
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
  /**
   * Both limits are clamped again here so no caller can issue an unbounded
   * page. `catalogLimit: 0` projects nothing and only answers `hasMore`.
   */
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

/**
 * The ONE summary projection both discovery reads share. It walks a bounded
 * `generate_series` of array positions and builds `{ name, title, description }`
 * for each, so a descriptor's `inputSchema` and any other key stay in the row.
 * `descriptors`, `offset`, and `limit` are SQL expressions because the same
 * projection runs over a table column and over a CTE column.
 */
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

const descriptorHashesSchema = z.unknown().transform((value, context) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    context.addIssue({ code: "custom", message: "Expected a descriptor hash record" });
    return z.NEVER;
  }

  const hashes: Record<string, string> = {};
  for (const [name, candidate] of Object.entries(value)) {
    const hash = z.string().safeParse(candidate);
    if (!hash.success) {
      context.addIssue({ code: "custom", message: `Expected a string hash for '${name}'` });
      return z.NEVER;
    }
    Object.defineProperty(hashes, name, {
      configurable: true,
      enumerable: true,
      value: hash.data,
      writable: true,
    });
  }
  return hashes;
});

/**
 * The same untrusted-key discipline as `descriptorHashesSchema`, over booleans.
 * A non-boolean value is a publication bug, not a degraded read, so it fails
 * the whole publication rather than coercing to `false`.
 */
const readOnlyHintsSchema = z.unknown().transform((value, context) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    context.addIssue({ code: "custom", message: "Expected a read-only hint record" });
    return z.NEVER;
  }

  const hints: Record<string, boolean> = {};
  for (const [name, candidate] of Object.entries(value)) {
    const hint = z.boolean().safeParse(candidate);
    if (!hint.success) {
      context.addIssue({ code: "custom", message: `Expected a boolean hint for '${name}'` });
      return z.NEVER;
    }
    Object.defineProperty(hints, name, {
      configurable: true,
      enumerable: true,
      value: hint.data,
      writable: true,
    });
  }
  return hints;
});

function toCatalogSliceRow(
  row: OwnedCurrentCatalogRow & { summaries: unknown },
  descriptorOffset: number,
): OwnedCurrentCatalogSliceRow {
  if (!Array.isArray(row.summaries)) {
    throw new Error("MCP catalog summary slice is not a JSON array");
  }
  return { ...row, descriptorOffset, summaries: row.summaries };
}

/** The join predicates every owned-current-catalog read shares. */
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
 * Read one exact descriptor from an owned connection's current catalog. The
 * descriptor is selected by its `name` inside PostgreSQL, so the read derives
 * nothing from the hash map or from the publisher's array order, and a legacy
 * revision that predates `assertCanonicalCatalogPublication` resolves exactly.
 * The scan is bounded by one catalog, which ingest caps at 1,000 descriptors,
 * and only the one selected descriptor crosses the driver boundary.
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
 * Read a stable-order page of owned current catalogs in one query. This is a
 * PAGE bound, not a plan bound: the connection subquery returns at most
 * `catalogLimit + 1` pointers in `(server_id, instance_key)` order, PostgreSQL
 * allocates one summary budget across the first `catalogLimit` of them, and the
 * extra pointer only answers `hasMore`, so a page never ends with a cursor that
 * leads to an empty page. Which index the planner walks to get there is its
 * choice; the unique `(user_id, server_id, instance_key)` index fits the order
 * and the keyset. Namespace and connection filters remain exact and combine
 * with AND.
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
  /** `{ [remoteName]: readOnly }` from `computeReadOnlyHints`. */
  readOnlyHints: Record<string, boolean>;
  toolCount: number;
}

const catalogDescriptorNamesSchema = z.array(z.object({ name: z.string().min(1) }).passthrough());

/**
 * Publication admits only the canonical shape the client produces: descriptors
 * in strict `compareMcpToolNames` order and a hash map over exactly those names.
 * Strict order proves the names are unique, and exact inspection selects a
 * descriptor by name, so uniqueness is what keeps that selection exact. Legacy
 * revisions are not re-validated; the by-name read does not depend on them.
 */
function assertCanonicalCatalogPublication(input: PublishCatalogRevisionInput): void {
  const descriptors = catalogDescriptorNamesSchema.safeParse(input.descriptors);
  if (!descriptors.success) {
    throw new Error("MCP catalog descriptors must be an array of named objects");
  }
  const descriptorHashes = descriptorHashesSchema.safeParse(input.descriptorHashes);
  if (!descriptorHashes.success) {
    throw new Error("MCP catalog descriptor hashes must be a string record");
  }

  const names = descriptors.data.map((descriptor) => descriptor.name);
  if (names.length !== input.toolCount) {
    throw new Error("MCP catalog tool count must match its descriptor array");
  }
  for (let index = 1; index < names.length; index += 1) {
    const previous = names[index - 1];
    const current = names[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareMcpToolNames(previous, current) >= 0
    ) {
      throw new Error("MCP catalog descriptors must use unique canonical tool-name order");
    }
  }

  const hashNames = Object.keys(descriptorHashes.data).sort(compareMcpToolNames);
  if (hashNames.length !== names.length || hashNames.some((name, index) => name !== names[index])) {
    throw new Error("MCP catalog descriptor hashes must cover the exact descriptor names");
  }

  // The read-only map covers the SAME names, for the same reason: a downgrade
  // resolves one tool by name, so a name the map omits would read as `false` —
  // safe here, but silently so. Requiring full coverage keeps a publication bug
  // loud instead of turning it into an invisible re-gate (ADR-0096).
  const readOnlyHints = readOnlyHintsSchema.safeParse(input.readOnlyHints);
  if (!readOnlyHints.success) {
    throw new Error("MCP catalog read-only hints must be a boolean record");
  }
  const hintNames = Object.keys(readOnlyHints.data).sort(compareMcpToolNames);
  if (hintNames.length !== names.length || hintNames.some((name, index) => name !== names[index])) {
    throw new Error("MCP catalog read-only hints must cover the exact descriptor names");
  }
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
  assertCanonicalCatalogPublication(input);
  const [inserted] = await tx
    .insert(mcpCatalogRevisions)
    .values({
      connectionId: input.connectionId,
      revisionHash: input.revisionHash,
      descriptors: input.descriptors,
      descriptorHashes: input.descriptorHashes,
      readOnlyHints: input.readOnlyHints,
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
