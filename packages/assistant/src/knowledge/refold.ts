import {
  type GmailKindRefoldSkippedReason,
  USER_MODEL_PROJECTION_NAME,
  canonicalizeIdentityValue,
  getStringPath,
  identityRefSchema,
  type ProjectionCursorValue,
  type ProjectionSourceHighWatermark,
} from "@alfred/contracts";
import { db, rowsFromExecute } from "@alfred/db";
import {
  entityProfiles,
  integrationCredentials,
  observationFamilyHeads,
  observations,
  projectionRuns,
  user as userTable,
  type ProjectionRun,
} from "@alfred/db/schemas";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { type DbTransaction } from "@alfred/db";
import { projectGmailKindProfiles } from "./gmail-kind-fold";
import { requireEntityIdNamespace } from "./namespace";
import { liveObservationHeadJoin } from "./observations";
import {
  activateProjectionVersion,
  completeProjectionRun,
  startProjectionRun,
  writeProjectionCursor,
} from "./projection";
import { userModelReader } from "./reader";

/**
 * Re-fold the active Gmail kind projection over new observations and, when safe,
 * activate it. Runs per user after live capture and from the scheduled sweep.
 *
 * Auto-activation needs frozen logic: the fold is recomputed at the active run's
 * own watermark, inside a rolled-back transaction, and must match its stored
 * checksum. A mismatch blocks, and a human re-activates. This path never makes the
 * first activation. Adding or removing a Google account also changes the input and
 * blocks; that fails closed.
 */
export type RefoldGmailKindProjectionResult =
  | { readonly status: "skipped"; readonly reason: GmailKindRefoldSkippedReason }
  | {
      readonly status: "blocked";
      readonly reason: "logic-drift" | "unverifiable-active-run";
      readonly activeChecksum?: string;
      readonly recomputedChecksum?: string;
    }
  | {
      readonly status: "activated";
      readonly projectionVersion: number;
      readonly profileCount: number;
      readonly checksum: string;
    };

