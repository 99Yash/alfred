import { db } from "@alfred/db";
import { makeEntityNodeInsert } from "@alfred/db/helpers";
import {
  entityIdentities,
  entityNodes,
  type EntityIdentity,
  type EntityNode,
} from "@alfred/db/schemas";
import {
  identityRefSchema,
  type IdentityKind,
  type IdentityRef,
  type ObservationSource,
} from "@alfred/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { type DbExecutor } from "./executor";
import { requireEntityIdNamespace } from "./namespace";

/**
 * Ensure the STABLE node for a hard identity exists (ADR-0067 D2), returning it.
 * The id is the content address of `identity` (`makeEntityNodeInsert` mints both
 * the id and `canonical_identity` from one parsed identity, so they can never go
 * out of sync), keyed by the server `ENTITY_ID_NAMESPACE`. Idempotent: re-minting
 * the same identity yields the same id, so `ON CONFLICT (id) DO NOTHING` makes a
 * repeat call a no-op.
 *
 * `firstSeenAt` MUST be the earliest OBSERVATION timestamp for this node — it is
 * the merge-survivor tie-break read at the fold, so it must be deterministic
 * across replays, never a wall clock (the column is NOT NULL with no default for
 * exactly this reason). Crucially it must also be INDEPENDENT of replay ORDER:
 * a backfill can hand us a newer observation before an older one, so a plain
 * `ON CONFLICT DO NOTHING` would pin the stored value to whichever observation
 * happened to mint the node first — too late if an earlier one arrives next. The
 * upsert therefore monotonically pulls the column DOWN with
 * `LEAST(existing, excluded)`, guarded by a `setWhere` so it only writes (and only
 * bumps `updated_at`) when the incoming timestamp is strictly earlier. Whatever
 * order replay visits a node's observations in, `first_seen_at` converges to the
 * minimum — the tie-break is deterministic without forcing chronological replay.
 */
export async function ensureEntityNode(
  args: { userId: string; identity: IdentityRef; firstSeenAt: Date },
  tx?: DbExecutor,
): Promise<EntityNode> {
  const secret = requireEntityIdNamespace();
  const row = makeEntityNodeInsert(secret, args.userId, args.identity, args.firstSeenAt);

  const run = async (ex: DbExecutor): Promise<EntityNode> => {
    await ex
      .insert(entityNodes)
      .values(row)
      .onConflictDoUpdate({
        target: entityNodes.id,
        set: { firstSeenAt: sql`least(${entityNodes.firstSeenAt}, excluded.first_seen_at)` },
        setWhere: sql`excluded.first_seen_at < ${entityNodes.firstSeenAt}`,
      });
    const [node] = await ex.select().from(entityNodes).where(eq(entityNodes.id, row.id)).limit(1);
    if (!node) {
      throw new Error(
        `[user-model.ensureEntityNode] node ${row.id} missing immediately after upsert ` +
          `(user=${args.userId})`,
      );
    }
    return node;
  };

  return tx ? run(tx) : db().transaction(run);
}

/**
 * A live `(kind, value)` identity already binds to a DIFFERENT stable node than
 * the one the caller asked to link. This is the merge / re-anchor signal the
 * stable layer exists to surface (ADR-0067 D2/D16): two nodes now claim the same
 * hard identity, and only a reducer (P1/P2) may resolve it — by re-anchoring
 * (close the old row, bind the freed handle) or merging the nodes. The link
 * primitive refuses to silently hand back the other node's row as if the
 * requested link succeeded, so the reducer can catch this and act.
 */
export class EntityIdentityConflictError extends Error {
  readonly kind: IdentityKind;
  readonly value: string;
  /** The node the caller asked to bind the identity to. */
  readonly requestedEntityId: string;
  /** The node the live `(kind, value)` row actually binds to. */
  readonly liveEntityId: string;

