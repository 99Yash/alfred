import { db } from "@alfred/db";
import {
  entities,
  type Entity,
  entityRelations,
  integrationCredentials,
  memoryChunks,
  user,
  type UserFact,
  userFacts,
  userPreferences,
} from "@alfred/db/schemas";
import { memorySourceSchema, type MemorySource } from "@alfred/contracts";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { USER_FACING_MEMORY_CHUNK_KINDS } from "./chunks";

/** Sections `include` can select. */
export type UserContextSection =
  | "profile"
  | "integrations"
  | "facts"
  | "preferences"
  | "entities"
  | "relationships"
  | "recent_memory";

export interface ReadUserContextOptions {
  /** A contact always included, matched by email alias, even below the ranked cap. */
  subjectEmail?: string | undefined;
  /** Free text. Any entity whose name or alias matches a token is always included. */
  query?: string | undefined;
  /** Only these sections are filled; profile is always kept. Bounded either way. */
  include?: readonly UserContextSection[] | undefined;
}

export interface UserContext {
  profile: {
    name: string;
    email: string;
    currentCompany: string | null;
    currentRole: string | null;
    currentWork: string | null;
    currentLocation: string | null;
    bioSummary: string | null;
    identityFacts: Array<{
      key: string;
      value: string;
      confidence: number;
    }>;
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
 * Identity keys always in the fact slice, so per-email facts cannot evict who
 * the user is (#329). Keep this list tight.
 */
const IDENTITY_FACT_KEYS = [
  "employer",
  "work_summary",
  "job_title",
  "bio_summary",
  "first_name",
  "last_name",
  "full_name",
  "user_nickname",
  "location",
] as const;

type IdentityFactKey = (typeof IDENTITY_FACT_KEYS)[number];

const PROFILE_IDENTITY_FACT_KEYS = [
  "employer",
  "work_summary",
  "job_title",
  "bio_summary",
  "location",
] as const satisfies readonly IdentityFactKey[];

const profileIdentityFactKeys = new Set<string>(PROFILE_IDENTITY_FACT_KEYS);

const ENTITY_LIMIT = 50;

const RELATION_LIMIT = 80;

const MEMORY_LIMIT = 6;

const MEMORY_PREVIEW_CHARS = 900;

/** Max extra entities a `query`/`subjectEmail` focus may add. */
const FOCUS_MATCH_LIMIT = 10;

type EntityRow = Pick<Entity, "id" | "kind" | "canonicalName" | "aliases" | "metadata">;

type FactContextRow = Pick<
  UserFact,
  "id" | "key" | "value" | "confidence" | "source" | "updatedAt" | "createdAt"
>;

type StringFactContextRow = FactContextRow & { value: string };

const ENTITY_COLUMNS = {
  id: entities.id,
  kind: entities.kind,
  canonicalName: entities.canonicalName,
  aliases: entities.aliases,
  metadata: entities.metadata,
} as const;

const FACT_COLUMNS = {
  id: userFacts.id,
  key: userFacts.key,
  value: userFacts.value,
  confidence: userFacts.confidence,
  source: userFacts.source,
  updatedAt: userFacts.updatedAt,
  createdAt: userFacts.createdAt,
} as const;

const identityKeyRank = new Map<IdentityFactKey, number>(
  IDENTITY_FACT_KEYS.map((key, index) => [key, index]),
);

/** `metadata.significance.score` as a float. Unscored sorts last. */
const significanceScore = sql<number>`(${entities.metadata} -> 'significance' ->> 'score')::float8`;

/** Alphanumeric query terms worth matching against names. */
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

function isIdentityFactKey(key: string): key is IdentityFactKey {
  // SAFETY: the cast only types `.has`'s argument; the map's keys are exactly the IdentityFactKey union.
  return identityKeyRank.has(key as IdentityFactKey);
}

function identityValue(rows: FactContextRow[], key: IdentityFactKey): unknown | null {
  return rows.find((row) => row.key === key)?.value ?? null;
}

function stringIdentityValue(rows: FactContextRow[], key: IdentityFactKey): string | null {
  const value = identityValue(rows, key);

  return typeof value === "string" && value.trim() ? value : null;
}

function sourceRank(source: MemorySource): number {
  switch (source.kind) {
    case "user":
      return 0;
    case "cold_start":
      return 1;
    case "agent":
      return 2;
    case "document":
    case "chunk":
    case "tool_call":
      return 3;
    default: {
      const _exhaustive: never = source.kind;

      return _exhaustive;
    }
  }
}

function timestampMs(value: Date | null): number {
  return value?.getTime() ?? Number.NEGATIVE_INFINITY;
}

function parseSource(row: Pick<FactContextRow, "id" | "source">): MemorySource {
  const parsed = memorySourceSchema.safeParse(row.source);

  if (parsed.success) return parsed.data;
  console.warn(
    `[memory.user-context] ignoring invalid source for user_facts:${row.id}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
  );

  return { kind: "document" };
}

function sortIdentityFacts<T extends FactContextRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const rankA = isIdentityFactKey(a.key) ? identityKeyRank.get(a.key)! : Number.MAX_SAFE_INTEGER;
    const rankB = isIdentityFactKey(b.key) ? identityKeyRank.get(b.key)! : Number.MAX_SAFE_INTEGER;

    return rankA - rankB;
  });
}

function profileIdentityFacts(rows: FactContextRow[]): StringFactContextRow[] {
  const candidates = rows.filter((row): row is StringFactContextRow => {
    if (!profileIdentityFactKeys.has(row.key)) return false;

    if (typeof row.value !== "string" || !row.value.trim()) return false;
    const source = parseSource(row);

    return (
      source.kind === "user" ||
      source.kind === "cold_start" ||
      source.kind === "agent" ||
      (source.kind === "document" && source.meta?.documentAuthoredByUser === true)
    );
  });

  return bestIdentityFacts(candidates);
}

function compareIdentityCandidates(a: FactContextRow, b: FactContextRow): number {
  const sourceDiff = sourceRank(parseSource(a)) - sourceRank(parseSource(b));

  if (sourceDiff !== 0) return sourceDiff;

  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const updatedDiff = timestampMs(b.updatedAt) - timestampMs(a.updatedAt);

  if (updatedDiff !== 0) return updatedDiff;
  const createdDiff = timestampMs(b.createdAt) - timestampMs(a.createdAt);

  if (createdDiff !== 0) return createdDiff;

  return b.id.localeCompare(a.id);
}

function bestIdentityFacts<T extends FactContextRow>(rows: T[]): T[] {
  const byKey = new Map<IdentityFactKey, T>();

  for (const row of rows) {
    if (!isIdentityFactKey(row.key)) continue;
    const existing = byKey.get(row.key);

    if (!existing || compareIdentityCandidates(row, existing) < 0) byKey.set(row.key, row);
  }

  return sortIdentityFacts([...byKey.values()]);
}

/**
 * Alfred's compact, bounded user context. Entities rank by significance
 * (ADR-0057), and a `subjectEmail` or `query` focus is always included.
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
    identityFactRowsRaw,
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
            ...FACT_COLUMNS,
          })
          .from(userFacts)
          .where(
            and(
              eq(userFacts.userId, userId),
              eq(userFacts.status, "confirmed"),
              or(isNull(userFacts.validUntil), gt(userFacts.validUntil, now)),
            ),
          )
          // Confidence first: user identity facts (1.0) outrank per-email noise (~0.95) (#329).
          .orderBy(desc(userFacts.confidence), desc(userFacts.updatedAt), desc(userFacts.createdAt))
          .limit(FACT_LIMIT)
      : Promise.resolve([]),
    // Not gated on `facts`: `profile` must hold identity even when only profile is requested (#329).
    // Selection is in code, so source can outrank recency.
    db()
      .select(FACT_COLUMNS)
      .from(userFacts)
      .where(
        and(
          eq(userFacts.userId, userId),
          eq(userFacts.status, "confirmed"),
          or(isNull(userFacts.validUntil), gt(userFacts.validUntil, now)),
          inArray(userFacts.key, [...IDENTITY_FACT_KEYS]),
        ),
      )
      .orderBy(userFacts.key, desc(userFacts.confidence), desc(userFacts.updatedAt)),
    wants("preferences")
      ? db()
          .select({ key: userPreferences.key, value: userPreferences.value })
          .from(userPreferences)
          .where(eq(userPreferences.userId, userId))
          .orderBy(asc(userPreferences.key))
          .limit(PREF_LIMIT)
      : Promise.resolve([]),
    // Relationships need the entities to resolve endpoint names.
    // SAFETY: the skipped tier contributes no rows; EntityRow[] is the shared element type of these Promise.all branches.
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
          .where(
            and(
              eq(memoryChunks.userId, userId),
              // `extraction_run` is bookkeeping, not user memory (#1052).
              inArray(memoryChunks.kind, [...USER_FACING_MEMORY_CHUNK_KINDS]),
            ),
          )
          .orderBy(desc(memoryChunks.createdAt))
          .limit(MEMORY_LIMIT)
      : Promise.resolve([]),
  ]);

  const identityFactRows = bestIdentityFacts(identityFactRowsRaw);
  const profileIdentityRows = profileIdentityFacts(identityFactRowsRaw);

  // Fetch focus matches directly, so they survive the ranked cap.
  const focusRows =
    (subjectEmail || tokens.length > 0) && (wants("entities") || wants("relationships"))
      ? await fetchFocusEntities(userId, subjectEmail, tokens)
      : [];

  // Focus rows first; the ranked slice fills up to ENTITY_LIMIT, so the total stays bounded.
  const mergedEntities: EntityRow[] = [];
  const seenIds = new Set<string>();

  for (const row of [...focusRows, ...rankedEntityRows]) {
    if (mergedEntities.length >= ENTITY_LIMIT) break;

    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    mergedEntities.push(row);
  }

  // Identity facts first; the ranked rest fills up to FACT_LIMIT, deduped by id.
  const mergedFacts: FactContextRow[] = [];
  const seenFactIds = new Set<string>();

  if (wants("facts")) {
    for (const row of [...identityFactRows, ...rankedFactRows]) {
      if (mergedFacts.length >= FACT_LIMIT) break;

      if (seenFactIds.has(row.id)) continue;
      seenFactIds.add(row.id);
      mergedFacts.push(row);
    }
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

  const profile = profileRows[0]
    ? {
        ...profileRows[0],
        // DTO names stay stable; they map from canonical keys (#330).
        currentCompany: stringIdentityValue(profileIdentityRows, "employer"),
        currentRole: stringIdentityValue(profileIdentityRows, "job_title"),
        currentWork: stringIdentityValue(profileIdentityRows, "work_summary"),
        currentLocation: stringIdentityValue(profileIdentityRows, "location"),
        bioSummary: stringIdentityValue(profileIdentityRows, "bio_summary"),
        identityFacts: profileIdentityRows.map((row) => ({
          key: row.key,
          value: row.value,
          confidence: row.confidence,
        })),
      }
    : null;

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

/** Entities matched by `subjectEmail` (exact alias) or `query` (ILIKE per token). Bounded by {@link FOCUS_MATCH_LIMIT}. */
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
