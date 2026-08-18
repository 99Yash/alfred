import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Elysia } from "elysia";

import { errorHandler } from "@alfred/http";
import { assertGmailPushOidcConfigured } from "@alfred/integrations/google";
import {
  makeGmailWebhookRoutes,
  parseGmailPushEnvelope,
  verifyPubSubOidcForGmailWebhook,
} from "../../src/connections/gmail-webhook";

function gmailEnvelope(emailAddress: string) {
  return {
    message: {
      messageId: "msg_123",
      data: Buffer.from(JSON.stringify({ emailAddress, historyId: "hist_123" })).toString("base64"),
    },
    subscription: "projects/example/subscriptions/gmail-push",
  };
}

/** Base64 of an arbitrary notification, so a case can state its own payload. */
function encodeNotification(notification: unknown) {
  return Buffer.from(JSON.stringify(notification)).toString("base64");
}

describe("parseGmailPushEnvelope", () => {
  test("reads a well-formed envelope", () => {
    assert.deepEqual(parseGmailPushEnvelope(gmailEnvelope("yash@example.com")), {
      messageId: "msg_123",
      notification: { emailAddress: "yash@example.com", historyId: "hist_123" },
    });
  });

  test("accepts the JSON number historyId that Google's push payload sends", () => {
    assert.deepEqual(
      parseGmailPushEnvelope({
        message: {
          messageId: "msg_123",
          data: encodeNotification({ emailAddress: "yash@example.com", historyId: 9876543210 }),
        },
      }),
      {
        messageId: "msg_123",
        notification: { emailAddress: "yash@example.com", historyId: 9876543210 },
      },
    );
  });

  test("drops a wrong-typed messageId without blocking the notification", () => {
    assert.deepEqual(
      parseGmailPushEnvelope({
        message: {
          messageId: 42,
          data: encodeNotification({ emailAddress: "yash@example.com", historyId: "hist_123" }),
        },
      }),
      {
        messageId: undefined,
        notification: { emailAddress: "yash@example.com", historyId: "hist_123" },
      },
    );
  });

  test("answers for a null body instead of throwing", () => {
    assert.deepEqual(parseGmailPushEnvelope(null), {
      messageId: undefined,
      notification: null,
    });
  });

  test("answers for a body that is not an object", () => {
    for (const body of ["hello", 42, [], undefined, true]) {
      assert.deepEqual(
        parseGmailPushEnvelope(body),
        { messageId: undefined, notification: null },
        `body ${JSON.stringify(body) ?? "undefined"}`,
      );
    }
  });

  test("answers for an envelope whose message or data cannot be read", () => {
    assert.deepEqual(parseGmailPushEnvelope({}), {
      messageId: undefined,
      notification: null,
    });
    assert.deepEqual(parseGmailPushEnvelope({ message: {} }), {
      messageId: undefined,
      notification: null,
    });
    assert.deepEqual(parseGmailPushEnvelope({ message: { messageId: "msg_123" } }), {
      messageId: "msg_123",
      notification: null,
    });
    assert.deepEqual(parseGmailPushEnvelope({ message: 42 }), {
      messageId: undefined,
      notification: null,
    });
  });

  test("answers for data that is not base64 or does not hold JSON", () => {
    assert.deepEqual(
      parseGmailPushEnvelope({ message: { messageId: "msg_123", data: "!!! not base64 !!!" } }),
      { messageId: "msg_123", notification: null },
    );
    assert.deepEqual(
      parseGmailPushEnvelope({
        message: { messageId: "msg_123", data: Buffer.from("not json").toString("base64") },
      }),
      { messageId: "msg_123", notification: null },
    );
  });

  test("refuses each notification gate separately", () => {
    const rejected: unknown[] = [
      { historyId: "hist_123" },
      { emailAddress: "yash@example.com" },
      { emailAddress: "", historyId: "hist_123" },
      { emailAddress: "yash@example.com", historyId: "" },
      { emailAddress: "yash@example.com", historyId: 0 },
      { emailAddress: 123, historyId: "hist_123" },
      { emailAddress: "yash@example.com", historyId: null },
    ];

    for (const notification of rejected) {
      assert.deepEqual(
        parseGmailPushEnvelope({
          message: { messageId: "msg_123", data: encodeNotification(notification) },
        }),
        { messageId: "msg_123", notification: null },
        `notification ${JSON.stringify(notification)}`,
      );
    }
  });

  test("passes through the envelope and message fields nothing reads", () => {
    assert.deepEqual(
      parseGmailPushEnvelope({
        subscription: "projects/example/subscriptions/gmail-push",
        unexpectedTopLevelKey: "ignored",
        message: {
          messageId: "msg_123",
          publishTime: "2026-08-13T09:00:00.000Z",
          attributes: { region: "us-central1" },
          data: encodeNotification({ emailAddress: "yash@example.com", historyId: "hist_123" }),
        },
      }),
      {
        messageId: "msg_123",
        notification: { emailAddress: "yash@example.com", historyId: "hist_123" },
      },
    );
  });
});

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
      /GOOGLE_PUBSUB_AUDIENCE is required when Gmail push is enabled/,
    );
  });

  test("fails closed in production when the expected service account is missing", async () => {
    assert.throws(
      () =>
        assertGmailPushOidcConfigured({
          nodeEnv: "production",
          audience: "https://alfred.example.com/webhooks/gmail",
        }),
      /GOOGLE_PUBSUB_SERVICE_ACCOUNT is required when Gmail push is enabled/,
    );

    await assert.rejects(
      verifyPubSubOidcForGmailWebhook("Bearer jwt_123", {
        config: {
          nodeEnv: "production",
          audience: "https://alfred.example.com/webhooks/gmail",
        },
        verifyJwt: async () => ({ email: "pubsub-push@example.iam.gserviceaccount.com" }),
      }),
      /GOOGLE_PUBSUB_SERVICE_ACCOUNT is required when Gmail push is enabled/,
    );
  });

  test("fails closed outside production when Gmail push is configured", async () => {
    await assert.rejects(
      verifyPubSubOidcForGmailWebhook(null, {
        config: {
          nodeEnv: "development",
          pushTopic: "projects/example/topics/gmail-push",
        },
      }),
      /GOOGLE_PUBSUB_AUDIENCE is required when Gmail push is enabled/,
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

/**
 * A route harness whose OIDC arm always passes, so every case below isolates the
 * body. It records the two side effects a malformed body must never reach.
 */
function gmailWebhookHarness() {
  const seen: {
    credentialLookups: string[];
    enqueued: unknown[][];
    receipts: unknown[];
  } = {
    credentialLookups: [],
    enqueued: [],
    receipts: [],
  };
  const app = new Elysia({ normalize: "typebox" }).use(errorHandler).use(
    makeGmailWebhookRoutes({
      verifyOidc: async () => ({ email: "pubsub-push@example.iam.gserviceaccount.com" }),
      findCredential: async (emailAddress) => {
        seen.credentialLookups.push(emailAddress);
        return { id: "cred_123", userId: "user_123" };
      },
      getQueue: () => ({
        add: async (...args) => {
          seen.enqueued.push(args);
        },
      }),
      persistReceipt: async (args) => {
        seen.receipts.push(args);
        return { inserted: true };
      },
    }),
  );
  const post = (init: { body?: string; headers?: Record<string, string> }) =>
    app.handle(
      new Request("http://localhost/webhooks/gmail", {
        method: "POST",
        headers: init.headers ?? {
          "content-type": "application/json",
          authorization: "Bearer jwt_123",
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
    );
  return { seen, post };
}

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
        persistReceipt: async () => ({ inserted: true }),
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
    const receipts: unknown[] = [];
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
        persistReceipt: async (args) => {
          receipts.push(args);
          return { inserted: true };
        },
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
    assert.deepEqual(await res.json(), { ok: true, credentialId: "cred_123", receiptPersisted: true });
    assert.deepEqual(enqueued, [
      [
        "gmail.poll_recent",
        { kind: "gmail.poll_recent", credentialId: "cred_123", pushHistoryId: "hist_123" },
        { deduplication: { id: "gmail.poll_recent.cred_123", ttl: 30_000 } },
      ],
    ]);
    assert.equal(receipts.length, 1);
    assert.equal((receipts[0] as { providerDeliveryId: string }).providerDeliveryId, "msg_123");
  });

  test("answers 200 bad-payload for an undecodable message and reaches neither side effect", async () => {
    const { seen, post } = gmailWebhookHarness();

    const res = await post({
      body: JSON.stringify({
        message: {
          messageId: "msg_bad",
          data: Buffer.from("not json at all").toString("base64"),
        },
      }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: "bad-payload" });
    assert.deepEqual(seen.credentialLookups, []);
    assert.deepEqual(seen.enqueued, []);
  });

  test("answers 200 bad-payload for a JSON null body", async () => {
    const { seen, post } = gmailWebhookHarness();

    const res = await post({ body: "null" });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: "bad-payload" });
    assert.deepEqual(seen.enqueued, []);
  });

  test("answers 200 bad-payload for a body whose Pub/Sub fields hold the wrong JSON types", async () => {
    const { seen, post } = gmailWebhookHarness();

    const res = await post({ body: JSON.stringify({ message: 42 }) });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: "bad-payload" });
    assert.deepEqual(seen.enqueued, []);
  });

  // Pins the handler arm only, not the whole request path. `app.handle()` is the
  // web-standard adapter; under the production `@elysiajs/node` adapter an absent
  // body raises Elysia `PARSE` and answers 400 before the handler runs, exactly
  // as base `315823c5` does. Campaign item 209 owns that adapter divergence and
  // item 210 owns the 400 arm itself.
  test("answers 200 bad-payload for an absent body once the handler sees it", async () => {
    const { seen, post } = gmailWebhookHarness();

    const res = await post({ headers: { authorization: "Bearer jwt_123" } });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: "bad-payload" });
    assert.deepEqual(seen.enqueued, []);
  });

  test("keeps enqueuing when the envelope carries fields the handler does not read", async () => {
    const { seen, post } = gmailWebhookHarness();

    const res = await post({
      body: JSON.stringify({
        ...gmailEnvelope("yash@example.com"),
        message: {
          ...gmailEnvelope("yash@example.com").message,
          publishTime: "2026-08-13T09:00:00.000Z",
          attributes: { region: "us-central1" },
        },
        unexpectedTopLevelKey: "ignored",
      }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, credentialId: "cred_123", receiptPersisted: true });
    assert.deepEqual(seen.credentialLookups, ["yash@example.com"]);
    assert.equal(seen.enqueued.length, 1);
  });

  test("#560a: duplicate Pub/Sub deliveries create at most one receipt", async () => {
    const receipts: Array<{ inserted: boolean }> = [];
    let callCount = 0;
    const app = new Elysia({ normalize: "typebox" }).use(errorHandler).use(
      makeGmailWebhookRoutes({
        verifyOidc: async () => ({ email: "pubsub-push@example.iam.gserviceaccount.com" }),
        findCredential: async () => ({ id: "cred_123", userId: "user_123" }),
        getQueue: () => ({
          add: async () => {
            callCount++;
          },
        }),
        persistReceipt: async () => {
          // Simulate the DB unique index: first insert succeeds, second is a no-op
          const inserted = receipts.length === 0;
          receipts.push({ inserted });
          return { inserted };
        },
      }),
    );

    const body = JSON.stringify(gmailEnvelope("yash@example.com"));
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer jwt_123",
    };

    // First delivery — receipt persisted
    const res1 = await app.handle(
      new Request("http://localhost/webhooks/gmail", { method: "POST", headers, body }),
    );
    assert.equal(res1.status, 200);
    const json1 = await res1.json();
    assert.equal(json1.receiptPersisted, true);

    // Second delivery (Pub/Sub redelivery) — receipt deduped, still enqueues
    const res2 = await app.handle(
      new Request("http://localhost/webhooks/gmail", { method: "POST", headers, body }),
    );
    assert.equal(res2.status, 200);
    const json2 = await res2.json();
    assert.equal(json2.receiptPersisted, false, "duplicate delivery must not create a second receipt");

    // Both deliveries enqueued a poll job (BullMQ TTL dedup is separate)
    assert.equal(callCount, 2);
  });

  test("#560a: receipt records verification result and payload hash", async () => {
    const seenReceipts: unknown[] = [];
    const app = new Elysia({ normalize: "typebox" }).use(errorHandler).use(
      makeGmailWebhookRoutes({
        verifyOidc: async () => ({ email: "pubsub-push@example.iam.gserviceaccount.com" }),
        findCredential: async () => ({ id: "cred_123", userId: "user_123" }),
        getQueue: () => ({ add: async () => {} }),
        persistReceipt: async (args) => {
          seenReceipts.push(args);
          return { inserted: true };
        },
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
    assert.equal(seenReceipts.length, 1);
    const receipt = seenReceipts[0] as {
      providerDeliveryId: string;
      credentialId: string;
      userId: string;
      historyId: string;
      verificationResult: string;
      payloadHash: string;
    };
    assert.equal(receipt.providerDeliveryId, "msg_123");
    assert.equal(receipt.credentialId, "cred_123");
    assert.equal(receipt.userId, "user_123");
    assert.equal(receipt.historyId, "hist_123");
    assert.equal(receipt.verificationResult, "oidc_valid");
    assert.match(receipt.payloadHash, /^[a-f0-9]{64}$/, "payload hash is SHA-256 hex");
  });
});
