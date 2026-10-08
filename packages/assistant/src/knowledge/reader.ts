import { db } from "@alfred/db";
import {
  activeProjectionVersions,
  entityIdentities,
  entityCoOccurrence,
  entityEdges,
  entityProfiles,
  type ActiveProjectionVersion,
  type EntityCoOccurrence,
  type EntityEdge,
  type EntityProfile,
} from "@alfred/db/schemas";
import {
  USER_MODEL_PROJECTION_NAME,
  identityRefSchema,
  isEntityIdentityKind,
  type EntityEdgeType,
  type EntityNodeKind,
  type IdentityKind,
} from "@alfred/contracts";
import { and, asc, desc, eq, gte, isNull, sql, type SQL } from "drizzle-orm";

/**
 * Every `list*` is capped, so one call cannot dump a projection into a prompt.
 * `limit` can lower the cap, never raise it past {@link MAX_READ_LIMIT}. Orders are
 * deterministic, so the cap is a stable top N.
 */
const DEFAULT_READ_LIMIT = 500;

const MAX_READ_LIMIT = 2000;

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_READ_LIMIT;

  return Math.min(Math.floor(limit), MAX_READ_LIMIT);
}

/** Alias, so consumers depend on "active" rows, not on the versioned table. */
export type ActiveEntityProfile = EntityProfile;

export type ActiveEntityEdge = EntityEdge;

export type ActiveEntityCoOccurrence = EntityCoOccurrence;

/**
 * The one read surface over the active user-model projection (ADR-0067 D13).
 * Versioned tables hold every version at once, so one forgotten filter gives
 * mixed-version reads. This pins rows to the active run (`active_run_id =
 * projection_run_id`). Empty until a run is activated.
 */