export async function refoldActiveGmailKindProjection(
  userId: string,
): Promise<RefoldGmailKindProjectionResult> {
  const active = await userModelReader(userId).getActivePointer();

  if (!active) {
    console.log(`[user-model.refold] skip user=${userId} reason=no-active-projection`);

    return { status: "skipped", reason: "no-active-projection" };
  }

  const activeRun = await loadProjectionRun(userId, active.activeRunId);
  const activeChecksum = activeRun?.checksum ?? null;
  const activeGmailWatermark = activeRun?.sourceHighWatermark.gmail ?? null;

  const sourceHighWatermark = await gmailProjectionHighWatermark(userId);

  if (!sourceHighWatermark.gmail) {
    console.log(`[user-model.refold] skip user=${userId} reason=no-gmail-observations`);

    return { status: "skipped", reason: "no-gmail-observations" };
  }

  const gmailCursor = sourceHighWatermark.gmail;

  requireEntityIdNamespace();
  const excludeEmailValues = await gmailProjectionExcludedEmails(userId);

  // Frozen-logic gate: the current code must reproduce the active checksum first.
  if (!activeChecksum || !activeGmailWatermark || !hasGmailAppendSnapshot(activeGmailWatermark)) {
    // A legacy or malformed active run cannot be verified. Fail closed.
    console.warn(
      `[user-model.refold] BLOCKED user=${userId} reason=unverifiable-active-run ` +
        `(active run ${active.activeRunId} missing checksum/watermark/append-snapshot) — ` +
        `re-activate via the script`,
    );

    return { status: "blocked", reason: "unverifiable-active-run" };
  }

  const recomputedChecksum = await recomputeChecksumAtWatermark({
    userId,
    runId: active.activeRunId,
    projectionVersion: active.activeVersion,
    gmailWatermark: activeGmailWatermark,
    excludeEmailValues,
  });

  if (recomputedChecksum !== activeChecksum) {
    console.warn(
      `[user-model.refold] BLOCKED user=${userId} reason=logic-drift ` +
        `active=${activeChecksum} recomputed=${recomputedChecksum} — classifier output changed ` +
        `since activation; scheduled auto-activation is disabled until a manual re-validation ` +
        `(see docs/reference/user-model-gmail-projection-activation.md)`,
    );

    return { status: "blocked", reason: "logic-drift", activeChecksum, recomputedChecksum };
  }

  if (
    sameGmailEventWatermark(activeGmailWatermark, gmailCursor) &&
    !(await hasGmailObservationsAfterAppendSnapshot(userId, activeGmailWatermark))
  ) {
    // Frozen logic and no new observations.
    console.log(`[user-model.refold] skip user=${userId} reason=up-to-date`);

    return { status: "skipped", reason: "up-to-date" };
  }

  // Frozen logic and new observations: fold into a new version and activate.
  const projectionVersion = active.activeVersion + 1;

  const completed = await db().transaction(async (tx) => {
    const started = await startProjectionRun(
      {
        userId,
        projectionName: USER_MODEL_PROJECTION_NAME,
        projectionVersion,
        sourceHighWatermark,
      },
      tx,
    );

    if (started.reused) {
      await tx
        .delete(entityProfiles)
        .where(
          and(
            eq(entityProfiles.userId, userId),
            eq(entityProfiles.projectionRunId, started.run.id),
          ),
        );
    }

    const projected = await projectGmailKindProfiles(
      {
        userId,
        projectionRunId: started.run.id,
        projectionVersion,
        gmailHighWatermark: gmailCursor,
        excludeEmailValues,
      },
      tx,
    );

    await writeProjectionCursor(
      {
        userId,
        projectionName: USER_MODEL_PROJECTION_NAME,
        projectionVersion,
        projectionRunId: started.run.id,
        source: "gmail",
        cursor: gmailCursor,
      },
      tx,
    );
    await completeProjectionRun(
      {
        runId: started.run.id,
        userId,
        checksum: projected.checksum,
        completedAt: new Date(),
        rowCounts: { entity_profiles: projected.profileCount },
        sourceHighWatermark,
      },
      tx,
    );

    return { runId: started.run.id, ...projected };
  });

  await activateProjectionVersion({
    userId,
    projectionName: USER_MODEL_PROJECTION_NAME,
    runId: completed.runId,
  });
  console.log(
    `[user-model.refold] ACTIVATED user=${userId} version=${projectionVersion} ` +
      `profiles=${completed.profileCount} checksum=${completed.checksum}`,
  );

  return {
    status: "activated",
    projectionVersion,
    profileCount: completed.profileCount,
    checksum: completed.checksum,
  };
}

/**
 * Thrown to roll back the checksum recompute. It reuses the active run's ids, so
 * the upsert hits that run's own rows, and the DB ends unchanged.
 */
class RefoldChecksumProbe extends Error {
  readonly checksum: string;
  constructor(checksum: string) {
    super("rollback: refold checksum probe");
    this.checksum = checksum;
  }
}

async function recomputeChecksumAtWatermark(args: {
  readonly userId: string;
  readonly runId: string;
  readonly projectionVersion: number;
  readonly gmailWatermark: ProjectionCursorValue;
  readonly excludeEmailValues: readonly string[];
}): Promise<string> {
  try {
    await db().transaction(async (tx) => {
      const projected = await projectGmailKindProfiles(
        {
          userId: args.userId,
          projectionRunId: args.runId,
          projectionVersion: args.projectionVersion,
          gmailHighWatermark: args.gmailWatermark,
          excludeEmailValues: args.excludeEmailValues,
        },
        tx,
      );

      throw new RefoldChecksumProbe(projected.checksum);
    });
  } catch (err) {
    if (err instanceof RefoldChecksumProbe) return err.checksum;
    throw err;
  }

  throw new Error("[user-model.refold] checksum probe did not roll back");
}

async function loadProjectionRun(userId: string, runId: string): Promise<ProjectionRun | null> {
  const [row] = await db()
    .select()
    .from(projectionRuns)
    .where(and(eq(projectionRuns.id, runId), eq(projectionRuns.userId, userId)))
    .limit(1);

  return row ?? null;
}

