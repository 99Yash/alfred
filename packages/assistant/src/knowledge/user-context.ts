import { db } from "@alfred/db";
import { integrationCredentials, memoryChunks, type UserFact, userFacts } from "@alfred/db/schemas";
import {
  assertNever,
  isNonBlankString,
  memorySourceSchema,
  type CorrespondentHistory,
  type IanaTimezone,
  type MemorySource,
} from "@alfred/contracts";
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
  settings,
  userIdentity,
  type UserIdentity,
  type UserSettings,
} from "@alfred/assistant/settings";
import { USER_FACING_MEMORY_CHUNK_KINDS } from "./chunks";
import { readCorrespondents } from "./correspondents";
import { isUserStatedSource, readUserLocation, statedLocationLabel } from "./location";
import { logger } from "@alfred/logging";

/** Sections `include` can select. */
type UserContextSection =
  | "profile"
  | "integrations"
  | "facts"
  | "preferences"
  | "people"
  | "recent_memory";

export interface ReadUserContextOptions {
  /** The exact address for the people section (ADR-0127), also for a first mail. */
  subjectEmail?: string | undefined;
  /** Words matched against correspondent names and addresses (ADR-0127), until name links. */
  query?: string | undefined;
  /** Only these sections are filled; profile is always kept. Bounded either way. */
  include?: readonly UserContextSection[] | undefined;
  /** The caller's bind for this user. Pass it so `preferences` reuses its load; else a new bind. */
  settings?: UserSettings | undefined;
}

export interface UserContext {
  profile: {
    name: UserIdentity["name"];
    email: UserIdentity["primaryEmail"];
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
  };
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
  /** Mail history for exact addresses, query matches, or the most recently written to. */
  people: CorrespondentHistory[];
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

/** No `location`: `currentLocation` comes from the one place reader (ADR-0117 decision 3). */
const PROFILE_IDENTITY_FACT_KEYS = [
  "employer",
  "work_summary",
  "job_title",
  "bio_summary",
] as const satisfies readonly IdentityFactKey[];

const profileIdentityFactKeys = new Set<string>(PROFILE_IDENTITY_FACT_KEYS);

const MEMORY_LIMIT = 6;

const MEMORY_PREVIEW_CHARS = 900;

type FactContextRow = Pick<
  UserFact,
  "id" | "key" | "value" | "confidence" | "source" | "updatedAt" | "createdAt"
>;

type StringFactContextRow = FactContextRow & { value: string };

const FACT_COLUMNS = {
  id: userFacts.id,
  key: userFacts.key,
  value: userFacts.value,
  confidence: userFacts.confidence,
  source: userFacts.source,
  updatedAt: userFacts.updatedAt,
  createdAt: userFacts.createdAt,
} as const;

/** Keyed by plain `string`, so a non-identity key reads `undefined` and sorts last. */
const identityKeyRank: ReadonlyMap<string, number> = new Map<IdentityFactKey, number>(
  IDENTITY_FACT_KEYS.map((key, index) => [key, index]),
);

function isIdentityFactKey(key: string): key is IdentityFactKey {
  return identityKeyRank.has(key);
}

function stringIdentityValue(rows: FactContextRow[], key: IdentityFactKey): string | null {
  const value = rows.find((row) => row.key === key)?.value;

  return isNonBlankString(value) ? value : null;
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
    default:
      return assertNever(source.kind, "memory source kind");
  }
}

function timestampMs(value: Date | null): number {
  return value?.getTime() ?? Number.NEGATIVE_INFINITY;
}

