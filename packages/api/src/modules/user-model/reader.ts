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
import { and, asc, desc, eq, gte, sql, type SQL } from "drizzle-orm";

/**
 * This is a prompt-assembly / read-model surface (triage, briefing, todos). Every
 * `list*` method is therefore BOUNDED: an unbounded call could dump an entire
 * projection into a model context / memory. A caller may pass a smaller `limit`,
 * but never a larger one than {@link MAX_READ_LIMIT} — and omitting it still
 * caps at {@link DEFAULT_READ_LIMIT} rather than fetching everything. Each list
 * has a deterministic order so the cap is a stable top-N, not an arbitrary slice.
 */
const DEFAULT_READ_LIMIT = 500;
const MAX_READ_LIMIT = 2000;

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_READ_LIMIT;
  return Math.min(Math.floor(limit), MAX_READ_LIMIT);
}

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
      // Most-recently-seen first (nulls last), `entity_id` to break ties — a
      // deterministic top-N so the cap below is stable across calls.
      .orderBy(sql`${entityProfiles.lastSeenAt} desc nulls last`, asc(entityProfiles.entityId))
      .limit(clampLimit(opts.limit));
    return rows.map((r) => r.entity_profiles);
  }

  /**
   * NOTE (scope): this resolves a profile by its RAW stable id. Merge forwarding
   * through `entity_nodes.supersedes_entity_id` (D16) — so `getProfile(loserId)`
   * reaches the survivor after a merge — lands with the projection/merge slice
   * that actually writes that pointer and the survivor's profile row. That slice
   * is where the merge model is decided (does the fold emit a survivor-only
   * profile? is forwarding resolved at fold time or read time, and against the
   * stable layer or the pinned version?), so resolving it here now — against a
   * substrate where no reducer has written a single `supersedes_entity_id` yet —
   * would hard-code that model prematurely and risk forwarding to a survivor with
   * no row in the (possibly older) active version. Until then a loser id reads as
   * absent, which is correct: no merge has happened (no reducer writes
   * `supersedes_entity_id` on this substrate yet, so no loser id can exist).
   *
   * Tracked: forwarding resolution (bounded recursive CTE/helper over the stable
   * layer) + its fail-after-merge regression test land with the fold/merge slice
   * in docs/plans/multi-source-user-model-v1.md, alongside the SQL `active_*`
   * views — that PR is where the merge model is fixed and is the only place this
   * can be implemented without guessing it.
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
      // Strongest edges first, `id` to break ties — a deterministic top-N.
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
      // Heaviest pairs first, `id` to break ties — a deterministic top-N.
      .orderBy(desc(entityCoOccurrence.weight), asc(entityCoOccurrence.id))
      .limit(clampLimit(opts.limit));
    return rows.map((r) => r.entity_co_occurrence);
  }

  return { getActivePointer, listProfiles, getProfile, listEdges, listCoOccurrence };
}

export type UserModelReader = ReturnType<typeof userModelReader>;
