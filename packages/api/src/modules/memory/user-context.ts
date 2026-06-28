import { db } from "@alfred/db";
import {
  entities,
  entityRelations,
  integrationCredentials,
  memoryChunks,
  user,
  userFacts,
  userPreferences,
} from "@alfred/db/schemas";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";

/** The sections {@link readUserContext} can be narrowed to via `include`. */
export type UserContextSection =
  | "profile"
  | "integrations"
  | "facts"
  | "preferences"
  | "entities"
  | "relationships"
  | "recent_memory";

export interface ReadUserContextOptions {
  /**
   * A specific contact to GUARANTEE is in the result, matched by email alias —
   * pulled in even when it falls outside the significance-ranked top slice, so
   * "what do I know about <person>?" never silently misses them.
   */
  subjectEmail?: string;
  /**
   * Free-text focus. Its tokens are matched (case-insensitive) against entity
   * names/aliases; any hit is guaranteed into the result so a named person or
   * project survives the entity cap.
   */
  query?: string;
  /**
   * Section hints. When given, only these sections are populated (profile is
   * always kept for provenance); omitted sections come back empty. Bounded
   * either way.
   */
  include?: readonly UserContextSection[];
}

export interface UserContext {
  profile: {
    name: string;
    email: string;
  } | null;
  activeIntegrations: Array<{
    provider: string;
    accountLabel: string | null;
  }>;
  confirmedFacts: Array<{
    key: string;
    value: unknown;
    confidence: number;
  }>;
  preferences: Array<{
    key: string;
    value: unknown;
  }>;
  entities: Array<{
    id: string;
    kind: string;
    canonicalName: string;
    aliases: unknown;
    metadata: unknown;
  }>;
  relations: Array<{
    relation: string;
    fromEntityId: string;
    from: string | null;
    toEntityId: string;
    to: string | null;
    metadata: unknown;
  }>;
  recentMemory: Array<{
    kind: string;
    preview: string;
  }>;
}

const FACT_LIMIT = 30;
const PREF_LIMIT = 50;
/**
 * Canonical identity keys that answer "who am I / where do I work?". These are
 * GUARANTEED into the bounded fact slice ahead of the recency/confidence-ranked
 * rest, so a flood of transactional per-email facts can never evict the user's
 * authoritative identity (issue #329). Kept deliberately tight — this is the
 * profile spine, not the broader preference allow-list the #331 purge uses.
 */
const IDENTITY_FACT_KEYS = [
  "current_company",
  "current_work",
  "current_role",
  "bio_summary",
  "first_name",
  "last_name",
  "full_name",
  "user_nickname",
  "current_location",
  "home_city",
  "home_country",
] as const;
const ENTITY_LIMIT = 50;
const RELATION_LIMIT = 80;
const MEMORY_LIMIT = 6;
const MEMORY_PREVIEW_CHARS = 900;
/** Cap on the extra entities a `query`/`subjectEmail` focus may pull in past the ranked slice. */
const FOCUS_MATCH_LIMIT = 10;

type EntityRow = {
  id: string;
  kind: string;
  canonicalName: string;
  aliases: unknown;
  metadata: unknown;
};

const ENTITY_COLUMNS = {
  id: entities.id,
  kind: entities.kind,
  canonicalName: entities.canonicalName,
  aliases: entities.aliases,
  metadata: entities.metadata,
} as const;

/** `metadata.significance.score` as a sortable float — NULL (unscored) sorts last. */
const significanceScore = sql<number>`(${entities.metadata} -> 'significance' ->> 'score')::float8`;

/** Tokenize a free-text query into the alpha-numeric terms worth matching against names. */
function queryTokens(query: string | undefined): string[] {
  if (!query) return [];
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3),
    ),
  ).slice(0, 6);
}

/**
 * Read Alfred's compact, bounded user context. Entities are ranked by the
 * significance scalar (ADR-0057) — NOT alphabetically — so the bounded slice
 * keeps who-matters; a `subjectEmail`/`query` focus is then guaranteed into the
 * result even if it falls below the cap. `include` narrows which sections come
 * back (profile is always kept for provenance).
 */
