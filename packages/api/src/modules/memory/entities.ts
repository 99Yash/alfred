import { db } from "@alfred/db";
import { entities, entityRelations } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { entityKindSchema, type EntityKind, jsonRecordSchema } from "./types";

const aliasesSchema = z.array(z.string());

export const upsertEntityArgsSchema = z.object({
  userId: z.string().min(1),
  kind: z.enum(["person", "organization", "project", "product", "location", "other"]),
  canonicalName: z.string().min(1).max(500),
  aliases: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpsertEntityArgs = z.infer<typeof upsertEntityArgsSchema>;

export const linkEntitiesArgsSchema = z.object({
  userId: z.string().min(1),
  fromEntityId: z.string().min(1),
  toEntityId: z.string().min(1),
  /** `manager_of`, `reports_to`, `works_at`, `colleague_of`, `invested_in`, … */
  relation: z.string().min(1).max(80),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type LinkEntitiesArgs = z.infer<typeof linkEntitiesArgsSchema>;

export interface EntityRow {
  id: string;
  userId: string;
  kind: EntityKind;
  canonicalName: string;
  aliases: string[];
  metadata: Record<string, unknown>;
  rowVersion: number;
}

function rowToEntity(r: typeof entities.$inferSelect): EntityRow {
  return {
    id: r.id,
    userId: r.userId,
    kind: entityKindSchema.parse(r.kind),
    canonicalName: r.canonicalName,
    aliases: aliasesSchema.parse(r.aliases ?? []),
    metadata: jsonRecordSchema.parse(r.metadata),
    rowVersion: r.rowVersion,
  };
}

/**
 * Upsert by `(user_id, kind, canonical_name)`. Aliases merge — never
 * shrink — so re-extracting "Alice Doe" with a new alias preserves prior
 * aliases. Metadata last-writes-wins on conflicting keys.
 */
export async function upsertEntity(args: UpsertEntityArgs): Promise<EntityRow> {
  const parsed = upsertEntityArgsSchema.parse(args);
  const aliases = parsed.aliases ?? [];
  const metadata = parsed.metadata ?? {};

  // Two-step: try insert; if the unique key collides, merge by hand.
  // Simpler than expressing alias-merge in a single onConflictDoUpdate
  // (jsonb array union with dedup is awkward in Drizzle).
  return await db().transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.userId, parsed.userId),
          eq(entities.kind, parsed.kind),
          eq(entities.canonicalName, parsed.canonicalName),
        ),
      )
      .limit(1);

    if (!existing) {
      const [row] = await tx
        .insert(entities)
        .values({
          userId: parsed.userId,
          kind: parsed.kind,
          canonicalName: parsed.canonicalName,
          aliases,
          metadata,
        })
        .returning();
      if (!row) throw new Error("[memory.entities] upsertEntity insert returned no row");
      return rowToEntity(row);
    }

    const mergedAliases = Array.from(
      new Set([...aliasesSchema.parse(existing.aliases), ...aliases]),
    );
    const mergedMetadata = { ...jsonRecordSchema.parse(existing.metadata), ...metadata };
    const [row] = await tx
      .update(entities)
      .set({
        aliases: mergedAliases,
        metadata: mergedMetadata,
        rowVersion: sql`${entities.rowVersion} + 1`,
      })
      .where(eq(entities.id, existing.id))
      .returning();
    if (!row) throw new Error("[memory.entities] upsertEntity update returned no row");
    return rowToEntity(row);
  });
}

/** Add a relation. Idempotent — duplicate `(from, to, relation)` is a no-op. */
export async function linkEntities(args: LinkEntitiesArgs): Promise<void> {
  const parsed = linkEntitiesArgsSchema.parse(args);
  await db()
    .insert(entityRelations)
    .values({
      userId: parsed.userId,
      fromEntityId: parsed.fromEntityId,
      toEntityId: parsed.toEntityId,
      relation: parsed.relation,
      metadata: parsed.metadata ?? {},
    })
    .onConflictDoNothing();
}

/** Look up by canonical name. */
export async function findEntity(
  userId: string,
  kind: EntityKind,
  canonicalName: string,
): Promise<EntityRow | null> {
  const [row] = await db()
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.kind, kind),
        eq(entities.canonicalName, canonicalName),
      ),
    )
    .limit(1);
  return row ? rowToEntity(row) : null;
}

export interface RelatedEntity {
  entity: EntityRow;
  relation: string;
  /** Direction of the edge from the input entity's perspective. */
  direction: "out" | "in";
}

/**
 * One-hop neighbors. Recursive multi-hop traversal can be a separate
 * helper later (recursive CTE) — single-hop is enough for the v1 use
 * cases (audience-bucket assignment, "who is alice's manager").
 */
export async function getRelatedEntities(
  userId: string,
  entityId: string,
): Promise<RelatedEntity[]> {
  const outgoing = await db()
    .select({ rel: entityRelations, ent: entities })
    .from(entityRelations)
    .innerJoin(entities, eq(entityRelations.toEntityId, entities.id))
    .where(and(eq(entityRelations.userId, userId), eq(entityRelations.fromEntityId, entityId)));

  const incoming = await db()
    .select({ rel: entityRelations, ent: entities })
    .from(entityRelations)
    .innerJoin(entities, eq(entityRelations.fromEntityId, entities.id))
    .where(and(eq(entityRelations.userId, userId), eq(entityRelations.toEntityId, entityId)));

  return [
    ...outgoing.map((r) => ({
      entity: rowToEntity(r.ent),
      relation: r.rel.relation,
      direction: "out" as const,
    })),
    ...incoming.map((r) => ({
      entity: rowToEntity(r.ent),
      relation: r.rel.relation,
      direction: "in" as const,
    })),
  ];
}
