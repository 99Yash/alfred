import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { verifyPubSubOidcForGmailWebhook } from "../../src/modules/integrations/gmail-webhook";

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
        config: { nodeEnv: "production", audience: "https://alfred.example.com/webhooks/gmail" },
      }),
      /missing Authorization bearer token/,
    );

    await assert.rejects(
      verifyPubSubOidcForGmailWebhook("Bearer bad", {
        config: { nodeEnv: "production", audience: "https://alfred.example.com/webhooks/gmail" },
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
  });

  test("fails closed in production when the Pub/Sub audience is missing", async () => {
    await assert.rejects(
      verifyPubSubOidcForGmailWebhook(null, {
        config: { nodeEnv: "production" },
      }),
      /GOOGLE_PUBSUB_AUDIENCE is required in production/,
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
