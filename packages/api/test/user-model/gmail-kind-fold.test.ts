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
  type InsertObservationResult,
} from "../../src/modules/user-model";

const ID_PREFIX = "test-gmail-kind-fold-";
const OCCURRED_AT = new Date("2026-06-30T08:00:00.000Z");
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

describe("projectGmailKindProfiles (DB-backed)", { skip: SKIP_DB }, () => {
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("writes kind-only profiles and resolves them through the active reader", async () => {
    seedServerEnvForStableIds();
    const userId = await seedUser();

    await appendGmailObservation({
      userId,
      documentId: "doc_list",
      messageId: "gmail_msg_list",
      from: "engineering@oliv.ai",
      fromName: "Engineering",
      to: "yash@example.com",
      listId: "Engineering <engineering.oliv.ai>",
      subject: "Anthropic via Engineering",
    });
    await appendGmailObservation({
      userId,
      documentId: "doc_person",
      messageId: "gmail_msg_person",
      from: "alice@example.com",
      fromName: "Alice Example",
      to: "yash@example.com",
      subject: "Project update",
    });

    const { run } = await startProjectionRun({
      userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      projectionVersion: 1,
    });
    const projected = await projectGmailKindProfiles({
      userId,
      projectionRunId: run.id,
      projectionVersion: 1,
      computedAt: OCCURRED_AT,
      excludeEmailValues: ["yash@example.com"],
    });
    assert.equal(projected.profileCount, 2);
    assert.match(projected.checksum, /^sha256:[a-f0-9]{64}$/);

    await completeProjectionRun({
      runId: run.id,
      userId,
      checksum: projected.checksum,
      rowCounts: { entity_profiles: projected.profileCount },
      completedAt: OCCURRED_AT,
    });
    await activateProjectionVersion({
      userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      runId: run.id,
    });

    const reader = userModelReader(userId);
    const engineering = await reader.getProfileByIdentity({
      kind: "email",
      value: "engineering@oliv.ai",
    });
    assert.equal(engineering?.kind, "group");
    assert.equal(engineering.displayName, "Engineering");
    assert.equal(engineering.provenance.classification?.evidenceCodes.includes("gmail:list_id"), true);

    const alice = await reader.getProfileByIdentity({ kind: "email", value: "alice@example.com" });
    assert.equal(alice?.kind, "person");

    const self = await reader.getProfileByIdentity({ kind: "email", value: "yash@example.com" });
    assert.equal(self, null);
  });
});

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
  readonly documentId: string;
  readonly messageId: string;
  readonly from: string;
  readonly fromName: string;
  readonly to: string;
  readonly listId?: string;
  readonly subject: string;
}): Promise<InsertObservationResult> {
  const payload = gmailEmailMessagePayloadSchema.parse({
    provider: "gmail",
    documentId: args.documentId,
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
      replyTo: null,
      deliveredTo: null,
      autoSubmitted: null,
      precedence: null,
    },
  });

  return appendObservationFamilyMember({
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
        {
          identity: { kind: "email", value: args.from },
          role: "from",
          displayName: args.fromName,
        },
        { identity: { kind: "email", value: args.to }, role: "to", displayName: "Yash" },
      ],
      recipientCount: 1,
      ...(args.listId ? { listId: args.listId } : {}),
    },
    payload,
    schemaVersion: 1,
    reducerVersion: 1,
  });
}
