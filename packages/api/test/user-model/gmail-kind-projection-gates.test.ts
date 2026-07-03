import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { gmailEmailMessagePayloadSchema, USER_MODEL_PROJECTION_NAME } from "@alfred/contracts";
import { inArray } from "drizzle-orm";
import {
  activateProjectionVersion,
  appendObservationFamilyMember,
  completeProjectionRun,
  projectGmailKindProfiles,
  startProjectionRun,
  userModelReader,
} from "../../src/modules/user-model";
import { resolveSenderKind } from "../../src/modules/triage";

/**
 * Local activation-gate rehearsal for the Gmail kind projection (#218 PR G).
 *
 * Encodes the runbook's local validation gates as a single re-runnable artifact:
 * seed fixtures covering every classification band, then drive the real
 * fold -> complete -> activate -> reader -> resolveSenderKind chain and assert:
 *
 *  - Gate 1  replay determinism: the same input folds to the same checksum twice.
 *  - Gate 4  list aliases (List-Id) classify `group`, never person-scored.
 *  - Gate 5  noreply/notification senders classify `service`, never person-scored.
 *  - Gate 6  top person-scored profiles exclude lists/services; self is excluded.
 *  - Gate 10 the active reader returns the activated rows.
 *  - Consumer bar: `resolveSenderKind` demotes only confident group/service;
 *    a header-less weak group alias (`unknown`, 0.58) never demotes — absence of
 *    confident data does not demote person treatment.
 *
 * The activation-refusal gate (gate 9, non-`completed` runs) lives in
 * `test/contracts/user-model-writers.test.ts`.
 */

const ID_PREFIX = "test-gmail-kind-gates-";
const OCCURRED_AT = new Date("2026-06-30T08:00:00.000Z");
const TEST_ENTITY_ID_SECRET = "stable namespace secret for tests";
const SELF_EMAIL = "yash@example.com";
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

describe("Gmail kind projection activation gates (DB-backed)", { skip: SKIP_DB }, () => {
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("folds deterministically, activates, and demotes only confident list/service senders", async () => {
    seedServerEnvForStableIds();
    const userId = await seedUser();

    // List alias with authoritative List-Id header -> confident group (gate 4).
    await appendGmailObservation({
      userId,
      messageId: "msg_list",
      from: "engineering@oliv.ai",
      fromName: "Engineering",
      listId: "Engineering <engineering.oliv.ai>",
      subject: "Weekly eng digest",
    });
    // noreply on a service domain -> confident service (gate 5).
    await appendGmailObservation({
      userId,
      messageId: "msg_service",
      from: "noreply@github.com",
      fromName: "GitHub",
      subject: "[alfred] PR opened",
    });
    // Header-less group alias -> weak unknown/bestGuess=group; must NOT demote.
    await appendGmailObservation({
      userId,
      messageId: "msg_weak_group",
      from: "team@startup.example",
      fromName: "Team",
      subject: "Standup notes",
    });
    // Plain individual mailbox -> person (gate 6).
    await appendGmailObservation({
      userId,
      messageId: "msg_person",
      from: "alice@example.com",
      fromName: "Alice Example",
      subject: "Project update",
    });

    // --- Gate 1: replay determinism. A completed version is immutable, so a
    // faithful replay folds the SAME observations under a fresh version and
    // compares checksums (the checksum is over stable entity ids + pure
    // classification, so it is version-independent).
    const first = await foldOnce(userId, 1);
    const second = await foldOnce(userId, 2);
    assert.equal(first.checksum, second.checksum, "replay checksum diverged");
    assert.equal(first.profileCount, second.profileCount);
    assert.match(first.checksum, /^sha256:[a-f0-9]{64}$/);
    // 4 external senders; self (a `to` participant) is excluded from profiles.
    assert.equal(first.profileCount, 4);

    // --- Activate the latest completed run.
    await activateProjectionVersion({
      userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      runId: second.runId,
    });

    // --- Gate 10: the active reader returns the activated classification.
    const reader = userModelReader(userId);
    const group = await reader.getProfileByIdentity({
      kind: "email",
      value: "engineering@oliv.ai",
    });
    assert.equal(group?.kind, "group");
    const service = await reader.getProfileByIdentity({
      kind: "email",
      value: "noreply@github.com",
    });
    assert.equal(service?.kind, "service");
    const weakGroup = await reader.getProfileByIdentity({
      kind: "email",
      value: "team@startup.example",
    });
    assert.equal(weakGroup?.kind, "unknown");
    const person = await reader.getProfileByIdentity({ kind: "email", value: "alice@example.com" });
    assert.equal(person?.kind, "person");
    // Gate 6: self address never lands as a scored profile.
    const self = await reader.getProfileByIdentity({ kind: "email", value: SELF_EMAIL });
    assert.equal(self, null);

    // --- Consumer bar: resolveSenderKind demotes confident group/service only.
    const groupSignal = await resolveSenderKind(userId, "engineering@oliv.ai");
    assert.equal(groupSignal?.kind, "group");
    assert.ok((groupSignal?.confidence ?? 0) >= 0.8);

    const serviceSignal = await resolveSenderKind(userId, "noreply@github.com");
    assert.equal(serviceSignal?.kind, "service");

    // Weak header-less alias and a person are never demoted (absence-does-not-demote).
    assert.equal(await resolveSenderKind(userId, "team@startup.example"), null);
    assert.equal(await resolveSenderKind(userId, "alice@example.com"), null);
  });
});

