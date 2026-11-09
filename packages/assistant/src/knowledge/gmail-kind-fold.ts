import {
  USER_MODEL_PROJECTION_NAME,
  getStringPath,
  gmailEmailMessagePayloadSchema,
  identityRefSchema,
  type EntityKindClassification,
  type GmailEmailMessagePayload,
  type IdentityRef,
  type ProjectionCursorValue,
  type ProjectionProvenance,
} from "@alfred/contracts";
import { sha256Canonical } from "@alfred/db/hash";
import { makeEntityNodeInsert } from "@alfred/db/helpers";
import { db } from "@alfred/db";
import {
  entityProfiles,
  observationFamilyHeads,
  observations,
  type Observation,
} from "@alfred/db/schemas";
import { and, asc, eq, lte, or, sql, type SQL } from "drizzle-orm";
import type { DbTransaction } from "@alfred/db";
import { liveObservationHeadJoin } from "./observations";
import { classifyEntityKind, type GmailPayloadSignals } from "./entity-kind-classifier";
import { ensureEntityNode, recordEntityIdentity } from "./entities";
import { requireEntityIdNamespace } from "./namespace";

export interface ProjectGmailKindProfilesArgs {
  readonly userId: string;
  readonly projectionRunId: string;
  readonly projectionVersion: number;
  readonly projectionName?: string | undefined;
  readonly computedAt?: Date | undefined;
  /** Inclusive replay bound captured before the run. The fold must consume exactly this prefix. */
  readonly gmailHighWatermark?: ProjectionCursorValue | undefined;
  /** The user's own addresses, excluded from the projection. */
  readonly excludeEmailValues?: readonly string[] | undefined;
}

export interface ProjectGmailKindProfilesResult {
  readonly profileCount: number;
  readonly checksum: string;
}

interface IdentityAccumulator {
  readonly identity: IdentityRef;
  firstSeenAt: Date;
  lastSeenAt: Date;
  readonly observationIds: Set<string>;
  readonly familyKeys: Set<string>;
  readonly displayNameCounts: Map<string, number>;
  readonly payloadSignals: GmailPayloadSignals[];
}

interface ProfileChecksumRow {
  readonly entityId: string;
  readonly kind: string;
  readonly confidence: number;
  readonly evidenceCodes: readonly string[];
  readonly bestGuess: string | null;
}

/** The fold's inputs that decide its content. The run ids only tag the rows it writes. */
type GmailKindFoldInput = Pick<
  ProjectGmailKindProfilesArgs,
  "userId" | "gmailHighWatermark" | "excludeEmailValues"
>;

/** One profile the fold will write, decided before any write. */
interface PlannedKindProfile {
  readonly acc: IdentityAccumulator;
  /** The stable HMAC id `ensureEntityNode` writes for this identity. */
  readonly entityId: string;
  readonly classification: EntityKindClassification;
}

/**
 * Fold kinds into `entity_profiles` for one run, and mint the stable node and
 * identity for each profile. The checksum comes from the same plan that
 * {@link computeGmailKindChecksum} reads, so the writer and the refold drift gate
 * cannot disagree.
 */
export async function projectGmailKindProfiles(
  args: ProjectGmailKindProfilesArgs,
  tx: DbTransaction | "own",
): Promise<ProjectGmailKindProfilesResult> {
  const run = async (ex: DbTransaction): Promise<ProjectGmailKindProfilesResult> => {
    const plan = await planGmailKindProfiles(args, ex);
    const projectionName = args.projectionName ?? USER_MODEL_PROJECTION_NAME;
    const computedAt = args.computedAt ?? new Date();

    for (const { acc, entityId, classification } of plan) {
      await ensureEntityNode(
        { userId: args.userId, identity: acc.identity, firstSeenAt: acc.firstSeenAt },
        ex,
      );

      await recordEntityIdentity(
        {
          userId: args.userId,
          entityId,
          identity: acc.identity,
          source: "gmail",
          validFrom: acc.firstSeenAt,
        },
        ex,
      );

      const provenance: ProjectionProvenance = {
        observationIds: [...acc.observationIds].toSorted(),
        familyKeys: [...acc.familyKeys].toSorted(),
        classification,
      };

      await ex
        .insert(entityProfiles)
        .values({
          userId: args.userId,
          projectionName,
          projectionVersion: args.projectionVersion,
          projectionRunId: args.projectionRunId,
          entityId,
          displayName: displayNameFor(acc),
          kind: classification.kind,
          lastSeenAt: acc.lastSeenAt,
          provenance,
          computedAt,
        })
        .onConflictDoUpdate({
          target: [
            entityProfiles.userId,
            entityProfiles.projectionName,
            entityProfiles.projectionVersion,
            entityProfiles.entityId,
          ],
          set: {
            projectionRunId: args.projectionRunId,
            displayName: displayNameFor(acc),
            kind: classification.kind,
            lastSeenAt: acc.lastSeenAt,
            provenance,
            computedAt,
          },
        });
    }

    return planResult(plan);
  };

  return tx === "own" ? db().transaction(run) : run(tx);
}

