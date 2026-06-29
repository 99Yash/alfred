import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { observationInsertSchema } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import {
  integrationCredentials,
  observationFamilyHeads,
  observations,
  user,
} from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  buildOrgAffiliationObservationInput,
  recordOrgAffiliationOnConnect,
  recordOrgAffiliationOnCredentialUpsert,
  recordOrgAffiliationOnDisconnect,
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
const ID_PREFIX = "test-affiliation-";
const createdUserIds: string[] = [];

function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}
const SKIP_DB = hasDatabaseUrl() ? false : "DATABASE_URL not set - skipping DB-backed test";

after(async () => {
  if (createdUserIds.length > 0) {
    await db().delete(user).where(inArray(user.id, createdUserIds));
  }
  await closeConnections();
});

function cred(over: Partial<CredentialForAffiliation>): CredentialForAffiliation {
  return {
    userId: "user_1",
    accountId: "108412341234123412341",
    accountEmail: "yash.k@oliv.ai",
    metadata: { googleHostedDomain: "oliv.ai" },
    ...over,
  };
}

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Affiliation Test", email: `${userId}@example.test` });
  return userId;
}

async function seedGoogleCredential(args: {
  userId: string;
  accountId: string;
  createdAt: Date;
  accountEmail?: string;
  hostedDomain?: string;
}): Promise<string> {
  const accountEmail = args.accountEmail ?? "yash.k@oliv.ai";
  const hostedDomain = args.hostedDomain ?? "oliv.ai";
  const [row] = await db()
    .insert(integrationCredentials)
    .values({
      userId: args.userId,
      provider: "google",
      accountId: args.accountId,
      accountLabel: accountEmail,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date("2026-06-30T00:00:00.000Z"),
      scopes: [],
      metadata: { googleHostedDomain: hostedDomain },
      status: "active",
      createdAt: args.createdAt,
    })
    .returning({ id: integrationCredentials.id });
  assert.ok(row);
  return row.id;
}