export async function readUserContext(
  userId: string,
  options: ReadUserContextOptions = {},
): Promise<UserContext> {
  const now = new Date();
  const wants = (section: UserContextSection): boolean =>
    !options.include || options.include.includes(section);

  const subjectEmail = options.subjectEmail?.trim().toLowerCase() || undefined;
  const tokens = queryTokens(options.query);

  const [
    profileRows,
    integrationRows,
    rankedFactRows,
    identityFactRows,
    prefRows,
    rankedEntityRows,
    memoryRows,
  ] = await Promise.all([
    db()
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1),
    wants("integrations")
      ? db()
          .select({
            provider: integrationCredentials.provider,
            accountLabel: integrationCredentials.accountLabel,
          })
          .from(integrationCredentials)
          .where(
            and(
              eq(integrationCredentials.userId, userId),
              eq(integrationCredentials.status, "active"),
            ),
          )
          .orderBy(asc(integrationCredentials.provider), asc(integrationCredentials.accountLabel))
      : Promise.resolve([]),
    wants("facts")
      ? db()
          .select({
            id: userFacts.id,
            key: userFacts.key,
            value: userFacts.value,
            confidence: userFacts.confidence,
            updatedAt: userFacts.updatedAt,
            createdAt: userFacts.createdAt,
          })
          .from(userFacts)
          .where(
            and(
              eq(userFacts.userId, userId),
              eq(userFacts.status, "confirmed"),
              or(isNull(userFacts.validUntil), gt(userFacts.validUntil, now)),
            ),
          )
          // Confidence first, then recency — the authoritative identity facts
          // (source=user, c=1.0) outrank transactional per-email noise (c≈0.95)
          // instead of being buried by it (issue #329).
          .orderBy(desc(userFacts.confidence), desc(userFacts.updatedAt), desc(userFacts.createdAt))
          .limit(FACT_LIMIT)
      : Promise.resolve([]),
    // The canonical identity facts, fetched unconditionally of the cap, so they
    // are guaranteed into the merged slice even when the ranked top-N is full of
    // higher-or-equal-confidence transactional noise (issue #329).
    wants("facts")
      ? db()
          .select({
            id: userFacts.id,
            key: userFacts.key,
            value: userFacts.value,
            confidence: userFacts.confidence,
            updatedAt: userFacts.updatedAt,
            createdAt: userFacts.createdAt,
          })
          .from(userFacts)
          .where(
            and(
              eq(userFacts.userId, userId),
              eq(userFacts.status, "confirmed"),
              or(isNull(userFacts.validUntil), gt(userFacts.validUntil, now)),
              inArray(userFacts.key, [...IDENTITY_FACT_KEYS]),
            ),
          )
          .orderBy(desc(userFacts.confidence), desc(userFacts.updatedAt), desc(userFacts.createdAt))
          .limit(IDENTITY_FACT_KEYS.length)
      : Promise.resolve([]),
    wants("preferences")
      ? db()
          .select({ key: userPreferences.key, value: userPreferences.value })
          .from(userPreferences)
          .where(eq(userPreferences.userId, userId))
          .orderBy(asc(userPreferences.key))
          .limit(PREF_LIMIT)
      : Promise.resolve([]),
    // Entities are needed whenever the caller wants entities OR relationships
    // (relation endpoints resolve to entity names from this set).
    wants("entities") || wants("relationships")
      ? db()
          .select(ENTITY_COLUMNS)
          .from(entities)
          .where(eq(entities.userId, userId))
          .orderBy(
            sql`${significanceScore} desc nulls last`,
            asc(entities.kind),
            asc(entities.canonicalName),
          )
          .limit(ENTITY_LIMIT)
      : Promise.resolve([] as EntityRow[]),
    wants("recent_memory")
      ? db()
          .select({ kind: memoryChunks.kind, content: memoryChunks.content })
          .from(memoryChunks)
          .where(eq(memoryChunks.userId, userId))
          .orderBy(desc(memoryChunks.createdAt))
          .limit(MEMORY_LIMIT)
      : Promise.resolve([]),
  ]);

  // Guarantee the focused contact/query matches survive the ranked cap: fetch
  // them directly and merge ahead of the ranked slice (deduped by id).
  const focusRows =
    (subjectEmail || tokens.length > 0) && (wants("entities") || wants("relationships"))
      ? await fetchFocusEntities(userId, subjectEmail, tokens)
      : [];

  // Focus rows go first so they survive the cap; the ranked slice fills the
  // remainder up to ENTITY_LIMIT, keeping the merged set bounded (focus matches
  // would otherwise push the total to ENTITY_LIMIT + FOCUS_MATCH_LIMIT).
  const mergedEntities: EntityRow[] = [];
  const seenIds = new Set<string>();
  for (const row of [...focusRows, ...rankedEntityRows]) {
    if (mergedEntities.length >= ENTITY_LIMIT) break;
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    mergedEntities.push(row);
  }

  // Identity facts first so they survive the cap; the confidence-ranked rest
  // fills the remainder up to FACT_LIMIT, deduped by id (an identity fact also
  // present in the ranked slice is counted once).
  const mergedFacts: Array<(typeof rankedFactRows)[number]> = [];
  const seenFactIds = new Set<string>();
  for (const row of [...identityFactRows, ...rankedFactRows]) {
    if (mergedFacts.length >= FACT_LIMIT) break;
    if (seenFactIds.has(row.id)) continue;
    seenFactIds.add(row.id);
    mergedFacts.push(row);
  }

  const entityNameById = new Map(mergedEntities.map((row) => [row.id, row.canonicalName]));
  const entityIds = mergedEntities.map((row) => row.id);
  const relationRows =
    wants("relationships") && entityIds.length > 0
      ? await db()
          .select({
            relation: entityRelations.relation,
            fromEntityId: entityRelations.fromEntityId,
            toEntityId: entityRelations.toEntityId,
            metadata: entityRelations.metadata,
          })
          .from(entityRelations)
          .where(
            and(
              eq(entityRelations.userId, userId),
              or(
                inArray(entityRelations.fromEntityId, entityIds),
                inArray(entityRelations.toEntityId, entityIds),
              ),
            ),
          )
          .orderBy(asc(entityRelations.relation), asc(entityRelations.createdAt))
          .limit(RELATION_LIMIT)
      : [];

  const profile = profileRows[0] ?? null;
  return {
    profile,
    activeIntegrations: integrationRows.map((row) => ({
      provider: row.provider,
      accountLabel: row.accountLabel,
    })),
    confirmedFacts: mergedFacts.map((row) => ({
      key: row.key,
      value: row.value,
      confidence: row.confidence,
    })),
    preferences: prefRows.map((row) => ({ key: row.key, value: row.value })),
    entities: wants("entities")
      ? mergedEntities.map((row) => ({
          id: row.id,
          kind: row.kind,
          canonicalName: row.canonicalName,
          aliases: row.aliases,
          metadata: row.metadata,
        }))
      : [],
    relations: relationRows.map((row) => ({
      relation: row.relation,
      fromEntityId: row.fromEntityId,
      from: entityNameById.get(row.fromEntityId) ?? null,
      toEntityId: row.toEntityId,
      to: entityNameById.get(row.toEntityId) ?? null,
      metadata: row.metadata,
    })),
    recentMemory: memoryRows.map((row) => ({
      kind: row.kind,
      preview:
        row.content.length > MEMORY_PREVIEW_CHARS
          ? `${row.content.slice(0, MEMORY_PREVIEW_CHARS - 3)}...`
          : row.content,
    })),
  };
}

/**
 * Entities a `subjectEmail` (exact alias match) or `query` (name/alias ILIKE on
 * any token) points at — fetched separately from the ranked slice so a focused
 * lookup never misses its target. Bounded by {@link FOCUS_MATCH_LIMIT}.
 */
async function fetchFocusEntities(
  userId: string,
  subjectEmail: string | undefined,
  tokens: string[],
): Promise<EntityRow[]> {
  const focusClauses = [];
  if (subjectEmail) {
    focusClauses.push(sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${entities.aliases}) AS alias
      WHERE lower(alias) = ${subjectEmail}
    )`);
  }
  for (const token of tokens) {
    const like = `%${token}%`;
    focusClauses.push(ilike(entities.canonicalName, like));
    focusClauses.push(sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${entities.aliases}) AS alias
      WHERE alias ILIKE ${like}
    )`);
  }
  if (focusClauses.length === 0) return [];

  return db()
    .select(ENTITY_COLUMNS)
    .from(entities)
    .where(and(eq(entities.userId, userId), or(...focusClauses)))
    .orderBy(sql`${significanceScore} desc nulls last`, asc(entities.canonicalName))
    .limit(FOCUS_MATCH_LIMIT);
}