/**
 * The kind checksum and profile count that {@link projectGmailKindProfiles} would
 * produce for `args`, with no write. The refold drift gate reads this. One select;
 * the entity ids come from the HMAC, so no node has to exist.
 */
export async function computeGmailKindChecksum(
  args: GmailKindFoldInput,
): Promise<ProjectGmailKindProfilesResult> {
  return planResult(await planGmailKindProfiles(args, db()));
}

async function planGmailKindProfiles(
  args: GmailKindFoldInput,
  ex: Pick<DbTransaction, "select">,
): Promise<PlannedKindProfile[]> {
  const conds: SQL[] = [
    eq(observations.userId, args.userId),
    eq(observations.source, "gmail"),
    eq(observations.kind, "email_message"),
  ];

  const watermarkCond = gmailHighWatermarkCondition(args.gmailHighWatermark);

  if (watermarkCond) conds.push(watermarkCond);

  const rows = await ex
    .select({ observation: observations })
    .from(observations)
    .innerJoin(observationFamilyHeads, liveObservationHeadJoin())
    .where(and(...conds))
    .orderBy(asc(observations.occurredAt), asc(observations.id));

  const excludedEmails = new Set(
    args.excludeEmailValues?.map((value) => value.toLowerCase()) ?? [],
  );

  const identities = collectIdentities(
    rows.map((row) => row.observation),
    excludedEmails,
  );

  const secret = requireEntityIdNamespace();

  return [...identities.values()].toSorted(compareAccumulators).map((acc) => ({
    acc,
    entityId: makeEntityNodeInsert(secret, args.userId, acc.identity, acc.firstSeenAt).id,
    classification: classifyEntityKind({
      identity: acc.identity,
      displayNames: displayNamesByStrength(acc.displayNameCounts),
      payloadSignals: acc.payloadSignals,
    }),
  }));
}

function planResult(plan: readonly PlannedKindProfile[]): ProjectGmailKindProfilesResult {
  return {
    profileCount: plan.length,
    checksum: checksumFor(plan.map((p) => checksumRow(p.entityId, p.classification))),
  };
}

function collectIdentities(
  observationRows: readonly Observation[],
  excludedEmails: ReadonlySet<string>,
): Map<string, IdentityAccumulator> {
  const byIdentity = new Map<string, IdentityAccumulator>();

  for (const observation of observationRows) {
    const subject = identityFromSubject(observation);

    if (subject && !isExcluded(subject, excludedEmails)) {
      const acc = ensureAccumulator(byIdentity, subject, observation);
      const payload = parseGmailObservationPayload(observation);

      if (payload) acc.payloadSignals.push(payload.headers);
    }

    for (const participant of observation.participants.items) {
      if (isExcluded(participant.identity, excludedEmails)) continue;
      const acc = ensureAccumulator(byIdentity, participant.identity, observation);

      if (participant.displayName) {
        acc.displayNameCounts.set(
          participant.displayName,
          (acc.displayNameCounts.get(participant.displayName) ?? 0) + 1,
        );
      }
    }
  }

  return byIdentity;
}

function identityFromSubject(observation: Observation): IdentityRef | null {
  const parsed = identityRefSchema.safeParse(observation.subjectIdentity);

  return parsed.success ? parsed.data : null;
}

function ensureAccumulator(
  byIdentity: Map<string, IdentityAccumulator>,
  identity: IdentityRef,
  observation: Observation,
): IdentityAccumulator {
  const key = identityKey(identity);
  const existing = byIdentity.get(key);

  if (existing) {
    if (observation.occurredAt < existing.firstSeenAt)
      existing.firstSeenAt = observation.occurredAt;

    if (observation.occurredAt > existing.lastSeenAt) existing.lastSeenAt = observation.occurredAt;
    existing.observationIds.add(observation.id);
    existing.familyKeys.add(observation.familyKey);

    return existing;
  }

  const created: IdentityAccumulator = {
    identity,
    firstSeenAt: observation.occurredAt,
    lastSeenAt: observation.occurredAt,
    observationIds: new Set([observation.id]),
    familyKeys: new Set([observation.familyKey]),
    displayNameCounts: new Map(),
    payloadSignals: [],
  };

  byIdentity.set(key, created);

  return created;
}