export function userModelReader(
  userId: string,
  projectionName: string = USER_MODEL_PROJECTION_NAME,
) {
  /** Null when no run is activated yet. */
  async function getActivePointer(): Promise<ActiveProjectionVersion | null> {
    const [row] = await db()
      .select()
      .from(activeProjectionVersions)
      .where(
        and(
          eq(activeProjectionVersions.userId, userId),
          eq(activeProjectionVersions.projectionName, projectionName),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  async function listProfiles(
    opts: { kind?: EntityNodeKind; limit?: number } = {},
  ): Promise<ActiveEntityProfile[]> {
    const conds: SQL[] = [
      eq(entityProfiles.userId, userId),
      eq(entityProfiles.projectionName, projectionName),
      eq(entityProfiles.projectionVersion, activeProjectionVersions.activeVersion),
      eq(entityProfiles.projectionRunId, activeProjectionVersions.activeRunId),
    ];

    if (opts.kind) conds.push(eq(entityProfiles.kind, opts.kind));

    const rows = await db()
      .select()
      .from(entityProfiles)
      .innerJoin(
        activeProjectionVersions,
        and(
          eq(activeProjectionVersions.userId, userId),
          eq(activeProjectionVersions.projectionName, projectionName),
        ),
      )
      .where(and(...conds))
      // Most recently seen first, `entity_id` breaks ties.
      .orderBy(sql`${entityProfiles.lastSeenAt} desc nulls last`, asc(entityProfiles.entityId))
      .limit(clampLimit(opts.limit));

    return rows.map((r) => r.entity_profiles);
  }

  /**
   * Resolves the raw stable id only, with no merge forwarding (D16). No code
   * writes `supersedes_entity_id` yet, so no loser id can exist.
   */
  async function getProfile(entityId: string): Promise<ActiveEntityProfile | null> {
    const rows = await db()
      .select()
      .from(entityProfiles)
      .innerJoin(
        activeProjectionVersions,
        and(
          eq(activeProjectionVersions.userId, userId),
          eq(activeProjectionVersions.projectionName, projectionName),
        ),
      )
      .where(
        and(
          eq(entityProfiles.userId, userId),
          eq(entityProfiles.projectionName, projectionName),
          eq(entityProfiles.entityId, entityId),
          eq(entityProfiles.projectionVersion, activeProjectionVersions.activeVersion),
          eq(entityProfiles.projectionRunId, activeProjectionVersions.activeRunId),
        ),
      )
      .limit(1);

    return rows[0]?.entity_profiles ?? null;
  }

  async function getProfileByIdentity(args: {
    kind: IdentityKind;
    value: string;
  }): Promise<ActiveEntityProfile | null> {
    const identity = identityRefSchema.parse(args);

    // A forward kind has no writer, so no identity row can hold it (#1028).
    if (!isEntityIdentityKind(identity.kind)) return null;

    const rows = await db()
      .select({ profile: entityProfiles })
      .from(entityIdentities)
      .innerJoin(
        entityProfiles,
        and(
          eq(entityProfiles.userId, entityIdentities.userId),
          eq(entityProfiles.entityId, entityIdentities.entityId),
        ),
      )
      .innerJoin(
        activeProjectionVersions,
        and(
          eq(activeProjectionVersions.userId, userId),
          eq(activeProjectionVersions.projectionName, projectionName),
        ),
      )
      .where(
        and(
          eq(entityIdentities.userId, userId),
          eq(entityIdentities.kind, identity.kind),
          eq(entityIdentities.value, identity.value),
          isNull(entityIdentities.validUntil),
          eq(entityProfiles.userId, userId),
          eq(entityProfiles.projectionName, projectionName),
          eq(entityProfiles.projectionVersion, activeProjectionVersions.activeVersion),
          eq(entityProfiles.projectionRunId, activeProjectionVersions.activeRunId),
        ),
      )
      .limit(1);

    return rows[0]?.profile ?? null;
  }

  async function listEdges(
    opts: { relationType?: EntityEdgeType; fromEntityId?: string; limit?: number } = {},
  ): Promise<ActiveEntityEdge[]> {
    const conds: SQL[] = [
      eq(entityEdges.userId, userId),
      eq(entityEdges.projectionName, projectionName),
      eq(entityEdges.projectionVersion, activeProjectionVersions.activeVersion),
      eq(entityEdges.projectionRunId, activeProjectionVersions.activeRunId),
    ];

    if (opts.relationType) conds.push(eq(entityEdges.relationType, opts.relationType));

    if (opts.fromEntityId) conds.push(eq(entityEdges.fromEntityId, opts.fromEntityId));

    const rows = await db()
      .select()
      .from(entityEdges)
      .innerJoin(
        activeProjectionVersions,
        and(
          eq(activeProjectionVersions.userId, userId),
          eq(activeProjectionVersions.projectionName, projectionName),
        ),
      )
      .where(and(...conds))
      // Strongest first, `id` breaks ties.
      .orderBy(desc(entityEdges.weight), asc(entityEdges.id))
      .limit(clampLimit(opts.limit));

    return rows.map((r) => r.entity_edges);
  }

  async function listCoOccurrence(
    opts: { minWeight?: number; limit?: number } = {},
  ): Promise<ActiveEntityCoOccurrence[]> {
    const conds: SQL[] = [
      eq(entityCoOccurrence.userId, userId),
      eq(entityCoOccurrence.projectionName, projectionName),
      eq(entityCoOccurrence.projectionVersion, activeProjectionVersions.activeVersion),
      eq(entityCoOccurrence.projectionRunId, activeProjectionVersions.activeRunId),
    ];

    if (opts.minWeight !== undefined) conds.push(gte(entityCoOccurrence.weight, opts.minWeight));

    const rows = await db()
      .select()
      .from(entityCoOccurrence)
      .innerJoin(
        activeProjectionVersions,
        and(
          eq(activeProjectionVersions.userId, userId),
          eq(activeProjectionVersions.projectionName, projectionName),
        ),
      )
      .where(and(...conds))
      // Heaviest first, `id` breaks ties.
      .orderBy(desc(entityCoOccurrence.weight), asc(entityCoOccurrence.id))
      .limit(clampLimit(opts.limit));

    return rows.map((r) => r.entity_co_occurrence);
  }

  return {
    getActivePointer,
    listProfiles,
    getProfile,
    getProfileByIdentity,
    listEdges,
    listCoOccurrence,
  };
}
