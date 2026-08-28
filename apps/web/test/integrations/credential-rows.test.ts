import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseCredentialRows } from "../../src/lib/integrations/use-integration-status";

const validRow = {
  id: "cred-1",
  accountId: "account-1",
  accountLabel: "Work",
  status: "active",
  scopes: ["mail.read"],
  expiresAt: null,
  lastRefreshedAt: null,
  createdAt: "2026-08-09T00:00:00.000Z",
};

describe("parseCredentialRows", () => {
  test("normalizes a provider row without an installation id", () => {
    assert.deepEqual(parseCredentialRows([validRow]), [{ ...validRow, installationId: null }]);
  });

  test("keeps valid siblings when another row is malformed", () => {
    assert.deepEqual(parseCredentialRows([{ ...validRow, scopes: "mail.read" }, validRow]), [
      { ...validRow, installationId: null },
    ]);
  });

  test("rejects a non-array response", () => {
    assert.deepEqual(parseCredentialRows({ credentials: [validRow] }), []);
  });

  // Eden Treaty revives ISO-shaped response strings into `Date` objects, so the
  // rows this parser actually receives in the browser carry `Date` timestamps
  // even though the wire contract types them `string`. Parsing them as-is would
  // drop the row, and a dropped row reads as "not connected" — the whole
  // integrations surface silently goes blank while the API returns 200.
  test("accepts Eden's revived Date timestamps and flattens them back to ISO", () => {
    const revived = {
      ...validRow,
      expiresAt: new Date("2026-08-10T01:02:03.000Z"),
      lastRefreshedAt: new Date("2026-08-09T04:05:06.000Z"),
      createdAt: new Date("2026-08-09T00:00:00.000Z"),
    };
    assert.deepEqual(parseCredentialRows([revived]), [
      {
        ...validRow,
        installationId: null,
        expiresAt: "2026-08-10T01:02:03.000Z",
        lastRefreshedAt: "2026-08-09T04:05:06.000Z",
        createdAt: "2026-08-09T00:00:00.000Z",
      },
    ]);
  });
});
