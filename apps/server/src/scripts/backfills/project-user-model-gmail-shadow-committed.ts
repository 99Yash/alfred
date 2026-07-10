/**
 * COMMITTED Gmail user-model kind projection (user-model P1, issue #218 — PR G).
 *
 * Replays active Gmail `email_message` observations into the first activated
 * projection-backed read model: stable entity nodes/identities plus
 * `entity_profiles.kind` + classifier provenance. This is the narrow
 * dist-list/kind slice only — no significance components, edges, or
 * co-occurrence are written here.
 *
 * SAFETY: dry by default. Dry mode runs the real writer path twice inside
 * rollback-only transactions and compares checksums. `--commit` is required to
 * persist the completed projection run. `--activate` is optional and requires
 * `--commit`.
 *
 *   # preview a user, write nothing:
 *   node dist/scripts/backfills/project-user-model-gmail-shadow-committed.js --emails=yash.k@oliv.ai --projection-version=1
 *   # write completed projection rows but do not activate:
 *   node dist/scripts/backfills/project-user-model-gmail-shadow-committed.js --emails=yash.k@oliv.ai --projection-version=1 --commit
 *   # write and activate after validation:
 *   node dist/scripts/backfills/project-user-model-gmail-shadow-committed.js --emails=yash.k@oliv.ai --projection-version=1 --commit --activate
 */
import {
  activateProjectionVersion,
  completeProjectionRun,
  projectGmailKindProfiles,
  requireEntityIdNamespace,
  startProjectionRun,
  writeProjectionCursor,
} from "@alfred/api/backend";
import { closeConnections, closeRedis, warmPool } from "@alfred/api/runtime";
import {
  USER_MODEL_PROJECTION_NAME,
  canonicalizeIdentityValue,
  identityRefSchema,
  toMessage,
  type ProjectionSourceHighWatermark,
} from "@alfred/contracts";
import { db, rowsFromExecute } from "@alfred/db";
import {
  entityProfiles,
  integrationCredentials,
  observationFamilyHeads,
  observations,
  user as userTable,
} from "@alfred/db/schemas";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");
const ACTIVATE = process.argv.includes("--activate");
const ALL_CONNECTED = process.argv.includes("--all-connected");

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function parseEmails(): string[] {
  const raw = flagValue("emails");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseProjectionVersion(): number {
  const raw = flagValue("projection-version");
  if (!raw) throw new Error("--projection-version=N is required");
  const version = Number.parseInt(raw, 10);
  if (!Number.isFinite(version) || version <= 0) {
    throw new Error(`--projection-version must be a positive integer, got: ${raw}`);
  }
  return version;
}

interface TargetUser {
  readonly userId: string;
  readonly email: string;
  readonly excludeEmailValues: readonly string[];
}

interface AttemptResult {
  readonly runId: string;
  readonly reusedRun: boolean;
  readonly profileCount: number;
  readonly checksum: string;
  readonly sourceHighWatermark: ProjectionSourceHighWatermark;
}

class DryRunRollback extends Error {
  readonly result: AttemptResult;

  constructor(result: AttemptResult) {
    super("rollback dry-run projection attempt");
    this.result = result;
  }
}

async function resolveTargets(emails: readonly string[]): Promise<TargetUser[]> {
  const baseRows = ALL_CONNECTED
    ? await db()
        .select({
          userId: userTable.id,
          email: userTable.email,
        })
        .from(integrationCredentials)
        .innerJoin(userTable, eq(userTable.id, integrationCredentials.userId))
        .where(
          and(
            eq(integrationCredentials.provider, "google"),
            eq(integrationCredentials.status, "active"),
          ),
        )
        .groupBy(userTable.id, userTable.email)
        .orderBy(asc(userTable.email))
    : await db()
        .select({ userId: userTable.id, email: userTable.email })
        .from(userTable)
        .where(inArray(userTable.email, [...emails]))
        .orderBy(asc(userTable.email));

  if (baseRows.length === 0) return [];

  const credentials = await db()
    .select({
      userId: integrationCredentials.userId,
      accountLabel: integrationCredentials.accountLabel,
    })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.provider, "google"),
        inArray(
          integrationCredentials.userId,
          baseRows.map((row) => row.userId),
        ),
      ),
    );

  const accountEmailsByUser = new Map<string, Set<string>>();
  for (const row of baseRows) {
    accountEmailsByUser.set(row.userId, new Set(canonicalEmailList([row.email])));
  }
  for (const credential of credentials) {
    const email = canonicalEmail(credential.accountLabel);
    if (!email) continue;
    const values = accountEmailsByUser.get(credential.userId);
    if (values) values.add(email);
  }

  return baseRows.map((row) => ({
    userId: row.userId,
    email: row.email,
    excludeEmailValues: [...(accountEmailsByUser.get(row.userId) ?? new Set())].sort(),
  }));
}

