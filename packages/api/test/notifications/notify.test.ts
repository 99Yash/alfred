import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { inArray, like } from "drizzle-orm";

import { notify } from "../../src/modules/notifications/notify";
import { _setResendClientForTests } from "../../src/modules/notifications/resend-client";

function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}

const SKIP = hasDatabaseUrl() ? false : "DATABASE_URL not set — skipping DB-backed test";
const ID_PREFIX = "test-notify-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Notify Test User", email: `${userId}@example.test` });
  return userId;
}

describe("notify (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    _setResendClientForTests(undefined);
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("passes Alfred's idempotency key to Resend's provider-level option", async () => {
    const userId = await seedUser();
    const calls: Array<{
      payload: { headers?: Record<string, string> };
      options?: { idempotencyKey?: string };
    }> = [];
    const fakeClient = {
      emails: {
        send: async (
          payload: { headers?: Record<string, string> },
          options?: { idempotencyKey?: string },
        ) => {
          calls.push({ payload, options });
          return { data: { id: "resend_test" }, error: null };
        },
      },
    } as unknown as Parameters<typeof _setResendClientForTests>[0];
    _setResendClientForTests(fakeClient);

    const idempotencyKey = `health_alert:${userId}:attention_share_7d:2026-06-27`;
    const result = await notify({
      userId,
      kind: "health_alert",
      idempotencyKey,
      subject: "Health alert",
      html: "<p>Health alert</p>",
      text: "Health alert",
    });

    assert.equal(result.status, "sent");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.options?.idempotencyKey, idempotencyKey);
    assert.equal(calls[0]?.payload.headers?.["X-Alfred-Idempotency-Key"], idempotencyKey);
  });
});
