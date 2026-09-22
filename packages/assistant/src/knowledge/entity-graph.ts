import { db, type DbTransaction } from "@alfred/db";
import { entities, entityInsertSchema, type Entity, type NewEntity } from "@alfred/db/schemas";
import {
  canonicalizeIdentityValue,
  isNonEmptyString,
  jsonRecordSchema,
  parseEmailAddress,
  type JsonObject,
} from "@alfred/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { classifyContactKind } from "./entity-kind-classifier";
import { parsePersonEntityMetadata } from "./entity-metadata";

/**
 * `entities.kind` values — the 6-member ADR-0012 vocabulary. The text column is
 * validated at this app-boundary store; the union derives from the tuple so a
 * new kind cannot drift from its parse.
 */
export const ENTITY_KINDS = [
  "person",
  "organization",
  "project",
  "product",
  "location",
  "other",
] as const;

export const entityKindSchema = z.enum(ENTITY_KINDS);

export type EntityKind = (typeof ENTITY_KINDS)[number];

const aliasesSchema = z.array(z.string());

/**
 * The two kinds the mail-contact writer owns. The alias match spans both so a
 * re-classified contact is UPDATED in place rather than duplicated (#1108).
 *
 * The SINGLE definition: the kind union derives from this tuple, never
 * restated, so narrowing the writer's match fails the classifier's `other`
 * arms at compile time instead of orphaning a stored row.
 */
const CONTACT_KINDS = ["person", "other"] as const satisfies readonly EntityKind[];

export type ContactKind = (typeof CONTACT_KINDS)[number];

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
  /** The email alias the row is matched on (normalized with `canonicalizeIdentityValue` before matching). */
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
  buildMetadata: (priorMetadata: JsonObject) => JsonObject;
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
  const address = canonicalizeIdentityValue("email", args.address);

  if (!address) {
    throw new Error("[memory.entities] upsertContactByAlias requires a non-empty address");
  }

  const run = async (ex: DbTransaction): Promise<EntityRow> => {
    const [existing] = await ex
      .select()
      .from(entities)
      .where(storedContactMatch(args.userId, [address]))
      .limit(1);

    // One classification per write, from the value this row stores. Already a
    // ContactKind at the call site — no boundary parse: the classifier, not a
    // tier-2 guard, owns the range.
    const kind = classifyContactKind({
      address,
      canonicalName: existing?.canonicalName ?? args.canonicalNameIfNew,
    });

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

export interface ReKindCollisionArgs {
  readonly userId: string;
  /** The kind the caller wants to move the row TO. */
  readonly kind: EntityKind;
  /** The canonical name of the row being moved. */
  readonly canonicalName: string;
}

/**
 * True when moving a contact row to `kind` would land on a row that already
 * holds that `(user_id, kind, canonical_name)` coordinate — the columns of the
 * `entities` unique index.
 *
 * The collision is not a re-kinder's to resolve: a merge would pick a winner
 * and silently drop one contact's correspondence aggregate, so both callers
 * keep the row's current kind and report it. A stale kind is recoverable; a
 * dropped aggregate is not.
 *
 * ONE definition, for the same reason {@link previewContactKinds} is one: the
 * live writer below and the committed purge backfill re-kind the same rows
 * under the same index, and a second copy of this rule would drift (#1108,
 * the #493 precedent).
 */
export async function reKindWouldCollide(
  args: ReKindCollisionArgs,
  tx?: DbTransaction,
): Promise<boolean> {
  const [clash] = await (tx ?? db())
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.userId, args.userId),
        eq(entities.kind, args.kind),
        eq(entities.canonicalName, args.canonicalName),
      ),
    )
    .limit(1);

  return Boolean(clash);
}

/** The kind to write on an EXISTING contact row — see {@link reKindWouldCollide}. */
async function resolveKindForUpdate(
  ex: DbTransaction,
  existing: Entity,
  kind: EntityKind,
): Promise<string> {
  if (existing.kind === kind) return existing.kind;

  const collides = await reKindWouldCollide(
    { userId: existing.userId, kind, canonicalName: existing.canonicalName },
    ex,
  );

  return collides ? existing.kind : kind;
}

/**
 * The alias-`EXISTS` predicate every contact read shares — the live writer's
 * match and the preview's stored read below. ONE home: a second copy drifted
 * in beside the writer's, so the writer, the purge backfill and a dry run now
 * meet the same stored rows by construction.
 */
