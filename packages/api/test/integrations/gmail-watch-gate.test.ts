import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { installGmailWatch, stopGmailWatchWithAccessToken } from "@alfred/integrations/google";

describe("Gmail watch mailbox-write gate (#278)", () => {
  test("install returns before token fetch, Gmail watch, or DB writes when disabled", async () => {
    const calls = {
      token: 0,
      startWatch: 0,
      db: 0,
    };

    const result = await installGmailWatch(
      { credentialId: "cred_disabled", topicName: "projects/test/topics/gmail" },
      {
        mailboxWritesEnabled: () => false,
        getFreshAccessToken: async () => {
          calls.token++;
          throw new Error("token fetch should not run");
        },
        startWatch: async () => {
          calls.startWatch++;
          throw new Error("startWatch should not run");
        },
        db: (() => {
          calls.db++;
          throw new Error("db should not run");
        }) as never,
      },
    );

    assert.equal(result, null);
    assert.deepEqual(calls, { token: 0, startWatch: 0, db: 0 });
  });

  test("stop returns before Gmail stop when disabled", async () => {
    let stopCalls = 0;

    await stopGmailWatchWithAccessToken(
      { accessToken: "token", credentialId: "cred_disabled" },
      {
        mailboxWritesEnabled: () => false,
        stopWatch: async () => {
          stopCalls++;
          throw new Error("stopWatch should not run");
        },
      },
    );

    assert.equal(stopCalls, 0);
  });
});
