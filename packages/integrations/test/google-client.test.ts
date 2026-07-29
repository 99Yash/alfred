import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createGoogleClient } from "../src/google/client";

describe("Google configured client", () => {
  test("resolves the selected credential afresh for every request", async () => {
    const originalFetch = globalThis.fetch;
    const authorization: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      authorization.push(new Headers(init?.headers).get("Authorization") ?? "");
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const resolvedCredentialIds: string[] = [];
    const client = createGoogleClient(async (credentialId) => {
      resolvedCredentialIds.push(credentialId);
      return `token-${resolvedCredentialIds.length}`;
    });
    try {
      await client.gmail.listMessages({ credentialId: "personal" });
      await client.gmail.listMessages({ credentialId: "work" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(resolvedCredentialIds, ["personal", "work"]);
    assert.deepEqual(authorization, ["Bearer token-1", "Bearer token-2"]);
  });

  test("binds each method to its service-specific credential authority", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ messages: [], id: "sent", threadId: "thread" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const authorities: string[] = [];
    const client = createGoogleClient(async (_credentialId, authority) => {
      authorities.push(authority);
      return "token";
    });
    try {
      await client.gmail.listMessages({ credentialId: "account" });
      await client.gmail.sendMessage({
        credentialId: "account",
        to: ["person@example.com"],
        subject: "Hello",
        bodyText: "Body",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(authorities, ["gmail_read", "gmail_send"]);
  });

  test("honors the bind retry envelope for safe reads", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response(JSON.stringify({ messages: [] }), {
        status: attempts === 1 ? 503 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = createGoogleClient(async () => "token", {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    try {
      await client.gmail.listMessages({ credentialId: "account" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(attempts, 2);
  });
});
