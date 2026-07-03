import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { closeConnections, db } from "@alfred/db";
import { observations, projectionRuns, user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { gmailEmailMessagePayloadSchema, USER_MODEL_PROJECTION_NAME } from "@alfred/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  activateProjectionVersion,
  appendObservationFamilyMember,
  completeProjectionRun,
  projectGmailKindProfiles,
  refoldActiveGmailKindProjection,
  startProjectionRun,
  userModelReader,
} from "../../src/modules/user-model";

/**
 * Scheduled/event re-fold gate (#218 PR J). Proves the frozen-logic invariant:
 * an auto-refold activates a new version only when the current fold code still
 * reproduces the active run's checksum at the active run's input; on drift it
 * BLOCKS instead of activating.
 */

const ID_PREFIX = "test-gmail-kind-refold-";
const BASE_AT = new Date("2026-06-30T08:00:00.000Z");
const LATER_AT = new Date("2026-07-01T08:00:00.000Z");
const TEST_ENTITY_ID_SECRET = "stable namespace secret for tests";
const createdUserIds: string[] = [];

const SERVER_ENV_FIXTURES: Record<string, string> = {
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "test better auth secret with length",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALFRED_ALLOWED_EMAIL: "test@example.com",
  RESEND_API_KEY: "test-resend",
  RESEND_FROM_EMAIL: "Alfred <noreply@example.com>",
  ANTHROPIC_API_KEY: "test-anthropic",
  GOOGLE_GENERATIVE_AI_API_KEY: "test-google-ai",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/auth/callback/google",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_CLIENT_ID: "test-github-client",
  GITHUB_APP_CLIENT_SECRET: "test-github-secret",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
  ENTITY_ID_NAMESPACE: TEST_ENTITY_ID_SECRET,
};

function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}

const SKIP_DB = hasDatabaseUrl() ? false : "DATABASE_URL not set - skipping DB-backed test";

describe("refoldActiveGmailKindProjection (DB-backed)", { skip: SKIP_DB }, () => {
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("skips when the user has no active projection", async () => {
    seedServerEnvForStableIds();
    const { userId, email } = await seedUser();
    await appendObs({ userId, selfEmail: email, messageId: "m_a", from: "alice@example.com", fromName: "Alice A" });

    const result = await refoldActiveGmailKindProjection(userId);
    assert.deepEqual(result, { status: "skipped", reason: "no-active-projection" });
  });

  test("no-ops (up-to-date) when logic is frozen and no new observations arrived", async () => {
    seedServerEnvForStableIds();
    const { userId, email } = await seedUser();
    await appendObs({ userId, selfEmail: email, messageId: "m_a", from: "alice@example.com", fromName: "Alice A" });
    await initialActivate(userId, [email]);

    const result = await refoldActiveGmailKindProjection(userId);
    assert.deepEqual(result, { status: "skipped", reason: "up-to-date" });
    const active = await userModelReader(userId).getActivePointer();
    assert.equal(active?.activeVersion, 1);
  });

  test("refolds and activates a new version when logic is frozen and new observations arrived", async () => {
    seedServerEnvForStableIds();
    const { userId, email } = await seedUser();
    await appendObs({ userId, selfEmail: email, messageId: "m_a", from: "alice@example.com", fromName: "Alice A" });
    const initial = await initialActivate(userId, [email]);

    // A new inbound person arrives after activation -> watermark advances.
    await appendObs({
      userId,
      selfEmail: email,
      messageId: "m_b",
      from: "bob@example.com",
      fromName: "Bob B",
      occurredAt: LATER_AT,
    });

    const result = await refoldActiveGmailKindProjection(userId);
    assert.equal(result.status, "activated");
    if (result.status !== "activated") return;
    assert.equal(result.projectionVersion, 2);
    assert.notEqual(result.checksum, initial.checksum);

    const active = await userModelReader(userId).getActivePointer();
    assert.equal(active?.activeVersion, 2);
    const bob = await userModelReader(userId).getProfileByIdentity({
      kind: "email",
      value: "bob@example.com",
    });
    assert.equal(bob?.kind, "person");
  });

  test("blocks auto-activation when the classifier output drifts from the active checksum", async () => {
    seedServerEnvForStableIds();
    const { userId, email } = await seedUser();
    await appendObs({ userId, selfEmail: email, messageId: "m_a", from: "alice@example.com", fromName: "Alice A" });
    const initial = await initialActivate(userId, [email]);

    // Simulate a classifier-logic change since activation: the stored active
    // checksum no longer matches what the current fold code recomputes at the
    // active watermark.
    await db()
      .update(projectionRuns)
      .set({ checksum: `sha256:${"0".repeat(64)}` })
      .where(eq(projectionRuns.id, initial.runId));

    const result = await refoldActiveGmailKindProjection(userId);
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.equal(result.reason, "logic-drift");

    // The active pointer must be untouched — no silent re-activation.
    const active = await userModelReader(userId).getActivePointer();
    assert.equal(active?.activeRunId, initial.runId);
    assert.equal(active?.activeVersion, 1);
  });
});

