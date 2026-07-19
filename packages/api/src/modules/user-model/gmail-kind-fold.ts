import { createHash } from "node:crypto";
import {
  USER_MODEL_PROJECTION_NAME,
  getStringPath,
  identityRefSchema,
  isRecord,
  type EntityKindClassification,
  type IdentityRef,
  type ProjectionCursorValue,
  type ProjectionProvenance,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  entityProfiles,
  observationFamilyHeads,
  observations,
  type Observation,
} from "@alfred/db/schemas";
import { and, asc, eq, lte, or, sql, type SQL } from "drizzle-orm";
import { type DbExecutor } from "./executor";
import { liveObservationHeadJoin } from "./observations";
import { classifyEntityKind, type GmailPayloadSignals } from "./entity-kind-classifier";
import { ensureEntityNode, recordEntityIdentity } from "./entities";

export interface ProjectGmailKindProfilesArgs {
  readonly userId: string;
  readonly projectionRunId: string;
  readonly projectionVersion: number;
  readonly projectionName?: string;
  readonly computedAt?: Date;
  /**
   * Inclusive Gmail replay bound captured before the run starts. The completed
   * run records this value, so the fold must consume exactly this prefix.
   */
  readonly gmailHighWatermark?: ProjectionCursorValue;
  /**
   * Account-holder email identities to exclude from the first consumer-facing
   * profile projection. PR G can fill this from connected account addresses.
   */
  readonly excludeEmailValues?: readonly string[];
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

export async function projectGmailKindProfiles(
  args: ProjectGmailKindProfilesArgs,
  tx?: DbExecutor,
): Promise<ProjectGmailKindProfilesResult> {
  const run = async (ex: DbExecutor): Promise<ProjectGmailKindProfilesResult> => {
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
    const checksumRows: ProfileChecksumRow[] = [];
    const projectionName = args.projectionName ?? USER_MODEL_PROJECTION_NAME;
    const computedAt = args.computedAt ?? new Date();

    for (const acc of [...identities.values()].sort(compareAccumulators)) {
      const node = await ensureEntityNode(
        { userId: args.userId, identity: acc.identity, firstSeenAt: acc.firstSeenAt },
        ex,
      );
      await recordEntityIdentity(
        {
          userId: args.userId,
          entityId: node.id,
          identity: acc.identity,
          source: "gmail",
          validFrom: acc.firstSeenAt,
        },
        ex,
      );

      const classification = classifyEntityKind({
        identity: acc.identity,
        displayNames: displayNamesByStrength(acc.displayNameCounts),
        payloadSignals: acc.payloadSignals,
      });
      const provenance: ProjectionProvenance = {
        observationIds: [...acc.observationIds].sort(),
        familyKeys: [...acc.familyKeys].sort(),
        classification,
      };

      await ex
        .insert(entityProfiles)
        .values({
          userId: args.userId,
          projectionName,
          projectionVersion: args.projectionVersion,
          projectionRunId: args.projectionRunId,
          entityId: node.id,
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

      checksumRows.push(checksumRow(node.id, classification));
    }

    return {
      profileCount: checksumRows.length,
      checksum: checksumFor(checksumRows),
    };
  };

  return tx ? run(tx) : db().transaction(run);
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
      acc.payloadSignals.push(payloadSignalsFromObservation(observation));
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

function payloadSignalsFromObservation(observation: Observation): GmailPayloadSignals {
  const payload = observation.payload;
  const headers = isRecord(payload.headers) ? payload.headers : null;
  if (!headers) return {};
  return {
    listId: stringOrNull(headers.listId),
    listUnsubscribe: stringOrNull(headers.listUnsubscribe),
    precedence: stringOrNull(headers.precedence),
    autoSubmitted: stringOrNull(headers.autoSubmitted),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function gmailHighWatermarkCondition(watermark: ProjectionCursorValue | undefined): SQL | null {
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
    .sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB))
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
    evidenceCodes: [...classification.evidenceCodes].sort(),
    bestGuess: classification.bestGuess ?? null,
  };
}

function checksumFor(rows: readonly ProfileChecksumRow[]): string {
  const stable = [...rows].sort((a, b) => a.entityId.localeCompare(b.entityId));
  return `sha256:${createHash("sha256").update(JSON.stringify(stable)).digest("hex")}`;
}
