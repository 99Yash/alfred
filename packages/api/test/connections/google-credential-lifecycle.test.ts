import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DbTransaction } from "@alfred/db";
import { createGoogleCredentialLifecycleHandler } from "../../src/composition/google-credential-lifecycle";
import {
  disconnectGoogleCredentialConnectionWith,
  googleCredentialDisconnectRequestSchema,
  googleCredentialUpsertRequestSchema,
  GoogleCredentialNotFoundError,
  NoGoogleCredentialLifecycleHandlerRegisteredError,
  registerGoogleCredentialLifecycleHandler,
  upsertGoogleCredentialConnection,
} from "@alfred/assistant/connections";
import { TriggerConsumerBootError } from "@alfred/assistant/triggers";

const fakeTransaction = {} as DbTransaction;
const changedAt = new Date("2026-08-02T09:00:00.000Z");
const disconnectedAt = new Date("2026-08-02T10:00:00.000Z");

const upsertRequest = {
  userId: "user-1",
  accountId: "google-account-1",
  accountEmail: "owner@example.com",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: new Date("2026-08-03T09:00:00.000Z"),
  scopes: ["scope-1"],
  tokenType: "Bearer",
  hostedDomain: "example.com",
};

const deletedCredential = {
  id: "credential-1",
  userId: "user-1",
  accountId: "google-account-1",
  accountEmail: "owner@example.com",
  metadata: { googleHostedDomain: "example.com" },
};