async function gmailProjectionHighWatermark(
  userId: string,
): Promise<ProjectionSourceHighWatermark> {
  return db().transaction(async (tx) => {
    const capturedAt = await dbNow(tx);

    const baseWhere = and(
      eq(observations.userId, userId),
      eq(observations.source, "gmail"),
      eq(observations.kind, "email_message"),
      lte(observations.createdAt, capturedAt),
    );

    const [eventRow] = await tx
      .select({ id: observations.id, occurredAt: observations.occurredAt })
      .from(observations)
      .innerJoin(observationFamilyHeads, liveObservationHeadJoin())
      .where(baseWhere)
      .orderBy(desc(observations.occurredAt), desc(observations.id))
      .limit(1);

    if (!eventRow) return {};

    return {
      gmail: {
        lastObservationId: eventRow.id,
        occurredAt: eventRow.occurredAt.toISOString(),
        sourceCursor: { appendSnapshot: { capturedAt: capturedAt.toISOString() } },
      },
    };
  });
}

async function dbNow(tx: DbTransaction): Promise<Date> {
  const result = await tx.execute(sql`select now() as "capturedAt"`);
  const rawCapturedAt = rowsFromExecute<{ capturedAt: Date | string }>(result)[0]?.capturedAt;
  const capturedAt = rawCapturedAt instanceof Date ? rawCapturedAt : new Date(rawCapturedAt ?? "");

  if (Number.isNaN(capturedAt.getTime())) {
    throw new Error("[user-model.refold] failed to capture DB timestamp");
  }

  return capturedAt;
}

async function gmailProjectionExcludedEmails(userId: string): Promise<string[]> {
  const [userRow] = await db()
    .select({ email: userTable.email })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);

  const credentials = await db()
    .select({ accountLabel: integrationCredentials.accountLabel })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.userId, userId),
        eq(integrationCredentials.provider, "google"),
        eq(integrationCredentials.status, "active"),
      ),
    );

  return canonicalEmailList([
    userRow?.email ?? null,
    ...credentials.map((credential) => credential.accountLabel),
  ]);
}

function canonicalEmailList(values: readonly (string | null)[]): string[] {
  const out = new Set<string>();

  for (const value of values) {
    const email = canonicalEmail(value);

    if (email) out.add(email);
  }

  return [...out].sort();
}

function canonicalEmail(value: string | null): string | null {
  if (!value) return null;
  const canonical = canonicalizeIdentityValue("email", value);
  const parsed = identityRefSchema.safeParse({ kind: "email", value: canonical });

  return parsed.success ? parsed.data.value : null;
}

function hasGmailAppendSnapshot(cursor: ProjectionCursorValue): boolean {
  return Boolean(gmailAppendSnapshotCapturedAt(cursor));
}

function sameGmailEventWatermark(a: ProjectionCursorValue, b: ProjectionCursorValue): boolean {
  return a.lastObservationId === b.lastObservationId && a.occurredAt === b.occurredAt;
}

function gmailAppendSnapshotCapturedAt(cursor: ProjectionCursorValue): Date | null {
  const capturedAt = getStringPath(cursor.sourceCursor, "appendSnapshot", "capturedAt");

  if (capturedAt === undefined) return null;
  const parsed = new Date(capturedAt);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function hasGmailObservationsAfterAppendSnapshot(
  userId: string,
  cursor: ProjectionCursorValue,
): Promise<boolean> {
  const capturedAt = gmailAppendSnapshotCapturedAt(cursor);

  if (!capturedAt) return true;

  const [row] = await db()
    .select({ id: observations.id })
    .from(observations)
    .innerJoin(observationFamilyHeads, liveObservationHeadJoin())
    .where(
      and(
        eq(observations.userId, userId),
        eq(observations.source, "gmail"),
        eq(observations.kind, "email_message"),
        gt(observations.createdAt, capturedAt),
      ),
    )
    .limit(1);

  return Boolean(row);
}