async function gmailHighWatermark(userId: string): Promise<ProjectionSourceHighWatermark> {
  return db().transaction(async (tx) => {
    const capturedAtResult = await tx.execute(sql`select now() as "capturedAt"`);
    const rawCapturedAt = rowsFromExecute<{ capturedAt: Date | string }>(capturedAtResult)[0]
      ?.capturedAt;
    const capturedAt =
      rawCapturedAt instanceof Date ? rawCapturedAt : new Date(rawCapturedAt ?? "");
    if (Number.isNaN(capturedAt.getTime())) {
      throw new Error("failed to capture DB timestamp for Gmail watermark");
    }
    const baseWhere = and(
      eq(observations.userId, userId),
      eq(observations.source, "gmail"),
      eq(observations.kind, "email_message"),
      lte(observations.createdAt, capturedAt),
    );
    const activeHeadJoin = and(
      eq(observationFamilyHeads.userId, observations.userId),
      eq(observationFamilyHeads.familyKey, observations.familyKey),
      eq(observationFamilyHeads.headObservationId, observations.id),
    );

    const [eventRow] = await tx
      .select({
        id: observations.id,
        occurredAt: observations.occurredAt,
      })
      .from(observations)
      .innerJoin(observationFamilyHeads, activeHeadJoin)
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

async function activeObservationCount(userId: string): Promise<number> {
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
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
    );
  return row?.count ?? 0;
}

async function runAttempt(args: {
  readonly target: TargetUser;
  readonly projectionVersion: number;
  readonly sourceHighWatermark: ProjectionSourceHighWatermark;
  readonly commit: boolean;
  readonly expected?: Pick<AttemptResult, "checksum" | "profileCount">;
}): Promise<AttemptResult> {
  const runBody = async (): Promise<AttemptResult> =>
    db().transaction(async (tx) => {
      const started = await startProjectionRun(
        {
          userId: args.target.userId,
          projectionName: USER_MODEL_PROJECTION_NAME,
          projectionVersion: args.projectionVersion,
          sourceHighWatermark: args.sourceHighWatermark,
        },
        tx,
      );
      if (started.reused) {
        await tx
          .delete(entityProfiles)
          .where(
            and(
              eq(entityProfiles.userId, args.target.userId),
              eq(entityProfiles.projectionRunId, started.run.id),
            ),
          );
      }

      const projected = await projectGmailKindProfiles(
        {
          userId: args.target.userId,
          projectionRunId: started.run.id,
          projectionVersion: args.projectionVersion,
          gmailHighWatermark: args.sourceHighWatermark.gmail,
          excludeEmailValues: args.target.excludeEmailValues,
        },
        tx,
      );
      if (
        args.expected &&
        (projected.checksum !== args.expected.checksum ||
          projected.profileCount !== args.expected.profileCount)
      ) {
        throw new Error(
          `committed projection diverged from dry validation for ${args.target.email}: ` +
            `dry=${args.expected.checksum}/${args.expected.profileCount}, ` +
            `commit=${projected.checksum}/${projected.profileCount}`,
        );
      }
      if (args.sourceHighWatermark.gmail) {
        await writeProjectionCursor(
          {
            userId: args.target.userId,
            projectionName: USER_MODEL_PROJECTION_NAME,
            projectionVersion: args.projectionVersion,
            projectionRunId: started.run.id,
            source: "gmail",
            cursor: args.sourceHighWatermark.gmail,
          },
          tx,
        );
      }
      await completeProjectionRun(
        {
          runId: started.run.id,
          userId: args.target.userId,
          checksum: projected.checksum,
          completedAt: new Date(),
          rowCounts: { entity_profiles: projected.profileCount },
          sourceHighWatermark: args.sourceHighWatermark,
        },
        tx,
      );

      const result: AttemptResult = {
        runId: started.run.id,
        reusedRun: started.reused,
        profileCount: projected.profileCount,
        checksum: projected.checksum,
        sourceHighWatermark: args.sourceHighWatermark,
      };
      if (!args.commit) throw new DryRunRollback(result);
      return result;
    });

  if (args.commit) return runBody();
  try {
    return await runBody();
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    throw err;
  }
}

async function validateDeterminism(args: {
  readonly target: TargetUser;
  readonly projectionVersion: number;
  readonly sourceHighWatermark: ProjectionSourceHighWatermark;
}): Promise<AttemptResult> {
  const first = await runAttempt({ ...args, commit: false });
  const second = await runAttempt({ ...args, commit: false });
  if (first.checksum !== second.checksum || first.profileCount !== second.profileCount) {
    throw new Error(
      `determinism check failed for ${args.target.email}: ` +
        `first=${first.checksum}/${first.profileCount}, ` +
        `second=${second.checksum}/${second.profileCount}`,
    );
  }
  return first;
}

function canonicalEmailList(values: readonly string[]): string[] {
  return values.flatMap((value) => {
    const email = canonicalEmail(value);
    return email ? [email] : [];
  });
}

function canonicalEmail(value: string | null): string | null {
  if (!value) return null;
  const canonical = canonicalizeIdentityValue("email", value);
  const parsed = identityRefSchema.safeParse({ kind: "email", value: canonical });
  return parsed.success ? parsed.data.value : null;
}

async function processTarget(target: TargetUser, projectionVersion: number): Promise<void> {
  const observationCount = await activeObservationCount(target.userId);
  const sourceHighWatermark = await gmailHighWatermark(target.userId);
  console.log(`\n=== ${target.email} (user=${target.userId}) ===`);
  console.log(
    `  active gmail observations=${observationCount} excluded_self_emails=${target.excludeEmailValues.join(",") || "(none)"}`,
  );

  const dry = await validateDeterminism({ target, projectionVersion, sourceHighWatermark });
  console.log(
    `  DRY validated — profiles=${dry.profileCount} checksum=${dry.checksum} ` +
      `high_watermark=${JSON.stringify(dry.sourceHighWatermark)}`,
  );

  if (!COMMIT) return;

  const committed = await runAttempt({
    target,
    projectionVersion,
    sourceHighWatermark,
    commit: true,
    expected: dry,
  });
  console.log(
    `  COMMITTED — run=${committed.runId} reused=${committed.reusedRun} ` +
      `profiles=${committed.profileCount} checksum=${committed.checksum}`,
  );

  if (!ACTIVATE) return;
  await activateProjectionVersion({
    userId: target.userId,
    projectionName: USER_MODEL_PROJECTION_NAME,
    runId: committed.runId,
  });
  console.log(`  ACTIVATED — ${USER_MODEL_PROJECTION_NAME} v${projectionVersion}`);
}

async function main() {
  const emails = parseEmails();
  if (!ALL_CONNECTED && emails.length === 0) {
    throw new Error("specify --emails=a@x.com,b@y.com or --all-connected");
  }
  if (ALL_CONNECTED && emails.length > 0) {
    throw new Error("--emails and --all-connected are mutually exclusive");
  }
  if (ACTIVATE && !COMMIT) {
    throw new Error("--activate requires --commit");
  }
  const projectionVersion = parseProjectionVersion();

  requireEntityIdNamespace();
  await warmPool();
  console.log(
    `# Gmail user-model kind projection — mode=${COMMIT ? "COMMIT" : "DRY"} ` +
      `activate=${ACTIVATE} projection=${USER_MODEL_PROJECTION_NAME} v${projectionVersion} ` +
      `target=${ALL_CONNECTED ? "all-connected" : emails.join(", ")}`,
  );

  const targets = await resolveTargets(emails);
  if (!ALL_CONNECTED) {
    const found = new Set(targets.map((target) => target.email));
    for (const email of emails) {
      if (!found.has(email)) console.log(`! no user row for ${email}`);
    }
  }
  if (targets.length === 0) {
    console.log("no targets matched — nothing to do");
    return;
  }

  for (const target of targets) {
    await processTarget(target, projectionVersion);
  }
  console.log(COMMIT ? "\n# done" : "\n# DRY — re-run with --commit to persist");
}

main()
  .catch((err) => {
    console.error(toMessage(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });
