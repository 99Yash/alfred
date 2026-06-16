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
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";

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
const ENTITY_LIMIT = 50;
const RELATION_LIMIT = 80;
const MEMORY_LIMIT = 6;
const MEMORY_PREVIEW_CHARS = 900;

export async function readUserContext(userId: string): Promise<UserContext> {
  const now = new Date();
  const [profileRows, integrationRows, factRows, prefRows, entityRows, memoryRows] =
    await Promise.all([
      db()
        .select({ name: user.name, email: user.email })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1),
      db()
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
        .orderBy(asc(integrationCredentials.provider), asc(integrationCredentials.accountLabel)),
      db()
        .select({
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
        .orderBy(desc(userFacts.updatedAt), desc(userFacts.createdAt))
        .limit(FACT_LIMIT),
      db()
        .select({ key: userPreferences.key, value: userPreferences.value })
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .orderBy(asc(userPreferences.key))
        .limit(PREF_LIMIT),
      db()
        .select({
          id: entities.id,
          kind: entities.kind,
          canonicalName: entities.canonicalName,
          aliases: entities.aliases,
          metadata: entities.metadata,
        })
        .from(entities)
        .where(eq(entities.userId, userId))
        .orderBy(asc(entities.kind), asc(entities.canonicalName))
        .limit(ENTITY_LIMIT),
      db()
        .select({ kind: memoryChunks.kind, content: memoryChunks.content })
        .from(memoryChunks)
        .where(eq(memoryChunks.userId, userId))
        .orderBy(desc(memoryChunks.createdAt))
        .limit(MEMORY_LIMIT),
    ]);

  const entityNameById = new Map(entityRows.map((row) => [row.id, row.canonicalName]));
  const entityIds = entityRows.map((row) => row.id);
  const relationRows =
    entityIds.length === 0
      ? []
      : await db()
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
          .limit(RELATION_LIMIT);

  const profile = profileRows[0] ?? null;
  return {
    profile,
    activeIntegrations: integrationRows.map((row) => ({
      provider: row.provider,
      accountLabel: row.accountLabel,
    })),
    confirmedFacts: factRows.map((row) => ({
      key: row.key,
      value: row.value,
      confidence: row.confidence,
    })),
    preferences: prefRows.map((row) => ({ key: row.key, value: row.value })),
    entities: entityRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      canonicalName: row.canonicalName,
      aliases: row.aliases,
      metadata: row.metadata,
    })),
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
