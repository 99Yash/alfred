import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  installGmailWatch,
  stopGmailWatchWithAccessToken,
  uninstallGmailWatch,
} from "@alfred/integrations/google";

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

  test("uninstall skips remote stop but still clears local watch metadata when disabled", async () => {
    const calls = {
      token: 0,
      stopWatch: 0,
      dbUpdate: 0,
      dbSet: 0,
      dbWhere: 0,
    };

    await uninstallGmailWatch("cred_disabled", {
      mailboxWritesEnabled: () => false,
      getFreshAccessToken: async () => {
        calls.token++;
        throw new Error("token fetch should not run");
      },
      stopWatch: async () => {
        calls.stopWatch++;
        throw new Error("stopWatch should not run");
      },
      db: (() => ({
        update: () => {
          calls.dbUpdate++;
          return {
            set: () => {
              calls.dbSet++;
              return {
                where: () => {
                  calls.dbWhere++;
                  return Promise.resolve();
                },
              };
            },
          };
        },
      })) as never,
    });

    assert.deepEqual(calls, { token: 0, stopWatch: 0, dbUpdate: 1, dbSet: 1, dbWhere: 1 });
  });
});