/** The Gmail payload of one `email_message` row, or null when it does not parse. Shared with the `works_at` fold. */
export function parseGmailObservationPayload(
  observation: Observation,
): GmailEmailMessagePayload | null {
  const parsed = gmailEmailMessagePayloadSchema.safeParse(observation.payload);

  return parsed.success ? parsed.data : null;
}

/** Inclusive Gmail replay bound, shared with the `works_at` fold so both replay one window. */
export function gmailHighWatermarkCondition(
  watermark: ProjectionCursorValue | undefined,
): SQL | null {
  if (!watermark) return null;
  const conds: SQL[] = [];

  if (watermark.occurredAt) {
    const occurredAt = new Date(watermark.occurredAt);

    if (Number.isNaN(occurredAt.getTime())) {
      throw new Error(`[user-model.gmail-kind-fold] invalid Gmail high-watermark occurredAt`);
    }

    if (watermark.lastObservationId) {
      const boundedByTimestampAndId = or(
        sql`${observations.occurredAt} < ${occurredAt}`,
        and(
          eq(observations.occurredAt, occurredAt),
          lte(observations.id, watermark.lastObservationId),
        ),
      );

      if (!boundedByTimestampAndId) {
        throw new Error(`[user-model.gmail-kind-fold] failed to build Gmail high-watermark bound`);
      }

      conds.push(boundedByTimestampAndId);
    } else {
      conds.push(lte(observations.occurredAt, occurredAt));
    }
  } else if (watermark.lastObservationId) {
    conds.push(lte(observations.id, watermark.lastObservationId));
  }

  const appendSnapshot = gmailAppendSnapshotFromCursor(watermark);

  if (appendSnapshot) {
    conds.push(lte(observations.createdAt, appendSnapshot.capturedAt));
  }

  if (conds.length === 0) return null;
  const combined = and(...conds);

  if (!combined) throw new Error(`[user-model.gmail-kind-fold] failed to build watermark bound`);

  return combined;
}

interface GmailAppendSnapshot {
  readonly capturedAt: Date;
}

function gmailAppendSnapshotFromCursor(
  watermark: ProjectionCursorValue,
): GmailAppendSnapshot | null {
  const capturedAt = getStringPath(watermark.sourceCursor, "appendSnapshot", "capturedAt");

  if (capturedAt === undefined) return null;
  const parsedCapturedAt = new Date(capturedAt);

  if (Number.isNaN(parsedCapturedAt.getTime())) {
    throw new Error(`[user-model.gmail-kind-fold] invalid Gmail append snapshot capturedAt`);
  }

  return { capturedAt: parsedCapturedAt };
}

function isExcluded(identity: IdentityRef, excludedEmails: ReadonlySet<string>): boolean {
  return identity.kind === "email" && excludedEmails.has(identity.value);
}

function displayNamesByStrength(counts: ReadonlyMap<string, number>): string[] {
  return [...counts.entries()]
    .toSorted(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB))
    .map(([name]) => name);
}

function displayNameFor(acc: IdentityAccumulator): string {
  return displayNamesByStrength(acc.displayNameCounts)[0] ?? acc.identity.value;
}

function compareAccumulators(a: IdentityAccumulator, b: IdentityAccumulator): number {
  return identityKey(a.identity).localeCompare(identityKey(b.identity));
}

function identityKey(identity: IdentityRef): string {
  return `${identity.kind}\u0000${identity.value}`;
}

function checksumRow(
  entityId: string,
  classification: EntityKindClassification,
): ProfileChecksumRow {
  return {
    entityId,
    kind: classification.kind,
    confidence: classification.confidence,
    evidenceCodes: classification.evidenceCodes.toSorted(),
    bestGuess: classification.bestGuess ?? null,
  };
}

function checksumFor(rows: readonly ProfileChecksumRow[]): string {
  const stable = rows.toSorted((a, b) => a.entityId.localeCompare(b.entityId));

  return sha256Canonical(stable);
}