async function foldOnce(
  userId: string,
  projectionVersion: number,
): Promise<{ runId: string; checksum: string; profileCount: number }> {
  const { run } = await startProjectionRun({
    userId,
    projectionName: USER_MODEL_PROJECTION_NAME,
    projectionVersion,
  });
  const projected = await projectGmailKindProfiles({
    userId,
    projectionRunId: run.id,
    projectionVersion,
    computedAt: OCCURRED_AT,
    excludeEmailValues: [SELF_EMAIL],
  });
  await completeProjectionRun({
    runId: run.id,
    userId,
    checksum: projected.checksum,
    rowCounts: { entity_profiles: projected.profileCount },
    completedAt: OCCURRED_AT,
  });
  return { runId: run.id, checksum: projected.checksum, profileCount: projected.profileCount };
}

function seedServerEnvForStableIds(): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value;
  }
}

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

async function appendGmailObservation(args: {
  readonly userId: string;
  readonly messageId: string;
  readonly from: string;
  readonly fromName: string;
  readonly listId?: string;
  readonly subject: string;
}): Promise<void> {
  const payload = gmailEmailMessagePayloadSchema.parse({
    provider: "gmail",
    documentId: `doc_${args.messageId}`,
    messageId: args.messageId,
    threadId: `thread_${args.messageId}`,
    accountId: "acct_test",
    isSent: false,
    subject: args.subject,
    subjectHash: `sha256:${args.messageId}`,
    headers: {
      messageId: `<${args.messageId}@example.com>`,
      inReplyTo: null,
      references: [],
      listId: args.listId ?? null,
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
    occurredAt: OCCURRED_AT,
    familyKey: `gmail:message:acct_test:${args.messageId}`,
    evidenceHash: `sha256:${args.messageId}`,
    subjectIdentity: { kind: "email", value: args.from },
    objectIdentity: null,
    participants: {
      items: [
        { identity: { kind: "email", value: args.from }, role: "from", displayName: args.fromName },
        { identity: { kind: "email", value: SELF_EMAIL }, role: "to", displayName: "Yash" },
      ],
      recipientCount: 1,
      ...(args.listId ? { listId: args.listId } : {}),
    },
    payload,
    schemaVersion: 1,
    reducerVersion: 1,
  });
}
