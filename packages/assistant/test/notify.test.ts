import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { emailSends, user } from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";
import type { Resend } from "resend";

import { send } from "../src/delivery";
import { _setResendClientForTests } from "../src/delivery/resend-client";
import { dbBackedSkip } from "./support/db-backed";
import { asTestDouble } from "./support/test-double";

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
interface SentClientCalls {
  client: Parameters<typeof _setResendClientForTests>[0];
  calls: Array<{
    payload: { headers?: Record<string, string> | undefined };
    options?: { idempotencyKey?: string } | undefined;
  }>;
}

function fakeSentClient(): SentClientCalls {
  const calls: Array<{
    payload: { headers?: Record<string, string> | undefined };
    options?: { idempotencyKey?: string } | undefined;
  }> = [];

  // The code under test calls only `emails.send`.
  const client = asTestDouble<Resend>({
    emails: asTestDouble<Resend["emails"]>({
      send: async (...[payload, options]: Parameters<Resend["emails"]["send"]>) => {
        calls.push({ payload, options });

        return { data: { id: "resend_test" }, error: null, headers: null };
      },
    }),
  });

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
    assert.equal(calls[0].payload.headers?.["X-Alfred-Idempotency-Key"], idempotencyKey);
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
    // The unique index absorbed the retry.
    assert.equal(calls.length, 1);
  });

  test("a Resend error surfaces as a failed result", async () => {
    const userId = await seedUser();

    // A stub client that implements only `emails.send` stands in for the Resend client.
    const failingClient = asTestDouble<Resend>({
      emails: asTestDouble<Resend["emails"]>({
        send: async () => ({
          data: null,
          error: { name: "rate_limit_exceeded", message: "slow down", statusCode: null },
          headers: null,
        }),
      }),
    });

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

    assert.match(result.error, /rate_limit_exceeded/);
  });
  // SM-02 in docs/reference/state-machines.md: `sent` is terminal, and a provider reply that proves
  // an earlier send landed records `sent`, never `failed`.

  function resendError(
    name: "invalid_idempotent_request" | "concurrent_idempotent_requests" | "rate_limit_exceeded",
  ) {
    return { data: null, error: { name, message: name, statusCode: 409 }, headers: null };
  }

  async function rowStatus(userId: string, idempotencyKey: string): Promise<string | undefined> {
    const [row] = await db()
      .select({ status: emailSends.status })
      .from(emailSends)
      .where(and(eq(emailSends.userId, userId), eq(emailSends.idempotencyKey, idempotencyKey)));

    return row?.status;
  }

  function healthAlert(userId: string, day: string) {
    return {
      userId,
      kind: "health_alert" as const,
      idempotencyKey: `health_alert:${userId}:attention_share_7d:${day}`,
      subject: "Health alert",
      html: "<p>Health alert</p>",
      text: "Health alert",
    };
  }

  test("a re-rendered retry that Resend refuses as a reused key records sent", async () => {
    const userId = await seedUser();
    const args = healthAlert(userId, "2026-07-01");

    _setResendClientForTests(
      asTestDouble<Resend>({
        emails: asTestDouble<Resend["emails"]>({
          send: async () => resendError("invalid_idempotent_request"),
        }),
      }),
    );

    const result = await send(args);

    assert.equal(result.status, "sent");
    assert.equal(await rowStatus(userId, args.idempotencyKey), "sent");
  });

  test("a caller that loses at the provider cannot overwrite a sent row with failed", async () => {
    const userId = await seedUser();
    const args = healthAlert(userId, "2026-07-02");

    // The winner finishes while this caller waits on the provider.
    _setResendClientForTests(
      asTestDouble<Resend>({
        emails: asTestDouble<Resend["emails"]>({
          send: async () => {
            await db()
              .update(emailSends)
              .set({ status: "sent", sentAt: new Date() })
              .where(
                and(
                  eq(emailSends.userId, userId),
                  eq(emailSends.idempotencyKey, args.idempotencyKey),
                ),
              );

            return resendError("rate_limit_exceeded");
          },
        }),
      }),
    );

    const result = await send(args);

    assert.equal(result.status, "failed");
    assert.equal(await rowStatus(userId, args.idempotencyKey), "sent");
  });

  test("a key another caller holds at Resend is a duplicate, not a failure", async () => {
    const userId = await seedUser();
    const args = healthAlert(userId, "2026-07-03");

    _setResendClientForTests(
      asTestDouble<Resend>({
        emails: asTestDouble<Resend["emails"]>({
          send: async () => resendError("concurrent_idempotent_requests"),
        }),
      }),
    );

    const result = await send(args);

    assert.equal(result.status, "duplicate");
    assert.notEqual(await rowStatus(userId, args.idempotencyKey), "failed");
  });
});
