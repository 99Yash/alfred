import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Elysia } from "elysia";

import { errorHandler } from "../../src/middleware/error-handler";
import { assertGmailPushOidcConfigured } from "../../src/modules/integrations/gmail-push-config";
import {
  makeGmailWebhookRoutes,
  verifyPubSubOidcForGmailWebhook,
} from "../../src/modules/integrations/gmail-webhook";

function gmailEnvelope(emailAddress: string) {
  return {
    message: {
      messageId: "msg_123",
      data: Buffer.from(JSON.stringify({ emailAddress, historyId: "hist_123" })).toString("base64"),
    },
    subscription: "projects/example/subscriptions/gmail-push",
  };
}

describe("verifyPubSubOidcForGmailWebhook", () => {
  test("accepts a configured valid Pub/Sub OIDC token", async () => {
    const calls: Array<{ token: string; audience: string }> = [];

    const claims = await verifyPubSubOidcForGmailWebhook("Bearer jwt_123", {
      config: {
        nodeEnv: "production",
        audience: "https://alfred.example.com/webhooks/gmail",
        expectedServiceAccount: "pubsub-push@example.iam.gserviceaccount.com",
      },
      verifyJwt: async (token, audience) => {
        calls.push({ token, audience });
        return { email: "pubsub-push@example.iam.gserviceaccount.com", email_verified: true };
      },
    });

    assert.equal(claims.email, "pubsub-push@example.iam.gserviceaccount.com");
    assert.deepEqual(calls, [
      {
        token: "jwt_123",
        audience: "https://alfred.example.com/webhooks/gmail",
      },
    ]);
  });

  test("rejects missing, invalid, or unexpected configured tokens", async () => {
    await assert.rejects(
      verifyPubSubOidcForGmailWebhook(null, {
        config: {
          nodeEnv: "production",
          audience: "https://alfred.example.com/webhooks/gmail",
          expectedServiceAccount: "pubsub-push@example.iam.gserviceaccount.com",
        },
      }),
      /missing Authorization bearer token/,
    );

    await assert.rejects(
      verifyPubSubOidcForGmailWebhook("Bearer bad", {
        config: {
          nodeEnv: "production",
          audience: "https://alfred.example.com/webhooks/gmail",
          expectedServiceAccount: "pubsub-push@example.iam.gserviceaccount.com",
        },
        verifyJwt: async () => {
          throw new Error("jwt invalid");
        },
      }),
      /jwt invalid/,
    );

    await assert.rejects(
      verifyPubSubOidcForGmailWebhook("Bearer jwt_123", {
        config: {
          nodeEnv: "production",
          audience: "https://alfred.example.com/webhooks/gmail",
          expectedServiceAccount: "pubsub-push@example.iam.gserviceaccount.com",
        },
        verifyJwt: async () => ({ email: "other@example.iam.gserviceaccount.com" }),
      }),
      /unexpected OIDC email/,
    );

    await assert.rejects(
      verifyPubSubOidcForGmailWebhook("Bearer jwt_123", {
        config: {
          nodeEnv: "production",
          audience: "https://alfred.example.com/webhooks/gmail",
          expectedServiceAccount: "pubsub-push@example.iam.gserviceaccount.com",
        },
        verifyJwt: async () => ({ email: "pubsub-push@example.iam.gserviceaccount.com" }),
      }),
      /OIDC email claim is not verified/,
    );
  });

  test("fails closed in production when the Pub/Sub audience is missing", async () => {
    await assert.rejects(
      verifyPubSubOidcForGmailWebhook(null, {
        config: { nodeEnv: "production" },
      }),
      /GOOGLE_PUBSUB_AUDIENCE is required in production/,
    );
  });

  test("fails closed in production when the expected service account is missing", async () => {
    assert.throws(
      () =>
        assertGmailPushOidcConfigured({
          nodeEnv: "production",
          audience: "https://alfred.example.com/webhooks/gmail",
        }),
      /GOOGLE_PUBSUB_SERVICE_ACCOUNT is required in production/,
    );

    await assert.rejects(
      verifyPubSubOidcForGmailWebhook("Bearer jwt_123", {
        config: {
          nodeEnv: "production",
          audience: "https://alfred.example.com/webhooks/gmail",
        },
        verifyJwt: async () => ({ email: "pubsub-push@example.iam.gserviceaccount.com" }),
      }),
      /GOOGLE_PUBSUB_SERVICE_ACCOUNT is required in production/,
    );
  });

  test("keeps the explicit local/test opt-out path", async () => {
    assert.deepEqual(
      await verifyPubSubOidcForGmailWebhook(null, {
        config: { nodeEnv: "development" },
      }),
      {},
    );
    assert.deepEqual(
      await verifyPubSubOidcForGmailWebhook(null, {
        config: { nodeEnv: "test" },
      }),
      {},
    );
  });
});

describe("/webhooks/gmail", () => {
  test("returns 401 and does not enqueue when OIDC verification fails", async () => {
    let lookedUpCredential = false;
    let enqueued = false;
    const app = new Elysia({ normalize: "typebox" }).use(errorHandler).use(
      makeGmailWebhookRoutes({
        verifyOidc: async () => {
          throw new Error("bad token");
        },
        findCredential: async () => {
          lookedUpCredential = true;
          return { id: "cred_123", userId: "user_123" };
        },
        getQueue: () => ({
          add: async () => {
            enqueued = true;
          },
        }),
      }),
    );

    const res = await app.handle(
      new Request("http://localhost/webhooks/gmail", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(gmailEnvelope("yash@example.com")),
      }),
    );

    assert.equal(res.status, 401);
    assert.equal(lookedUpCredential, false);
    assert.equal(enqueued, false);
    assert.deepEqual(await res.json(), {
      error: "Invalid OIDC token",
      code: "UNAUTHORIZED",
    });
  });

  test("enqueues a poll job after OIDC verification and credential lookup pass", async () => {
    const enqueued: unknown[] = [];
    const app = new Elysia({ normalize: "typebox" }).use(errorHandler).use(
      makeGmailWebhookRoutes({
        verifyOidc: async () => ({ email: "pubsub-push@example.iam.gserviceaccount.com" }),
        findCredential: async (emailAddress) => {
          assert.equal(emailAddress, "yash@example.com");
          return { id: "cred_123", userId: "user_123" };
        },
        getQueue: () => ({
          add: async (...args) => {
            enqueued.push(args);
          },
        }),
      }),
    );

    const res = await app.handle(
      new Request("http://localhost/webhooks/gmail", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer jwt_123",
        },
        body: JSON.stringify(gmailEnvelope("yash@example.com")),
      }),
    );

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, credentialId: "cred_123" });
    assert.deepEqual(enqueued, [
      [
        "gmail.poll_recent",
        { kind: "gmail.poll_recent", credentialId: "cred_123" },
        { deduplication: { id: "gmail.poll_recent.cred_123", ttl: 30_000 } },
      ],
    ]);
  });
});
