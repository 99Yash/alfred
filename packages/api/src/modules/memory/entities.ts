import { db, type DbTransaction } from "@alfred/db";
import { entities, entityRelations, type Entity } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { entityKindSchema, type EntityKind, jsonRecordSchema } from "./types";

const aliasesSchema = z.array(z.string());

export const upsertEntityArgsSchema = z.object({
  userId: z.string().min(1),
  kind: entityKindSchema,
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

/**
 * DB row with the jsonb/enum columns narrowed to their parsed shapes. Other
 * columns track `Entity` ($inferSelect); the lifecycle dates are dropped
 * deliberately — `rowToEntity` doesn't surface them. Only `kind`/`aliases`/
 * `metadata`, which are zod-parsed, are restated.
 */
export type EntityRow = Omit<
  Entity,
  "kind" | "aliases" | "metadata" | "createdAt" | "updatedAt"
> & {
  kind: EntityKind;
  aliases: string[];
  metadata: Record<string, unknown>;
};

function rowToEntity(r: Entity): EntityRow {
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
 * A Drizzle transaction handle — the value `db().transaction(cb)` hands its
 * callback. Every write helper below optionally takes one so several writes can
 * commit atomically in a caller's transaction (mirrors `publishEvent`'s `tx?`).
 * The team-graph capture relies on this: its correspondence increments and the
 * `captured_into_graph_at` stamp must land together (ADR-0059 amendment
 * 2026-06-16), so a failed apply rolls back the marker too and the next run
 * retries cleanly. Omit it and each helper opens its own transaction as before.
 */
export type DbExecutor = DbTransaction;

/**
 * Upsert by `(user_id, kind, canonical_name)`. Aliases merge — never
 * shrink — so re-extracting "Alice Doe" with a new alias preserves prior
 * aliases. Metadata last-writes-wins on conflicting keys.
 *
 * NOTE — keying on `canonical_name` means a `person` whose display name
 * collides with a *different* existing person merges onto that row. For people,
 * whose stable identity is the email, prefer {@link upsertPersonByAlias}.
 */
export async function upsertEntity(args: UpsertEntityArgs, tx?: DbExecutor): Promise<EntityRow> {
  const parsed = upsertEntityArgsSchema.parse(args);
  const aliases = parsed.aliases ?? [];
  const metadata = parsed.metadata ?? {};

  // Two-step: try insert; if the unique key collides, merge by hand.
  // Simpler than expressing alias-merge in a single onConflictDoUpdate
  // (jsonb array union with dedup is awkward in Drizzle).
  const run = async (ex: DbExecutor): Promise<EntityRow> => {
    const [existing] = await ex
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
      const [row] = await ex
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
    const [row] = await ex
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
  };

  return tx ? run(tx) : db().transaction(run);
}

export interface UpsertPersonByAliasArgs {
  userId: string;
  /** The email alias the row is matched on (lowercased before matching). */
  address: string;
  /** Aliases to union onto the row — typically just `[address]`. */
  aliases: string[];
  /** Canonical name used ONLY when inserting a new row; an existing row keeps its own. */
  canonicalNameIfNew: string;
  /**
   * Build the metadata bag to write from the row's PRIOR metadata (`{}` for a
   * new row). Runs inside the match's transaction, so the prior it sees is
   * consistent with the write. Returned keys merge last-writes-wins over the
   * prior bag, so untouched keys (e.g. `significance`) survive.
   */
  buildMetadata: (priorMetadata: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Upsert a `person` matched by EMAIL ALIAS rather than canonical name.
 *
 * A person's stable identity is the email; the display name drifts and collides
 * (two different "John Smith"s). {@link upsertEntity}'s `canonical_name` key
 * would merge a second John onto the first and clobber his correspondence, so
 * the team-graph writer keys on the alias instead. An existing row keeps its
 * established `canonicalName` — only a brand-new contact takes
 * `canonicalNameIfNew`. Aliases union; metadata merges last-writes-wins.
 */
export async function upsertPersonByAlias(
  args: UpsertPersonByAliasArgs,
  tx?: DbExecutor,
): Promise<EntityRow> {
  const address = args.address.trim().toLowerCase();
  if (!address) {
    throw new Error("[memory.entities] upsertPersonByAlias requires a non-empty address");
  }

  const run = async (ex: DbExecutor): Promise<EntityRow> => {
    const [existing] = await ex
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.userId, args.userId),
          eq(entities.kind, "person"),
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${entities.aliases}) AS alias
            WHERE lower(alias) = ${address}
          )`,
        ),
      )
      .limit(1);

    if (!existing) {
      const [row] = await ex
        .insert(entities)
        .values({
          userId: args.userId,
          kind: "person",
          canonicalName: args.canonicalNameIfNew,
          aliases: args.aliases,
          metadata: args.buildMetadata({}),
        })
        .returning();
      if (!row) throw new Error("[memory.entities] upsertPersonByAlias insert returned no row");
      return rowToEntity(row);
    }

    const priorMeta = jsonRecordSchema.parse(existing.metadata);
    const mergedAliases = Array.from(
      new Set([...aliasesSchema.parse(existing.aliases), ...args.aliases]),
    );
    const mergedMetadata = { ...priorMeta, ...args.buildMetadata(priorMeta) };
    const [row] = await ex
      .update(entities)
      .set({
        aliases: mergedAliases,
        metadata: mergedMetadata,
        rowVersion: sql`${entities.rowVersion} + 1`,
      })
      .where(eq(entities.id, existing.id))
      .returning();
    if (!row) throw new Error("[memory.entities] upsertPersonByAlias update returned no row");
    return rowToEntity(row);
  };

  return tx ? run(tx) : db().transaction(run);
}

/** Add a relation. Idempotent — duplicate `(from, to, relation)` is a no-op. */
export async function linkEntities(args: LinkEntitiesArgs, tx?: DbExecutor): Promise<void> {
  const parsed = linkEntitiesArgsSchema.parse(args);
  await (tx ?? db())
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
