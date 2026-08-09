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
});