describe("Google credential lifecycle composition seam", () => {
  test("owns strict request schemas and rejects missing composition", async () => {
    assert.equal(googleCredentialUpsertRequestSchema.safeParse(upsertRequest).success, true);
    assert.equal(
      googleCredentialUpsertRequestSchema.safeParse({ ...upsertRequest, unexpected: true }).success,
      false,
    );
    assert.equal(
      googleCredentialDisconnectRequestSchema.safeParse({
        userId: "user-1",
        credentialId: "credential-1",
      }).success,
      true,
    );

    await assert.rejects(
      () => upsertGoogleCredentialConnection(upsertRequest),
      NoGoogleCredentialLifecycleHandlerRegisteredError,
    );
  });

  // Backstop for the boot-error-plain-extends gate: if the seam ever reaches this
  // registry's not-registered error from a best-effort consumer, membership in
  // TriggerConsumerBootError is what makes it reject the publish rather than be
  // swallowed. Catches a revert to `extends Error` even if the static gate were removed.
  test("its not-registered error is a TriggerConsumerBootError", () => {
    assert.ok(
      new NoGoogleCredentialLifecycleHandlerRegisteredError() instanceof TriggerConsumerBootError,
    );
  });

  test("validates the registered handler result", async () => {
    const unregister = registerGoogleCredentialLifecycleHandler({
      async upsert() {
        return { credentialId: "credential-1", unexpected: true };
      },
      async disconnect() {
        return { status: "deleted" };
      },
    } as unknown as Parameters<typeof registerGoogleCredentialLifecycleHandler>[0]);

    try {
      await assert.rejects(() => upsertGoogleCredentialConnection(upsertRequest));
    } finally {
      unregister();
    }
  });

  test("retries the complete upsert transaction and preserves reconnect evidence", async () => {
    const conflict = Object.assign(new Error("observation append conflict"), {
      code: "23505",
      constraint: "observations_no_fork_idx",
    });
    const previousCredential = {
      userId: "user-1",
      accountId: "google-account-1",
      accountEmail: "owner@old.example",
      metadata: { googleHostedDomain: "old.example" },
    };
    let attempts = 0;
    let commits = 0;
    const receivedPrevious: unknown[] = [];
    const receivedChangedAt: Date[] = [];
    const handler = createGoogleCredentialLifecycleHandler({
      async transaction(callback) {
        attempts++;
        const result = await callback(fakeTransaction);
        commits++;
        return result;
      },
      async loadPreviousCredential() {
        return previousCredential;
      },
      async upsertCredential() {
        return { id: "credential-1" };
      },
      async recordUpsert(args) {
        receivedPrevious.push(args.previousCredential);
        receivedChangedAt.push(args.changedAt);
        if (receivedPrevious.length < 3) throw conflict;
        return { connectedCurrent: { status: "emitted" } };
      },
    });

    assert.deepEqual(await handler.upsert({ ...upsertRequest, changedAt }), {
      credentialId: "credential-1",
    });
    assert.equal(attempts, 3);
    assert.equal(commits, 1);
    assert.deepEqual(receivedPrevious, [
      previousCredential,
      previousCredential,
      previousCredential,
    ]);
    assert.deepEqual(receivedChangedAt, [changedAt, changedAt, changedAt]);
  });

  test("does not retry unrelated failures and rolls back an upsert when append fails", async () => {
    const appendFailure = new Error("append unavailable");
    let attempts = 0;
    let commits = 0;
    const handler = createGoogleCredentialLifecycleHandler({
      async transaction(callback) {
        attempts++;
        const result = await callback(fakeTransaction);
        commits++;
        return result;
      },
      async loadPreviousCredential() {
        return null;
      },
      async upsertCredential() {
        return { id: "credential-1" };
      },
      async recordUpsert() {
        throw appendFailure;
      },
    });

    await assert.rejects(() => handler.upsert({ ...upsertRequest, changedAt }), appendFailure);
    assert.equal(attempts, 1);
    assert.equal(commits, 0);
  });

  test("does not append after a losing delete", async () => {
    let appends = 0;
    const handler = createGoogleCredentialLifecycleHandler({
      async transaction(callback) {
        return callback(fakeTransaction);
      },
      async deleteCredential() {
        return null;
      },
      async recordDisconnect() {
        appends++;
        return { status: "emitted" };
      },
    });

    assert.deepEqual(
      await handler.disconnect({
        userId: "user-1",
        credentialId: "credential-1",
        disconnectedAt,
      }),
      { status: "already_absent" },
    );
    assert.equal(appends, 0);
  });

  test("rolls back a delete when the disconnect append fails", async () => {
    const appendFailure = new Error("append unavailable");
    let commits = 0;
    const handler = createGoogleCredentialLifecycleHandler({
      async transaction(callback) {
        const result = await callback(fakeTransaction);
        commits++;
        return result;
      },
      async deleteCredential() {
        return deletedCredential;
      },
      async recordDisconnect() {
        throw appendFailure;
      },
    });

    await assert.rejects(
      () =>
        handler.disconnect({
          userId: "user-1",
          credentialId: "credential-1",
          disconnectedAt,
        }),
      appendFailure,
    );
    assert.equal(commits, 0);
  });

  test("stops the remote watch only after the disconnect transaction commits", async () => {
    const calls: string[] = [];
    const result = await disconnectGoogleCredentialConnectionWith(
      { userId: "user-1", credentialId: "credential-1" },
      {
        async loadOwnedCredential() {
          calls.push("owned");
          return true;
        },
        mailboxWritesEnabled() {
          return true;
        },
        async getFreshAccessToken() {
          calls.push("token");
          return "access-token";
        },
        async commitDisconnect(request) {
          calls.push(`commit:${request.disconnectedAt.toISOString()}`);
          return { status: "deleted" };
        },
        async stopWatch() {
          calls.push("stop-watch");
        },
        now() {
          return disconnectedAt;
        },
        warn() {},
      },
    );

    assert.deepEqual(result, { credentialId: "credential-1", status: "deleted" });
    assert.deepEqual(calls, [
      "owned",
      "token",
      `commit:${disconnectedAt.toISOString()}`,
      "stop-watch",
    ]);
  });

  test("does not stop the remote watch after a rejected transaction", async () => {
    let watchStops = 0;
    await assert.rejects(
      () =>
        disconnectGoogleCredentialConnectionWith(
          { userId: "user-1", credentialId: "credential-1" },
          {
            async loadOwnedCredential() {
              return true;
            },
            mailboxWritesEnabled() {
              return true;
            },
            async getFreshAccessToken() {
              return "access-token";
            },
            async commitDisconnect() {
              throw new Error("transaction rolled back");
            },
            async stopWatch() {
              watchStops++;
            },
            now() {
              return disconnectedAt;
            },
            warn() {},
          },
        ),
      /transaction rolled back/,
    );
    assert.equal(watchStops, 0);
  });

  test("does not reveal credentials owned by another user", async () => {
    await assert.rejects(
      () =>
        disconnectGoogleCredentialConnectionWith(
          { userId: "user-1", credentialId: "credential-1" },
          {
            async loadOwnedCredential() {
              return false;
            },
            mailboxWritesEnabled() {
              return false;
            },
            async getFreshAccessToken() {
              throw new Error("unreachable");
            },
            async commitDisconnect() {
              throw new Error("unreachable");
            },
            async stopWatch() {
              throw new Error("unreachable");
            },
            now() {
              return disconnectedAt;
            },
            warn() {},
          },
        ),
      GoogleCredentialNotFoundError,
    );
  });
});
