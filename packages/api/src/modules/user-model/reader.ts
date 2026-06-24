import { db } from "@alfred/db";
import {
  activeProjectionVersions,
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
  type EntityEdgeType,
  type EntityNodeKind,
} from "@alfred/contracts";
import { and, desc, eq, gte, type SQL } from "drizzle-orm";

/**
 * Rows served by the reader are the versioned-table rows pinned to the active
 * run. They are aliased so consumers depend on "active" semantics, not on the
 * raw versioned table — when the SQL `active_*` views land (the projection
 * slice) these become the view row types with no consumer change.
 */
export type ActiveEntityProfile = EntityProfile;
export type ActiveEntityEdge = EntityEdge;
export type ActiveEntityCoOccurrence = EntityCoOccurrence;

/**
 * THE single read surface over the active user-model projection (ADR-0067 D13).
 *
 * The versioned tables (`entity_profiles` / `entity_edges` / `entity_co_occurrence`)
 * hold every projection version simultaneously; reading them raw means
 * remembering to filter to the active `(name, version, run)` every single time,
 * and ONE forgotten filter gives mixed-version reads (the failure D13 rejects).
 * So no consumer (briefing, triage, todos) touches those tables — they go through
 * this reader, which joins `active_projection_versions` and pins rows to the
 * active run (`active_run_id = projection_run_id`, the tightest pin: it asserts
 * the rows came from exactly the run the pointer names, not merely the active
 * version number). Until a user has a completed+activated run, every method
 * returns empty — there is no active projection to read.
 *
 * NOTE (scope): the locked design also calls for SQL `active_*` VIEWS so the
 * pin is physically un-forgettable at the DB. Those land with the projection
 * slice (they read empty until a reducer writes rows, and their column list
 * firms up with the fold); this reader is the access-path enforcement in the
 * meantime and is the import consumers will keep when the views back it.
 */
export function userModelReader(
  userId: string,
  projectionName: string = USER_MODEL_PROJECTION_NAME,
) {
  /** The active pointer for this projection, or null if none is activated yet. */
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

  async function listProfiles(opts: { kind?: EntityNodeKind } = {}): Promise<ActiveEntityProfile[]> {
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
      .where(and(...conds));
    return rows.map((r) => r.entity_profiles);
  }

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

  async function listEdges(
    opts: { relationType?: EntityEdgeType; fromEntityId?: string } = {},
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
      .where(and(...conds));
    return rows.map((r) => r.entity_edges);
  }

  async function listCoOccurrence(
    opts: { minWeight?: number } = {},
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
      .orderBy(desc(entityCoOccurrence.weight));
    return rows.map((r) => r.entity_co_occurrence);
  }

  return { getActivePointer, listProfiles, getProfile, listEdges, listCoOccurrence };
}

export type UserModelReader = ReturnType<typeof userModelReader>;
