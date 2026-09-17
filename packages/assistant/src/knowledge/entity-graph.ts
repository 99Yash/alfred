import { db, type DbTransaction } from "@alfred/db";
import { entities, entityInsertSchema, type Entity, type NewEntity } from "@alfred/db/schemas";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { classifyContactKind } from "./entity-kind-classifier";
import { entityKindSchema, type EntityKind, jsonRecordSchema } from "./types";

const aliasesSchema = z.array(z.string());

/**
 * The two kinds the mail-contact writer owns. The alias match spans both so a
 * re-classified contact is UPDATED in place rather than duplicated (#1108).
 */
const CONTACT_KINDS: readonly EntityKind[] = ["person", "other"];

export const upsertEntityArgsSchema = entityInsertSchema
  .pick({ userId: true, kind: true, canonicalName: true, aliases: true, metadata: true })
  .extend({
    userId: z.string().min(1),
    kind: entityKindSchema,
    canonicalName: z.string().min(1).max(500),
    aliases: z.array(z.string()).optional(),
    metadata: jsonRecordSchema.optional(),
  }) satisfies z.ZodType<
  Pick<NewEntity, "userId" | "kind" | "canonicalName" | "aliases" | "metadata">
>;

export type UpsertEntityArgs = z.infer<typeof upsertEntityArgsSchema>;

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
  metadata: z.infer<typeof jsonRecordSchema>;
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
/**
 * Upsert by `(user_id, kind, canonical_name)`. Aliases merge — never
 * shrink — so re-extracting "Alice Doe" with a new alias preserves prior
 * aliases. Metadata last-writes-wins on conflicting keys.
 *
 * NOTE — keying on `canonical_name` means a `person` whose display name
 * collides with a *different* existing person merges onto that row. For people,
 * whose stable identity is the email, prefer {@link upsertContactByAlias}.
 */
export async function upsertEntity(args: UpsertEntityArgs, tx?: DbTransaction): Promise<EntityRow> {
  const parsed = upsertEntityArgsSchema.parse(args);
  const aliases = parsed.aliases ?? [];
  const metadata = parsed.metadata ?? {};

  // Two-step: try insert; if the unique key collides, merge by hand.
  // Simpler than expressing alias-merge in a single onConflictDoUpdate
  // (jsonb array union with dedup is awkward in Drizzle).
  const run = async (ex: DbTransaction): Promise<EntityRow> => {
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

export interface UpsertContactByAliasArgs {
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
 * Upsert ONE mail contact matched by EMAIL ALIAS rather than canonical name.
 *
 * A contact's stable identity is the email; the display name drifts and
 * collides (two different "John Smith"s). {@link upsertEntity}'s
 * `canonical_name` key would merge a second John onto the first and clobber his
 * correspondence, so the team-graph writer keys on the alias instead. An
 * existing row keeps its established `canonicalName` — only a brand-new contact
 * takes `canonicalNameIfNew`. Aliases union; metadata merges
 * last-writes-wins.
 *
 * The match covers BOTH kinds this writer owns (`person` and `other`) and the
 * update SETS the kind, so a contact the bar re-classifies moves in place on the
 * next capture run instead of minting a duplicate under the new kind. An
 * `organization` row can never be caught by accident: its only alias is a bare
 * domain, and a domain never contains `@`.
 *
 * The kind is DERIVED here, inside the match's transaction, from the canonical
 * name the row carries (or, for a new row, the one it is about to carry) —
 * never from the caller's per-run display name. The caller sees only the
 * documents of its own run, so a run whose headers carried a bare address used
 * to promote a demoted row straight back to `person`. Classifying the stored
 * value makes the writer, the purge script and a dry run agree by construction,
 * and keeps the bar self-healing: change the bar and the next run re-kinds the
 * same row in place (#1108 round 1).
 */
export async function upsertContactByAlias(
  args: UpsertContactByAliasArgs,
  tx?: DbTransaction,
): Promise<EntityRow> {
  const address = args.address.trim().toLowerCase();

  if (!address) {
    throw new Error("[memory.entities] upsertContactByAlias requires a non-empty address");
  }

  const run = async (ex: DbTransaction): Promise<EntityRow> => {
    const [existing] = await ex
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.userId, args.userId),
          inArray(entities.kind, CONTACT_KINDS),
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${entities.aliases}) AS alias
            WHERE lower(alias) = ${address}
          )`,
        ),
      )
      .limit(1);

    // One classification per write, from the value this row stores.
    const kind = entityKindSchema.parse(
      classifyContactKind({
        address,
        canonicalName: existing?.canonicalName ?? args.canonicalNameIfNew,
      }),
    );

    if (!existing) {
      const [row] = await ex
        .insert(entities)
        .values({
          userId: args.userId,
          kind,
          canonicalName: args.canonicalNameIfNew,
          aliases: args.aliases,
          metadata: args.buildMetadata({}),
        })
        .returning();

      if (!row) throw new Error("[memory.entities] upsertContactByAlias insert returned no row");

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
        kind: await resolveKindForUpdate(ex, existing, kind),
        aliases: mergedAliases,
        metadata: mergedMetadata,
        rowVersion: sql`${entities.rowVersion} + 1`,
      })
      .where(eq(entities.id, existing.id))
      .returning();

    if (!row) throw new Error("[memory.entities] upsertContactByAlias update returned no row");

    return rowToEntity(row);
  };

  return tx ? run(tx) : db().transaction(run);
}

/**
 * The kind to write on an EXISTING contact row.
 *
 * `entities` is unique on `(user_id, kind, canonical_name)`, so moving a row to
 * a new kind can collide with a row that already sits at that coordinate. The
 * collision is not the writer's to resolve — a merge would pick a winner and
 * silently drop one contact's correspondence aggregate — so the row keeps the
 * kind it has and the next run tries again once the other row moves. A stale
 * kind is recoverable; a dropped aggregate is not.
 */
async function resolveKindForUpdate(
  ex: DbTransaction,
  existing: Entity,
  kind: EntityKind,
): Promise<string> {
  if (existing.kind === kind) return existing.kind;

  const [clash] = await ex
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.userId, existing.userId),
        eq(entities.kind, kind),
        eq(entities.canonicalName, existing.canonicalName),
      ),
    )
    .limit(1);

  return clash ? existing.kind : kind;
}