async function initialActivate(
  userId: string,
  excludeEmailValues: readonly string[],
): Promise<{ runId: string; checksum: string }> {
  const sourceHighWatermark = await currentGmailWatermark(userId);
  const { run } = await startProjectionRun({
    userId,
    projectionName: USER_MODEL_PROJECTION_NAME,
    projectionVersion: 1,
    sourceHighWatermark,
  });
  const projected = await projectGmailKindProfiles({
    userId,
    projectionRunId: run.id,
    projectionVersion: 1,
    gmailHighWatermark: sourceHighWatermark.gmail,
    excludeEmailValues,
  });
  await completeProjectionRun({
    runId: run.id,
    userId,
    checksum: projected.checksum,
    completedAt: new Date(BASE_AT),
    rowCounts: { entity_profiles: projected.profileCount },
    sourceHighWatermark,
  });
  await activateProjectionVersion({
    userId,
    projectionName: USER_MODEL_PROJECTION_NAME,
    runId: run.id,
  });
  return { runId: run.id, checksum: projected.checksum };
}

async function currentGmailWatermark(userId: string) {
  const [row] = await db()
    .select({ id: observations.id, occurredAt: observations.occurredAt })
    .from(observations)
    .where(
      and(
        eq(observations.userId, userId),
        eq(observations.source, "gmail"),
        eq(observations.kind, "email_message"),
      ),
    )
    .orderBy(desc(observations.occurredAt), desc(observations.id))
    .limit(1);
  if (!row) throw new Error("no gmail observations to watermark");
  return { gmail: { lastObservationId: row.id, occurredAt: row.occurredAt.toISOString() } };
}

function seedServerEnvForStableIds(): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value;
  }
}

async function seedUser(): Promise<{ userId: string; email: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  const email = `${userId}@example.com`;
  createdUserIds.push(userId);
  await db().insert(user).values({ id: userId, name: "Test User", email });
  return { userId, email };
}

async function appendObs(args: {
  readonly userId: string;
  readonly selfEmail: string;
  readonly messageId: string;
  readonly from: string;
  readonly fromName: string;
  readonly occurredAt?: Date;
}): Promise<void> {
  const occurredAt = args.occurredAt ?? BASE_AT;
  const payload = gmailEmailMessagePayloadSchema.parse({
    provider: "gmail",
    documentId: `doc_${args.messageId}`,
    messageId: args.messageId,
    threadId: `thread_${args.messageId}`,
    accountId: "acct_test",
    isSent: false,
    subject: "Subject",
    subjectHash: `sha256:${args.messageId}`,
    headers: {
      messageId: `<${args.messageId}@example.com>`,
      inReplyTo: null,
      references: [],
      listId: null,
      listUnsubscribe: null,
      replyTo: null,
      deliveredTo: null,
      autoSubmitted: null,
      precedence: null,
    },
  });

  await appendObservationFamilyMember({
    userId: args.userId,
    source: "gmail",
    kind: "email_message",
    occurredAt,
    familyKey: `gmail:message:acct_test:${args.messageId}`,
    evidenceHash: `sha256:${args.messageId}`,
    subjectIdentity: { kind: "email", value: args.from },
    objectIdentity: null,
    participants: {
      items: [
        { identity: { kind: "email", value: args.from }, role: "from", displayName: args.fromName },
        { identity: { kind: "email", value: args.selfEmail }, role: "to", displayName: "Self" },
      ],
      recipientCount: 1,
    },
    payload,
    schemaVersion: 1,
    reducerVersion: 1,
  });
}
