import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DbRoot } from "@alfred/db";

import { stopGmailWatchWithAccessToken, uninstallGmailWatch } from "../src/google/index";
import { installGmailWatch } from "../src/google/internal";
import { asTestDouble } from "./support/test-double";

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
        mailbox: () => ({
          startWatch: async () => {
            calls.startWatch++;
            throw new Error("startWatch should not run");
          },
          stopWatch: async () => {
            throw new Error("stopWatch should not run");
          },
        }),
        db: () => {
          calls.db++;
          throw new Error("db should not run");
        },
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
        mailbox: () => ({
          startWatch: async () => {
            throw new Error("startWatch should not run");
          },
          stopWatch: async () => {
            stopCalls++;
            throw new Error("stopWatch should not run");
          },
        }),
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
      mailbox: () => ({
        startWatch: async () => {
          throw new Error("startWatch should not run");
        },
        stopWatch: async () => {
          calls.stopWatch++;
          throw new Error("stopWatch should not run");
        },
      }),
      // The uninstall path reads only `update().set().where()`.
      db: () =>
        asTestDouble<DbRoot>({
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
        }),
    });

    assert.deepEqual(calls, { token: 0, stopWatch: 0, dbUpdate: 1, dbSet: 1, dbWhere: 1 });
  });
});
