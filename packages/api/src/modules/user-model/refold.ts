import {
  USER_MODEL_PROJECTION_NAME,
  canonicalizeIdentityValue,
  identityRefSchema,
  type ProjectionCursorValue,
  type ProjectionSourceHighWatermark,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  entityProfiles,
  integrationCredentials,
  observationFamilyHeads,
  observations,
  projectionRuns,
  user as userTable,
  type ProjectionRun,
} from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";
import { projectGmailKindProfiles } from "./gmail-kind-fold";
import { requireEntityIdNamespace } from "./namespace";
import {
  activateProjectionVersion,
  completeProjectionRun,
  startProjectionRun,
  writeProjectionCursor,
} from "./projection";
import { userModelReader } from "./reader";

/**
 * Re-project the active Gmail kind-only user-model over the latest observations
 * and (when safe) auto-activate the refresh. Called from two places on the
 * ingestion queue:
 *
 *   - live capture (`user_model.gmail_kind_refold`, per-user) after new Gmail
 *     observations are appended;
 *   - the scheduled sweep (`user_model.gmail_kind_refold_sweep`, #218 PR J),
 *     which fans out to every user with an active projection.
 *
 * INVARIANT: a scheduled/event refold auto-activates ONLY when the classifier
 * logic is frozen relative to what was manually activated. "First activation is
 * manual" (see the activation runbook) — this path never activates the FIRST
 * projection (no active pointer → no-op) and never silently activates a CHANGED
 * classifier output.
 *
 * The frozen-logic gate recomputes the fold at the ACTIVE run's own Gmail
 * high-watermark (the exact input it consumed) and compares to the active run's
 * stored checksum. If the current code no longer reproduces that checksum, the
 * classifier output has drifted since activation (a logic change, or — the gate
 * can't tell them apart, and shouldn't — non-determinism): the refold is BLOCKED
 * rather than activated, and a human must re-validate + re-activate via the
 * script. Only once the gate confirms frozen logic do we fold the (possibly
 * advanced) current prefix into a new version and activate it.
 *
 * The recompute persists nothing (it runs inside a rolled-back transaction), so
 * a blocked or up-to-date run leaves the active projection untouched.
 *
 * Known safe-fail: the excluded-self-email set is recomputed each run, so
 * connecting/disconnecting a Google account changes the fold input and can trip
 * the drift gate even with frozen logic. That fails CLOSED (blocks
 * auto-activation, needs a manual re-activation) — the safe direction.
 */
export type RefoldGmailKindProjectionResult =
  | { readonly status: "skipped"; readonly reason: string }
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

  // Frozen-logic gate (#218 PR J): verify the current fold code still reproduces
  // the active run's checksum at the active run's input before auto-activating.
  if (!activeChecksum || !activeGmailWatermark) {
    // A malformed/legacy active run we can't verify. Fail closed rather than
    // auto-activate a fresh fold on an unverifiable base.
    console.warn(
      `[user-model.refold] BLOCKED user=${userId} reason=unverifiable-active-run ` +
        `(active run ${active.activeRunId} missing checksum/watermark) — re-activate via the script`,
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

  if (activeGmailWatermark.lastObservationId === gmailCursor.lastObservationId) {
    // Frozen logic AND no new observations since activation — already current.
    console.log(`[user-model.refold] skip user=${userId} reason=up-to-date`);
    return { status: "skipped", reason: "up-to-date" };
  }

  // Frozen logic + new observations: fold the advanced prefix into a fresh
  // version and activate it.
  const projectionVersion = active.activeVersion + 1;
  const completed = await db().transaction(async (tx) => {
    const started = await startProjectionRun(
      { userId, projectionName: USER_MODEL_PROJECTION_NAME, projectionVersion, sourceHighWatermark },
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
 * Rolled-back recompute of the Gmail kind checksum at a given watermark. Reuses
 * the active run's (version, run id) so the upsert targets the active run's own
 * profile rows, then throws to roll the whole transaction back — the DB is left
 * exactly as it was; only the deterministic checksum is returned.
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
  const [row] = await db()
    .select({ id: observations.id, occurredAt: observations.occurredAt })
    .from(observations)
    .innerJoin(
      observationFamilyHeads,
      and(
        eq(observationFamilyHeads.userId, observations.userId),
        eq(observationFamilyHeads.familyKey, observations.familyKey),
        eq(observationFamilyHeads.headObservationId, observations.id),
      ),
    )
    .where(
      and(
        eq(observations.userId, userId),
        eq(observations.source, "gmail"),
        eq(observations.kind, "email_message"),
      ),
    )
    .orderBy(desc(observations.occurredAt), desc(observations.id))
    .limit(1);
  if (!row) return {};
  return { gmail: { lastObservationId: row.id, occurredAt: row.occurredAt.toISOString() } };
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
