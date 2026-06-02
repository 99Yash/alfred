import { db } from "@alfred/db";
import {
  entities,
  integrationCredentials,
  memoryChunks,
  user,
  userFacts,
  userPreferences,
} from "@alfred/db/schemas";
import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";

export interface TriageUserContext {
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
    kind: string;
    canonicalName: string;
    aliases: unknown;
    metadata: unknown;
  }>;
  recentMemory: Array<{
    kind: string;
    preview: string;
  }>;
}

const FACT_LIMIT = 30;
const ENTITY_LIMIT = 25;
const MEMORY_LIMIT = 6;
const MEMORY_PREVIEW_CHARS = 900;

export async function readTriageUserContext(userId: string): Promise<TriageUserContext> {
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
        .orderBy(asc(userPreferences.key)),
      db()
        .select({
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
      kind: row.kind,
      canonicalName: row.canonicalName,
      aliases: row.aliases,
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