describe("buildOrgAffiliationObservationInput", () => {
  test("work account with a matching hosted domain grounds employer", () => {
    const res = buildOrgAffiliationObservationInput(cred({}), {
      status: "connected",
      occurredAt: T0,
    });
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
    assert.equal(
      (res.input.payload as { verifiedHostedDomain: unknown }).verifiedHostedDomain,
      null,
    );
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
    assert.equal(
      (res.input.payload as { verifiedHostedDomain: unknown }).verifiedHostedDomain,
      null,
    );
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
    assert.equal(
      (res.input.payload as { verifiedHostedDomain: unknown }).verifiedHostedDomain,
      null,
    );
    assert.doesNotThrow(() => observationInsertSchema.parse(res.input));
  });

  test("a role/service mailbox is never an employer grounding", () => {
    const res = buildOrgAffiliationObservationInput(cred({ accountEmail: "noreply@oliv.ai" }), {
      status: "connected",
      occurredAt: T0,
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.domainClass, "service_or_role_account");
    assert.doesNotThrow(() => observationInsertSchema.parse(res.input));
  });

  test("the account email is canonicalized (trimmed + lowercased)", () => {
    const res = buildOrgAffiliationObservationInput(cred({ accountEmail: "  Yash.K@OLIV.ai  " }), {
      status: "connected",
      occurredAt: T0,
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal((res.input.payload as { accountEmail: string }).accountEmail, "yash.k@oliv.ai");
    assert.equal((res.input.payload as { orgDomain: string }).orgDomain, "oliv.ai");
  });

  for (const [label, over, reason] of [
    ["missing account id", { accountId: "  " }, "missing_account_id"],
    ["missing email", { accountEmail: null }, "missing_account_email"],
    [
      "whitespace-only email (present but unusable)",
      { accountEmail: "   " },
      "invalid_account_email",
    ],
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
      const a = buildOrgAffiliationObservationInput(cred({}), {
        status: "connected",
        occurredAt: T0,
      });
      const b = buildOrgAffiliationObservationInput(cred({}), {
        status: "connected",
        occurredAt: T0,
      });
      assert.equal(a.ok && b.ok, true);
      if (!a.ok || !b.ok) return;
      assert.equal(a.input.evidenceHash, b.input.evidenceHash);
    });

    test("a later occurredAt → different evidenceHash (reconnect advances the family)", () => {
      const a = buildOrgAffiliationObservationInput(cred({}), {
        status: "connected",
        occurredAt: T0,
      });
      const b = buildOrgAffiliationObservationInput(cred({}), {
        status: "connected",
        occurredAt: new Date(T0.getTime() + 1000),
      });
      assert.equal(a.ok && b.ok, true);
      if (!a.ok || !b.ok) return;
      assert.notEqual(a.input.evidenceHash, b.input.evidenceHash);
    });

    test("connected vs disconnected at the same time → different evidenceHash, same family", () => {
      const c = buildOrgAffiliationObservationInput(cred({}), {
        status: "connected",
        occurredAt: T0,
      });
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

describe("recordOrgAffiliation lifecycle (DB-backed)", { skip: SKIP_DB }, () => {
  test("connect dedups, disconnect supersedes connect, and reconnect supersedes disconnect", async () => {
    const userId = await seedUser();
    const accountId = `google-sub-${randomUUID()}`;
    const connectAt = new Date("2026-06-01T12:00:00.000Z");
    const disconnectAt = new Date("2026-06-02T12:00:00.000Z");
    const reconnectAt = new Date("2026-06-03T12:00:00.000Z");

    const firstCredentialId = await seedGoogleCredential({
      userId,
      accountId,
      createdAt: connectAt,
    });
    const connected = await recordOrgAffiliationOnConnect(firstCredentialId);
    assert.equal(connected.status, "emitted");

    const duplicateConnect = await recordOrgAffiliationOnConnect(firstCredentialId);
    assert.equal(duplicateConnect.status, "deduped");

    const disconnected = await recordOrgAffiliationOnDisconnect(
      {
        userId,
        accountId,
        accountEmail: "yash.k@oliv.ai",
        metadata: { googleHostedDomain: "oliv.ai" },
      },
      disconnectAt,
    );
    assert.equal(disconnected.status, "emitted");

    await db()
      .delete(integrationCredentials)
      .where(eq(integrationCredentials.id, firstCredentialId));

    const secondCredentialId = await seedGoogleCredential({
      userId,
      accountId,
      createdAt: reconnectAt,
    });
    const reconnected = await recordOrgAffiliationOnConnect(secondCredentialId);
    assert.equal(reconnected.status, "emitted");

    const familyKey = `org_affiliation:${accountId}:oliv.ai`;
    const rows = await db()
      .select({
        id: observations.id,
        occurredAt: observations.occurredAt,
        supersedesObservationId: observations.supersedesObservationId,
        payload: observations.payload,
      })
      .from(observations)
      .where(and(eq(observations.userId, userId), eq(observations.familyKey, familyKey)))
      .orderBy(asc(observations.occurredAt));

    assert.equal(rows.length, 3);
    assert.equal((rows[0]?.payload as { status?: string } | undefined)?.status, "connected");
    assert.equal(rows[0]?.supersedesObservationId, null);
    assert.equal((rows[1]?.payload as { status?: string } | undefined)?.status, "disconnected");
    assert.equal(rows[1]?.supersedesObservationId, rows[0]?.id);
    assert.equal((rows[2]?.payload as { status?: string } | undefined)?.status, "connected");
    assert.equal(rows[2]?.supersedesObservationId, rows[1]?.id);

    const [head] = await db()
      .select({ headObservationId: observationFamilyHeads.headObservationId })
      .from(observationFamilyHeads)
      .where(
        and(
          eq(observationFamilyHeads.userId, userId),
          eq(observationFamilyHeads.familyKey, familyKey),
        ),
      );
    assert.equal(head?.headObservationId, rows[2]?.id);
  });

  test("same Google account changing domains disconnects the old family and connects the new one at change time", async () => {
    const userId = await seedUser();
    const accountId = `google-sub-${randomUUID()}`;
    const connectAt = new Date("2026-06-01T12:00:00.000Z");
    const changedAt = new Date("2026-06-04T12:00:00.000Z");

    const credentialId = await seedGoogleCredential({
      userId,
      accountId,
      accountEmail: "owner@oldco.ai",
      hostedDomain: "oldco.ai",
      createdAt: connectAt,
    });
    const connected = await recordOrgAffiliationOnConnect(credentialId);
    assert.equal(connected.status, "emitted");

    const previousCredential: CredentialForAffiliation = {
      userId,
      accountId,
      accountEmail: "owner@oldco.ai",
      metadata: { googleHostedDomain: "oldco.ai" },
    };
    await db()
      .update(integrationCredentials)
      .set({
        accountLabel: "owner@newco.ai",
        metadata: { googleHostedDomain: "newco.ai" },
      })
      .where(eq(integrationCredentials.id, credentialId));

    const changed = await recordOrgAffiliationOnCredentialUpsert({
      credentialId,
      previousCredential,
      changedAt,
    });
    assert.equal(changed.disconnectedPrevious?.status, "emitted");
    assert.equal(changed.connectedCurrent.status, "emitted");

    const oldRows = await db()
      .select({
        occurredAt: observations.occurredAt,
        supersedesObservationId: observations.supersedesObservationId,
        payload: observations.payload,
      })
      .from(observations)
      .where(
        and(
          eq(observations.userId, userId),
          eq(observations.familyKey, `org_affiliation:${accountId}:oldco.ai`),
        ),
      )
      .orderBy(asc(observations.occurredAt));

    assert.equal(oldRows.length, 2);
    assert.equal((oldRows[0]?.payload as { status?: string } | undefined)?.status, "connected");
    assert.equal((oldRows[1]?.payload as { status?: string } | undefined)?.status, "disconnected");
    assert.equal(oldRows[1]?.occurredAt.getTime(), changedAt.getTime());

    const newRows = await db()
      .select({
        occurredAt: observations.occurredAt,
        payload: observations.payload,
      })
      .from(observations)
      .where(
        and(
          eq(observations.userId, userId),
          eq(observations.familyKey, `org_affiliation:${accountId}:newco.ai`),
        ),
      );

    assert.equal(newRows.length, 1);
    assert.equal((newRows[0]?.payload as { status?: string } | undefined)?.status, "connected");
    assert.equal(newRows[0]?.occurredAt.getTime(), changedAt.getTime());
  });
});
