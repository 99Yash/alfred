import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { observationInsertSchema } from "@alfred/contracts";
import {
  buildOrgAffiliationObservationInput,
  type CredentialForAffiliation,
} from "../../src/modules/user-model/affiliation";

/**
 * Pure-builder tests for the connect-time `user_org_affiliation` emitter (ADR-0080
 * §4a / #342, PR A). No DB — `buildOrgAffiliationObservationInput` is deterministic
 * given its inputs, and every produced input is cross-checked against the REAL
 * observation write boundary (`observationInsertSchema`) so the emitter can never
 * construct a row the boundary would reject at runtime.
 */

const T0 = new Date("2026-06-01T12:00:00.000Z");

function cred(over: Partial<CredentialForAffiliation>): CredentialForAffiliation {
  return {
    userId: "user_1",
    accountId: "108412341234123412341",
    accountEmail: "yash.k@oliv.ai",
    metadata: { googleHostedDomain: "oliv.ai" },
    ...over,
  };
}

describe("buildOrgAffiliationObservationInput", () => {
  test("work account with a matching hosted domain grounds employer", () => {
    const res = buildOrgAffiliationObservationInput(cred({}), { status: "connected", occurredAt: T0 });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.domainClass, "corporate_domain");
    assert.deepEqual(res.input.payload, {
      accountId: "108412341234123412341",
      accountEmail: "yash.k@oliv.ai",
      orgDomain: "oliv.ai",
      verifiedHostedDomain: "oliv.ai",
      domainClass: "corporate_domain",
      status: "connected",
      evidence: "connected_google_account",
    });
    assert.equal(res.input.subjectIdentity.kind, "user");
    assert.equal(res.input.source, "google_account");
    assert.equal(res.input.kind, "user_org_affiliation");
    assert.equal(res.input.occurredAt, T0);
    assert.equal(res.input.familyKey, "org_affiliation:108412341234123412341:oliv.ai");
  });

  test("every produced input passes the real observation write boundary", () => {
    for (const status of ["connected", "disconnected"] as const) {
      const res = buildOrgAffiliationObservationInput(cred({}), { status, occurredAt: T0 });
      assert.equal(res.ok, true);
      if (!res.ok) return;
      // The boundary re-derives domainClass and re-checks verifiedHostedDomain ===
      // orgDomain; a throw here means the builder produced a self-inconsistent row.
      assert.doesNotThrow(() => observationInsertSchema.parse(res.input));
    }
  });

  test("consumer gmail classifies as consumer_email with no verified domain", () => {
    const res = buildOrgAffiliationObservationInput(
      cred({ accountEmail: "yash@gmail.com", metadata: {} }),
      { status: "connected", occurredAt: T0 },
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.domainClass, "consumer_email");
    assert.equal((res.input.payload as { verifiedHostedDomain: unknown }).verifiedHostedDomain, null);
    assert.equal((res.input.payload as { orgDomain: string }).orgDomain, "gmail.com");
    assert.doesNotThrow(() => observationInsertSchema.parse(res.input));
  });

  test("custom domain with no hosted-domain claim stays ambiguous (no employer grounding)", () => {
    const res = buildOrgAffiliationObservationInput(
      cred({ accountEmail: "z@yourelasticdash.co", metadata: {} }),
      { status: "connected", occurredAt: T0 },
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.domainClass, "ambiguous_domain");
    assert.equal((res.input.payload as { verifiedHostedDomain: unknown }).verifiedHostedDomain, null);
    assert.doesNotThrow(() => observationInsertSchema.parse(res.input));
  });

  test("a hosted domain that disagrees with the email domain does not verify", () => {
    // `hd` belongs to a different org than the mailbox — it can't vouch for THIS
    // address, so verifiedHostedDomain drops to null and the class is ambiguous.
    const res = buildOrgAffiliationObservationInput(
      cred({ accountEmail: "contractor@vendor.com", metadata: { googleHostedDomain: "oliv.ai" } }),
      { status: "connected", occurredAt: T0 },
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.domainClass, "ambiguous_domain");
    assert.equal((res.input.payload as { verifiedHostedDomain: unknown }).verifiedHostedDomain, null);
    assert.doesNotThrow(() => observationInsertSchema.parse(res.input));
  });

  test("a role/service mailbox is never an employer grounding", () => {
    const res = buildOrgAffiliationObservationInput(
      cred({ accountEmail: "noreply@oliv.ai" }),
      { status: "connected", occurredAt: T0 },
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.domainClass, "service_or_role_account");
    assert.doesNotThrow(() => observationInsertSchema.parse(res.input));
  });

  test("the account email is canonicalized (trimmed + lowercased)", () => {
    const res = buildOrgAffiliationObservationInput(
      cred({ accountEmail: "  Yash.K@OLIV.ai  " }),
      { status: "connected", occurredAt: T0 },
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal((res.input.payload as { accountEmail: string }).accountEmail, "yash.k@oliv.ai");
    assert.equal((res.input.payload as { orgDomain: string }).orgDomain, "oliv.ai");
  });

  for (const [label, over, reason] of [
    ["missing account id", { accountId: "  " }, "missing_account_id"],
    ["missing email", { accountEmail: null }, "missing_account_email"],
    ["whitespace-only email (present but unusable)", { accountEmail: "   " }, "invalid_account_email"],
    ["malformed email", { accountEmail: "not-an-email" }, "invalid_account_email"],
  ] as const) {
    test(`skips with a typed reason: ${label}`, () => {
      const res = buildOrgAffiliationObservationInput(cred(over), {
        status: "connected",
        occurredAt: T0,
      });
      assert.equal(res.ok, false);
      if (res.ok) return;
      assert.equal(res.reason, reason);
    });
  }

  describe("evidenceHash idempotency / lifecycle distinctness", () => {
    test("same credential + same occurredAt → identical evidenceHash (re-run/re-auth dedups)", () => {
      const a = buildOrgAffiliationObservationInput(cred({}), { status: "connected", occurredAt: T0 });
      const b = buildOrgAffiliationObservationInput(cred({}), { status: "connected", occurredAt: T0 });
      assert.equal(a.ok && b.ok, true);
      if (!a.ok || !b.ok) return;
      assert.equal(a.input.evidenceHash, b.input.evidenceHash);
    });

    test("a later occurredAt → different evidenceHash (reconnect advances the family)", () => {
      const a = buildOrgAffiliationObservationInput(cred({}), { status: "connected", occurredAt: T0 });
      const b = buildOrgAffiliationObservationInput(cred({}), {
        status: "connected",
        occurredAt: new Date(T0.getTime() + 1000),
      });
      assert.equal(a.ok && b.ok, true);
      if (!a.ok || !b.ok) return;
      assert.notEqual(a.input.evidenceHash, b.input.evidenceHash);
    });

    test("connected vs disconnected at the same time → different evidenceHash, same family", () => {
      const c = buildOrgAffiliationObservationInput(cred({}), { status: "connected", occurredAt: T0 });
      const d = buildOrgAffiliationObservationInput(cred({}), {
        status: "disconnected",
        occurredAt: T0,
      });
      assert.equal(c.ok && d.ok, true);
      if (!c.ok || !d.ok) return;
      assert.notEqual(c.input.evidenceHash, d.input.evidenceHash);
      assert.equal(c.input.familyKey, d.input.familyKey);
    });
  });
});
