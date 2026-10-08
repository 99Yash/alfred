import { db } from "@alfred/db";
import { makeEntityNodeInsert } from "@alfred/db/helpers";
import {
  entityIdentities,
  entityNodes,
  type EntityIdentity,
  type EntityNode,
} from "@alfred/db/schemas";
import {
  entityIdentitySourceKindSchema,
  identityRefSchema,
  type IdentityKind,
  type IdentityRef,
  type ObservationSource,
} from "@alfred/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "@alfred/db";
import { requireEntityIdNamespace } from "./namespace";

/**
 * Ensure the stable node for a hard identity exists (ADR-0067 D2). The id is the
 * identity's content address, so a repeat call is a no-op.
 *
 * `firstSeenAt` must be the earliest observation time: it breaks merge ties.
 * Replay can arrive out of order, so the upsert keeps `LEAST(existing, excluded)`.
 */
export async function ensureEntityNode(
  args: { userId: string; identity: IdentityRef; firstSeenAt: Date },
  tx?: DbTransaction,
): Promise<EntityNode> {
  const secret = requireEntityIdNamespace();
  const row = makeEntityNodeInsert(secret, args.userId, args.identity, args.firstSeenAt);

  const run = async (ex: DbTransaction): Promise<EntityNode> => {
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
 * The live `(kind, value)` identity already binds to a different node. That is
 * the merge signal (ADR-0067 D2/D16), so the caller must handle it, not get the other row.
 */
export class EntityIdentityConflictError extends Error {
  readonly kind: IdentityKind;
  readonly value: string;
  /** The node the caller asked for. */
  readonly requestedEntityId: string;
  /** The node the live row binds to. */
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
  /** E.g. from {@link ensureEntityNode}. */
  entityId: string;
  identity: IdentityRef;
  source: ObservationSource;
  /** Observation time, never a wall clock. */
  validFrom: Date;
  verified?: boolean;
  userPinned?: boolean;
  confidence?: number;
}

/**
 * Link an identity to a node (ADR-0067 D2) and return the live row. A repeat
 * link is a no-op; closed history is untouched. `identity` and the `(source, kind)`
 * pair are parsed at runtime, so a reducer cannot persist an unregistered kind (#1028).
 * Throws {@link EntityIdentityConflictError} when another node holds the identity.
 */
export async function recordEntityIdentity(
  args: RecordEntityIdentityArgs,
  tx?: DbTransaction,
): Promise<EntityIdentity> {
  const identity = identityRefSchema.parse(args.identity);

  const { source, kind } = entityIdentitySourceKindSchema.parse({
    source: args.source,
    kind: identity.kind,
  });

  const run = async (ex: DbTransaction): Promise<EntityIdentity> => {
    await ex
      .insert(entityIdentities)
      .values({
        userId: args.userId,
        entityId: args.entityId,
        kind,
        value: identity.value,
        source,
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
          eq(entityIdentities.kind, kind),
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