function storedContactMatch(userId: string, normalizedAddresses: readonly string[]) {
  return and(
    eq(entities.userId, userId),
    inArray(entities.kind, [...CONTACT_KINDS]),
    sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${entities.aliases}) AS alias
      WHERE ${inArray(sql`lower(alias)`, [...normalizedAddresses])}
    )`,
  );
}

/**
 * The ONE address-keyed preview door for a mail contact's kind: the stored
 * canonical name each existing row holds, classified the way the live writer
 * classifies it.
 *
 * Key = address as written; value = display name for a not-yet-stored contact
 * (`undefined` = bare address). Keys are normalized once, inside, with
 * `canonicalizeIdentityValue` — the same helper the writer matches on — and the
 * stored read runs in the caller's `tx` when one is passed. The returned map is
 * keyed by the caller's OWN candidate string, so `kinds.get(address)` is a
 * hit by construction and no caller re-derives a normalized key. A candidate
 * that does not normalize is absent from the result: the caller leaves it
 * alone rather than defaulting toward a write.
 *
 * A DRY backfill persists nothing, so it has no written row to read the kind
 * back from. It still has to report the kind a real write WOULD produce, and
 * the kind bar is defined over the STORED canonical name — the value an
 * existing row keeps and no writer ever updates. Without this read a preview
 * classifies the display name this scan's headers happened to carry, which is
 * exactly the per-run value the kind bar was moved off.
 *
 * A caller that already HOLDS the stored row (the committed purge backfill)
 * does not belong here: an address-keyed second read can return a SIBLING
 * row's name for a shared alias. That caller uses {@link
 * previewStoredContactKinds}, which classifies each row's own name.
 */
export async function previewContactKinds(
  userId: string,
  candidates: ReadonlyMap<string, string | undefined>,
  tx?: DbTransaction,
): Promise<Map<string, ContactKind>> {
  const wanted = new Map<string, string | undefined>();
  const keyOf = new Map<string, string>();

  for (const [key, displayName] of candidates) {
    const normalized = canonicalizeIdentityValue("email", key);

    if (!normalized) continue;

    if (!keyOf.has(key)) keyOf.set(key, normalized);

    if (!wanted.has(normalized)) wanted.set(normalized, displayName);
  }

  const kinds = new Map<string, ContactKind>();

  if (wanted.size === 0) return kinds;

  const rows = await (tx ?? db())
    .select({ canonicalName: entities.canonicalName, aliases: entities.aliases })
    .from(entities)
    .where(storedContactMatch(userId, [...wanted.keys()]));

  const stored = new Map<string, string>();

  for (const row of rows) {
    for (const alias of aliasesSchema.parse(row.aliases ?? [])) {
      stored.set(canonicalizeIdentityValue("email", alias), row.canonicalName);
    }
  }

  for (const [key, normalized] of keyOf) {
    kinds.set(
      key,
      classifyContactKind({
        address: normalized,
        canonicalName: stored.get(normalized) ?? wanted.get(normalized) ?? normalized,
      }),
    );
  }

  return kinds;
}

/**
 * The primary address of a STORED contact row: the metadata bag first, then
 * any email alias. Lenient by design — `aliases` is jsonb, so non-string
 * members are skipped, never strictly parsed: a strict parse would throw and
 * kill the whole committed run over one malformed row. The address-keyed
 * preview above already owns the strict stored-read path; this door
 * classifies rows the caller holds.
 */
function storedContactAddress(metadata: unknown, aliasesRaw: unknown): string | null {
  const fromMetadata = parseEmailAddress(
    parsePersonEntityMetadata(metadata).primaryAddress ?? null,
  );

  if (fromMetadata) return fromMetadata;

  if (Array.isArray(aliasesRaw)) {
    for (const alias of aliasesRaw) {
      if (!isNonEmptyString(alias)) continue;

      const address = parseEmailAddress(alias);

      if (address) return address;
    }
  }

  return null;
}

/**
 * The row-keyed preview door beside {@link previewContactKinds}: for a caller
 * that already holds the stored rows it is about to re-kind (the committed
 * purge backfill), where a second address-keyed read would be a NEW query over
 * the same rows and could answer with a sibling's stored name wherever two
 * rows share one alias.
 *
 * Each row classifies its OWN stored `canonicalName` — the same input the live
 * writer classifies for that row — so a wrapped alias, a metadata-led address,
 * and an alias-sharing pair each read their own name. Pure: no stored read,
 * no transaction. Keyed by row id, so the caller never derives a key and a
 * row with no derivable address is absent from the map: the caller leaves it
 * alone rather than defaulting toward a write.
 *
 * Takes the stored ROWS, not a derived address: the parameter names the
 * fields the door reads (`Pick<Entity, "id" | "canonicalName" | "aliases" |
 * "metadata">`), so this campaign's known wrong caller — a
 * `ContactAggregate`, which holds neither `aliases` nor `metadata` — fails
 * `check-types`. Structural residue remains (named, not closed): any object
 * with those four fields compiles, so the `Stored` in the name asserts a
 * provenance the type carries nothing of.
 */
export function previewStoredContactKinds(
  rows: ReadonlyArray<Pick<Entity, "id" | "canonicalName" | "aliases" | "metadata">>,
): Map<string, ContactKind> {
  const kinds = new Map<string, ContactKind>();

  // Row ids are unique by primary key out of a single select, so no dedup
  // guard: one set per row.
  for (const row of rows) {
    const address = storedContactAddress(row.metadata, row.aliases);

    if (!address) continue;

    kinds.set(row.id, classifyContactKind({ address, canonicalName: row.canonicalName }));
  }

  return kinds;
}
