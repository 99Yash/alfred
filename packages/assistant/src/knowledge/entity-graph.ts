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

/** `entities.kind` values (ADR-0012). The union derives from the tuple. */
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
 * The two kinds the mail-contact writer owns. The match spans both, so a re-kinded
 * contact updates in place instead of duplicating (#1108).
 */
const CONTACT_KINDS = ["person", "other"] as const satisfies readonly EntityKind[];

export type ContactKind = (typeof CONTACT_KINDS)[number];

/** Parses a contact row's stored kind. */
const contactKindSchema = z.enum(CONTACT_KINDS);

/**
 * The answer of both contact-kind preview doors. Each input is in exactly one of
 * `kinds` or `unclassifiable`. Leave an unclassifiable input alone; do not default it to a write.
 */
export interface ContactKindPreview {
  /** Key space is per door. */
  kinds: ReadonlyMap<string, ContactKind>;
  unclassifiable: readonly string[];
}

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

/** `Entity` with the zod-parsed jsonb/enum columns narrowed and the lifecycle dates dropped. */
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
 * Upsert by `(user_id, kind, canonical_name)`. Aliases only grow; metadata is last-writes-wins.
 * Two people with one display name merge here, so use {@link upsertContactByAlias} for people.
 * Pass `tx` to commit with the caller's other writes.
 */
export async function upsertEntity(args: UpsertEntityArgs, tx?: DbTransaction): Promise<EntityRow> {
  const parsed = upsertEntityArgsSchema.parse(args);
  const aliases = parsed.aliases ?? [];
  const metadata = parsed.metadata ?? {};

  // Insert, then merge by hand on conflict: a jsonb alias union is awkward in one `onConflictDoUpdate`.
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
  /** Matched after `canonicalizeIdentityValue`. */
  address: string;
  aliases: string[];
  /** Used only on insert; an existing row keeps its name. */
  canonicalNameIfNew: string;
  /** Builds the metadata from the row's prior bag, inside the match's transaction. */
  buildMetadata: (priorMetadata: JsonObject) => JsonObject;
}

/** Input for {@link previewContactKinds}. `displayName` is `undefined` for a bare address. */
export type ContactPreviewCandidate = Pick<UpsertContactByAliasArgs, "buildMetadata"> & {
  displayName: string | undefined;
};

/** Caller keys win over the prior bag. One home, so the writer and the preview agree. */
function mergeContactMetadata(
  prior: JsonObject,
  build: (priorMetadata: JsonObject) => JsonObject,
): JsonObject {
  return { ...prior, ...build(prior) };
}

/**
 * The legacy kind of one contact from its stored values (#1198). The writer and
 * both previews call this, so they cannot disagree about a row.
 */
function classifyStoredContact(
  address: string,
  canonicalName: string,
  metadata: unknown,
): ContactKind {
  const parsed = parsePersonEntityMetadata(metadata);

  return classifyContactKind({
    address,
    canonicalName,
    listEvidence: parsed.listEvidence ?? [],
    userHasWrittenTo:
      parsed.userHasWrittenTo === true || (parsed.correspondence?.outbound ?? 0) > 0,
  });
}

/**
 * Upsert one mail contact matched by email alias, not by display name.
 * An existing row keeps its `canonicalName`. The kind is derived from the stored
 * name and the merged metadata, never from this run's headers, so the writer and
 * the backfills agree (#1108). The match spans `person` and `other`, so a re-kind
 * moves the row in place. A re-kind the unique index would refuse keeps the kind
 * and reports `reKindBlocked`.
 */
export async function upsertContactByAlias(
  args: UpsertContactByAliasArgs,
  tx?: DbTransaction,
): Promise<{ row: EntityRow; reKindBlocked: boolean }> {
  const address = canonicalizeIdentityValue("email", args.address);

  if (!address) {
    throw new Error("[memory.entities] upsertContactByAlias requires a non-empty address");
  }

  const run = async (ex: DbTransaction): Promise<{ row: EntityRow; reKindBlocked: boolean }> => {
    const [existing] = await ex
      .select()
      .from(entities)
      .where(storedContactMatch(args.userId, [address]))
      .limit(1);

    const metadata = mergeContactMetadata(
      existing ? jsonRecordSchema.parse(existing.metadata) : {},
      args.buildMetadata,
    );

    // Classify the values the row holds after the write.
    const kind = classifyStoredContact(
      address,
      existing?.canonicalName ?? args.canonicalNameIfNew,
      metadata,
    );

    if (!existing) {
      const [row] = await ex
        .insert(entities)
        .values({
          userId: args.userId,
          kind,
          canonicalName: args.canonicalNameIfNew,
          aliases: args.aliases,
          metadata,
        })
        .returning();

      if (!row) throw new Error("[memory.entities] upsertContactByAlias insert returned no row");

      return { row: rowToEntity(row), reKindBlocked: false };
    }

    const mergedAliases = Array.from(
      new Set([...aliasesSchema.parse(existing.aliases), ...args.aliases]),
    );

    const mergedMetadata = metadata;

    const decision = await resolveKindForUpdate(ex, existing, kind);

    const [row] = await ex
      .update(entities)
      .set({
        kind: decision.kind,
        aliases: mergedAliases,
        metadata: mergedMetadata,
        rowVersion: sql`${entities.rowVersion} + 1`,
      })
      .where(eq(entities.id, existing.id))
      .returning();

    if (!row) throw new Error("[memory.entities] upsertContactByAlias update returned no row");

    return { row: rowToEntity(row), reKindBlocked: decision.blocked };
  };

  return tx ? run(tx) : db().transaction(run);
}

export interface ReKindCollisionArgs {
  readonly userId: string;
  /** The row's current kind. Required, so the same-kind case answers itself. */
  readonly from: EntityKind;
  readonly kind: EntityKind;
  readonly canonicalName: string;
}

/**
 * True when moving a contact to `kind` would hit the `entities` unique index.
 * Same kind answers `false` with no query. Callers keep the old kind and report it:
 * merging would drop one contact's correspondence. A stale kind is recoverable.
 */
export async function reKindWouldCollide(
  args: ReKindCollisionArgs,
  tx?: DbTransaction,
): Promise<boolean> {
  if (args.from === args.kind) return false;

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

/** The kind to write on an existing row, and whether a wanted move was refused. */
interface ReKindDecision {
  kind: EntityKind;
  blocked: boolean;
}

async function resolveKindForUpdate(
  ex: DbTransaction,
  existing: Entity,
  kind: EntityKind,
): Promise<ReKindDecision> {
  const storedKind = entityKindSchema.parse(existing.kind);

  if (storedKind === kind) return { kind: storedKind, blocked: false };

  const collides = await reKindWouldCollide(
    { userId: existing.userId, from: storedKind, kind, canonicalName: existing.canonicalName },
    ex,
  );

  return collides ? { kind: storedKind, blocked: true } : { kind, blocked: false };
}

/** The alias-match predicate every contact read shares. */
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
 * Address-keyed preview of contact kinds, classified like the live writer: from the
 * stored canonical name and the merged metadata, which a dry run cannot read back.
 * `kinds` uses the caller's own keys. An empty key goes to `unclassifiable`.
 * A caller that already holds rows uses {@link previewStoredContactKinds}.
 * `blockedEstimate` is only an estimate: the committer inserts rows as it runs,
 * and two rows that share an alias can resolve differently.
 */
export async function previewContactKinds(
  userId: string,
  candidates: ReadonlyMap<string, ContactPreviewCandidate>,
  tx?: DbTransaction,
): Promise<ContactKindPreview & { blockedEstimate: number }> {
  const wanted = new Map<string, ContactPreviewCandidate>();
  const keyOf = new Map<string, string>();
  const unclassifiable: string[] = [];

  for (const [key, candidate] of candidates) {
    const normalized = canonicalizeIdentityValue("email", key);

    if (!normalized) {
      unclassifiable.push(key);
      continue;
    }

    if (!keyOf.has(key)) keyOf.set(key, normalized);

    if (!wanted.has(normalized)) wanted.set(normalized, candidate);
  }

  const kinds = new Map<string, ContactKind>();

  if (wanted.size === 0) return { kinds, unclassifiable, blockedEstimate: 0 };

  const rows = await (tx ?? db())
    .select({
      canonicalName: entities.canonicalName,
      aliases: entities.aliases,
      kind: entities.kind,
      metadata: entities.metadata,
    })
    .from(entities)
    .where(storedContactMatch(userId, [...wanted.keys()]));

  const stored = new Map<
    string,
    { canonicalName: string; kind: ContactKind; metadata: JsonObject }
  >();

  for (const row of rows) {
    const kind = contactKindSchema.parse(row.kind);
    const metadata = jsonRecordSchema.parse(row.metadata);

    for (const alias of aliasesSchema.parse(row.aliases ?? [])) {
      const normalized = canonicalizeIdentityValue("email", alias);
      stored.set(normalized, { canonicalName: row.canonicalName, kind, metadata });
    }
  }

  let blockedEstimate = 0;

  for (const [key, normalized] of keyOf) {
    const prior = stored.get(normalized);
    const candidate = wanted.get(normalized);
    const storedName = prior?.canonicalName;
    const canonicalName = storedName ?? candidate?.displayName ?? normalized;

    // The same merge the writer does.
    const metadata = candidate
      ? mergeContactMetadata(prior?.metadata ?? {}, candidate.buildMetadata)
      : (prior?.metadata ?? {});

    const kind = classifyStoredContact(normalized, canonicalName, metadata);
    kinds.set(key, kind);

    const priorKind = prior?.kind;

    if (storedName !== undefined && priorKind !== undefined && priorKind !== kind) {
      if (
        await reKindWouldCollide({ userId, from: priorKind, kind, canonicalName: storedName }, tx)
      ) {
        blockedEstimate += 1;
      }
    }
  }

  return { kinds, unclassifiable, blockedEstimate };
}

/** Metadata address first, then any email alias. Lenient: one bad row must not kill a committed run. */
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
 * Row-keyed preview for a caller that already holds the rows, such as the purge backfill.
 * Each row classifies its own name and metadata, so rows that share an alias do not mix.
 * Pure, keyed by row id. A row with no address goes to `unclassifiable`.
 */
export function previewStoredContactKinds(
  rows: ReadonlyArray<Pick<Entity, "id" | "canonicalName" | "aliases" | "metadata">>,
): ContactKindPreview {
  const kinds = new Map<string, ContactKind>();
  const unclassifiable: string[] = [];

  for (const row of rows) {
    const address = storedContactAddress(row.metadata, row.aliases);

    if (!address) {
      unclassifiable.push(row.id);
      continue;
    }

    kinds.set(row.id, classifyStoredContact(address, row.canonicalName, row.metadata));
  }

  return { kinds, unclassifiable };
}
