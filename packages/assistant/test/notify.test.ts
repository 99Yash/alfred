import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { send } from "../src/delivery";
import { _setResendClientForTests } from "../src/delivery/resend-client";
import { dbBackedSkip } from "./support/db-backed";

const SKIP = dbBackedSkip("database");
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

/** A counting fake Resend client, so a test can assert at-most-once delivery. */
function fakeSentClient(): {
  client: Parameters<typeof _setResendClientForTests>[0];
  calls: Array<{
    payload: { headers?: Record<string, string> | undefined };
    options?: { idempotencyKey?: string } | undefined;
  }>;
} {
  const calls: Array<{
    payload: { headers?: Record<string, string> | undefined };
    options?: { idempotencyKey?: string } | undefined;
  }> = [];
  // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- boundary cast: source type is structurally incompatible with target
  const client = {
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
  return { client, calls };
}

describe("delivery.send (DB-backed)", { skip: SKIP }, () => {
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
    const { client, calls } = fakeSentClient();
    _setResendClientForTests(client);

    const idempotencyKey = `health_alert:${userId}:attention_share_7d:2026-06-27`;
    const result = await send({
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

  test("a second send with the same key is a duplicate — at most one email per key", async () => {
    const userId = await seedUser();
    const { client, calls } = fakeSentClient();
    _setResendClientForTests(client);

    const args = {
      userId,
      kind: "health_alert" as const,
      idempotencyKey: `health_alert:${userId}:attention_share_7d:2026-06-28`,
      subject: "Health alert",
      html: "<p>Health alert</p>",
      text: "Health alert",
    };

    const first = await send(args);
    const second = await send(args);

    assert.equal(first.status, "sent");
    assert.equal(second.status, "duplicate");
    // The unique index absorbed the retry: Resend saw the send exactly once.
    assert.equal(calls.length, 1);
  });

  test("a Resend error surfaces as a failed result", async () => {
    const userId = await seedUser();
    /* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion */
    const failingClient = {
      emails: {
        send: async () => ({
          data: null,
          error: { name: "rate_limit_exceeded", message: "slow down" },
        }),
      },
    } as unknown as Parameters<typeof _setResendClientForTests>[0];
    /* eslint-enable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion */
    _setResendClientForTests(failingClient);

    const result = await send({
      userId,
      kind: "health_alert",
      idempotencyKey: `health_alert:${userId}:attention_share_7d:2026-06-29`,
      subject: "Health alert",
      html: "<p>Health alert</p>",
      text: "Health alert",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.error, /rate_limit_exceeded/);
    }
  });
});