  constructor(args: {
    kind: IdentityKind;
    value: string;
    requestedEntityId: string;
    liveEntityId: string;
  }) {
    super(
      `[user-model.recordEntityIdentity] identity (${args.kind}, ${args.value}) already binds ` +
        `to entity ${args.liveEntityId}, not the requested ${args.requestedEntityId} — ` +
        `a reducer must re-anchor or merge (D2/D16); the link is NOT silently accepted.`,
    );
    this.name = "EntityIdentityConflictError";
    this.kind = args.kind;
    this.value = args.value;
    this.requestedEntityId = args.requestedEntityId;
    this.liveEntityId = args.liveEntityId;
  }
}

export interface RecordEntityIdentityArgs {
  userId: string;
  /** The stable node this identity binds to (e.g. from {@link ensureEntityNode}). */
  entityId: string;
  identity: IdentityRef;
  source: ObservationSource;
  /** Observation/effective time — semantic, never a wall clock (the column has no default). */
  validFrom: Date;
  verified?: boolean;
  userPinned?: boolean;
  confidence?: number;
}

/**
 * Record a typed cross-source identity for a node (ADR-0067 D2), returning the
 * LIVE row for `(kind, value)`. Idempotent over the ACTIVE set: the
 * `entity_identities_active_unique_idx` is partial on `valid_until IS NULL`, so
 * `ON CONFLICT … WHERE valid_until IS NULL DO NOTHING` makes a repeat link a
 * no-op while leaving closed history (a freed/reused handle) untouched.
 *
 * `identity` is runtime-PARSED here (not just trusted by its TS type): a reducer
 * reading a provider payload through an `any` could otherwise persist a kind
 * outside `IDENTITY_KINDS` or a non-canonical/malformed value as the live dedup
 * key. RE-ANCHORING (closing an old row + binding a freed handle to a different
 * entity) and cross-entity MERGE are reducer-owned (P1/P2) — this is the
 * validated link primitive they build on.
 *
 * If the live `(kind, value)` row already belongs to a DIFFERENT entity, this
 * throws {@link EntityIdentityConflictError} rather than returning that other
 * node's row — the caller's link did not succeed, and pretending it did would
 * mask exactly the merge/re-anchor signal this stable layer must surface (D16).
 */
export async function recordEntityIdentity(
  args: RecordEntityIdentityArgs,
  tx?: DbExecutor,
): Promise<EntityIdentity> {
  const identity = identityRefSchema.parse(args.identity);

  const run = async (ex: DbExecutor): Promise<EntityIdentity> => {
    await ex
      .insert(entityIdentities)
      .values({
        userId: args.userId,
        entityId: args.entityId,
        kind: identity.kind,
        value: identity.value,
        source: args.source,
        validFrom: args.validFrom,
        verified: args.verified ?? false,
        userPinned: args.userPinned ?? false,
        ...(args.confidence === undefined ? {} : { confidence: args.confidence }),
      })
      .onConflictDoNothing({
        target: [entityIdentities.userId, entityIdentities.kind, entityIdentities.value],
        where: sql`${entityIdentities.validUntil} is null`,
      });

    const [live] = await ex
      .select()
      .from(entityIdentities)
      .where(
        and(
          eq(entityIdentities.userId, args.userId),
          eq(entityIdentities.kind, identity.kind),
          eq(entityIdentities.value, identity.value),
          isNull(entityIdentities.validUntil),
        ),
      )
      .limit(1);
    if (!live) {
      throw new Error(
        `[user-model.recordEntityIdentity] live identity missing after upsert ` +
          `(user=${args.userId}, kind=${identity.kind})`,
      );
    }
    if (live.entityId !== args.entityId) {
      throw new EntityIdentityConflictError({
        kind: identity.kind,
        value: identity.value,
        requestedEntityId: args.entityId,
        liveEntityId: live.entityId,
      });
    }
    return live;
  };

  return tx ? run(tx) : db().transaction(run);
}