function parseSource(row: Pick<FactContextRow, "id" | "source">): MemorySource {
  const parsed = memorySourceSchema.safeParse(row.source);

  if (parsed.success) return parsed.data;
  logger.warn(
    `[memory.user-context] ignoring invalid source for user_facts:${row.id}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
  );

  return { kind: "document" };
}

function sortIdentityFacts<T extends FactContextRow>(rows: T[]): T[] {
  return rows.toSorted((a, b) => {
    const rankA = identityKeyRank.get(a.key) ?? Number.MAX_SAFE_INTEGER;
    const rankB = identityKeyRank.get(b.key) ?? Number.MAX_SAFE_INTEGER;

    return rankA - rankB;
  });
}

function profileIdentityFacts(rows: FactContextRow[]): StringFactContextRow[] {
  const candidates = rows.filter((row): row is StringFactContextRow => {
    if (!profileIdentityFactKeys.has(row.key)) return false;

    if (typeof row.value !== "string" || !row.value.trim()) return false;

    return isUserStatedSource(parseSource(row));
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
 * Alfred's bounded user context, with mail history in the people section (ADR-0127).
 * One row that the user-context read delivered, for the evidence record of a script read
 * (ADR-0124 amendment 2026-11-18). `item` is the row as the context gives it.
 */
export interface UserContextItem {
  store: string;
  id: string;
  depth: "hit" | "body";
  version?: string;
  item: unknown;
}

export async function readUserContext(
  userId: string,
  options: ReadUserContextOptions = {},
): Promise<UserContext> {
  return (await readUserContextItems(userId, options)).context;
}

/** {@link readUserContext}, with the id of each row that it delivered. */
export async function readUserContextItems(
  userId: string,
  options: ReadUserContextOptions = {},
): Promise<{ context: UserContext; items: UserContextItem[] }> {
  const now = new Date();

  const wants = (section: UserContextSection): boolean =>
    !options.include || options.include.includes(section);

  const subjectEmail = options.subjectEmail?.trim().toLowerCase() || undefined;
  const userSettings = options.settings ?? settings({ userId });

  const [
    identity,
    integrationRows,
    rankedFactRows,
    identityFactRowsRaw,
    prefRows,
    people,
    memoryRows,
    currentLocation,
  ] = await Promise.all([
    userIdentity({ userId }),
    wants("integrations")
      ? db()
          .select({
            id: integrationCredentials.id,
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
    // Ordered by key; the first PREF_LIMIT rows, as before.
    wants("preferences")
      ? userSettings.all().then((rows) => rows.slice(0, PREF_LIMIT))
      : Promise.resolve([]),
    wants("people")
      ? readCorrespondents(
          userId,
          subjectEmail
            ? [subjectEmail]
            : options.query
              ? { query: options.query }
              : { recent: true },
        )
      : Promise.resolve([]),
    wants("recent_memory")
      ? db()
          .select({ id: memoryChunks.id, kind: memoryChunks.kind, content: memoryChunks.content })
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
    readCurrentLocation(userId, userSettings),
  ]);

  const identityFactRows = bestIdentityFacts(identityFactRowsRaw);
  const profileIdentityRows = profileIdentityFacts(identityFactRowsRaw);

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

  const profile = {
    name: identity.name,
    email: identity.primaryEmail,
    // DTO names stay stable; they map from canonical keys (#330).
    currentCompany: stringIdentityValue(profileIdentityRows, "employer"),
    currentRole: stringIdentityValue(profileIdentityRows, "job_title"),
    currentWork: stringIdentityValue(profileIdentityRows, "work_summary"),
    currentLocation,
    bioSummary: stringIdentityValue(profileIdentityRows, "bio_summary"),
    identityFacts: profileIdentityRows.map((row) => ({
      key: row.key,
      value: row.value,
      confidence: row.confidence,
    })),
  };

  const activeIntegrations = integrationRows.map((row) => ({
    provider: row.provider,
    accountLabel: row.accountLabel,
  }));

  const confirmedFacts = mergedFacts.map((row) => ({
    key: row.key,
    value: row.value,
    confidence: row.confidence,
  }));

  const preferences = prefRows.map((row) => ({ key: row.key, value: row.value }));

  const recentMemory = memoryRows.map((row) => ({
    kind: row.kind,
    preview:
      row.content.length > MEMORY_PREVIEW_CHARS
        ? `${row.content.slice(0, MEMORY_PREVIEW_CHARS - 3)}...`
        : row.content,
  }));

  // Each delivered row by its id, with the same value the context gives.
  const { identityFacts: _identityFacts, ...profileFields } = profile;

  const items: UserContextItem[] = [
    { store: "user", id: userId, depth: "body", item: profileFields },
    ...profileIdentityRows.map(
      (row, i): UserContextItem => ({
        store: "user_fact",
        id: row.id,
        depth: "body",
        ...(row.updatedAt ? { version: row.updatedAt.toISOString() } : {}),
        item: profile.identityFacts[i],
      }),
    ),
    ...integrationRows.map(
      (row, i): UserContextItem => ({
        store: "integration_credential",
        id: row.id,
        depth: "body",
        item: activeIntegrations[i],
      }),
    ),
    ...mergedFacts.map(
      (row, i): UserContextItem => ({
        store: "user_fact",
        id: row.id,
        depth: "body",
        ...(row.updatedAt ? { version: row.updatedAt.toISOString() } : {}),
        item: confirmedFacts[i],
      }),
    ),
    ...preferences.map(
      (row): UserContextItem => ({ store: "user_setting", id: row.key, depth: "body", item: row }),
    ),
    ...people.map(
      (row): UserContextItem => ({
        store: "correspondent",
        id: row.address,
        depth: "body",
        item: row,
      }),
    ),
    ...memoryRows.map(
      (row, i): UserContextItem => ({
        store: "memory_chunk",
        id: row.id,
        depth: row.content.length > MEMORY_PREVIEW_CHARS ? "hit" : "body",
        item: recentMemory[i],
      }),
    ),
  ];

  return {
    context: {
      profile,
      activeIntegrations,
      confirmedFacts,
      preferences,
      people,
      recentMemory,
    },
    items,
  };
}

/**
 * The user's place through the one reader, so chat and the briefing give one answer. Chat needs a
 * name, not coordinates. The reader does not throw, and a fault of the zone read is `null`, so a
 * chat turn never fails on its place.
 */
async function readCurrentLocation(
  userId: string,
  userSettings: UserSettings,
): Promise<string | null> {
  let timezone: IanaTimezone;

  try {
    timezone = await userSettings.timezone();
  } catch (err) {
    logger.warn(
      { err, userId },
      "[memory.user-context] time zone read failed; no current location",
    );

    return null;
  }

  return statedLocationLabel(await readUserLocation({ userId, settings: userSettings, timezone }));
}
