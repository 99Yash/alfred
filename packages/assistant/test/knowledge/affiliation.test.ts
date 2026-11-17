import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { getStringPath } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { unsealedTestSecret } from "../support/unsealed-secret";
import {
  integrationCredentials,
  observationFamilyHeads,
  observations,
  user,
} from "@alfred/db/schemas";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  recordOrgAffiliationOnCredentialUpsert,
  recordOrgAffiliationOnDisconnect,
  type CredentialForAffiliation,
} from "@alfred/assistant/knowledge/affiliation";
import { dbBackedSkip } from "../support/db-backed";

/**
 * Connect-time `user_org_affiliation` emitter (ADR-0080 §4a). Every built input is
 * parsed by the real `observationInsertSchema`, so the emitter cannot build a row the write rejects.
 */

const T0 = new Date("2026-06-01T12:00:00.000Z");

const ID_PREFIX = "test-affiliation-";

const createdUserIds: string[] = [];

const SKIP_DB = dbBackedSkip("database");

after(async () => {
  if (createdUserIds.length > 0) {
    await db().delete(user).where(inArray(user.id, createdUserIds));
  }

  await closeConnections();
});

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
  /** `null` seeds no `account_label`, for the missing-email skip. */
  accountEmail?: string | null;
  hostedDomain?: string | null;
}): Promise<string> {
  const accountEmail = args.accountEmail === undefined ? "yash.k@oliv.ai" : args.accountEmail;
  const hostedDomain = args.hostedDomain === undefined ? "oliv.ai" : args.hostedDomain;

  const [row] = await db()
    .insert(integrationCredentials)
    .values({
      userId: args.userId,
      provider: "google",
      accountId: args.accountId,
      accountLabel: accountEmail,
      // Unsealed on purpose: no code path here opens either token.
      accessToken: unsealedTestSecret("access-token"),
      refreshToken: unsealedTestSecret("refresh-token"),
      expiresAt: new Date("2026-06-30T00:00:00.000Z"),
      scopes: [],
      metadata: hostedDomain ? { googleHostedDomain: hostedDomain } : {},
      status: "active",
      createdAt: args.createdAt,
    })
    .returning({ id: integrationCredentials.id });

  assert.ok(row);

  return row.id;
}

/**
 * The observation builder is internal; every scenario here runs through the public
 * `recordOrgAffiliationOnCredentialUpsert` / `recordOrgAffiliationOnDisconnect` entries
 * and asserts on what they return and store.
 */
describe(
  "org-affiliation observation built through the record entries (DB-backed)",
  { skip: SKIP_DB },
  () => {
    const ACCOUNT_ID = "108412341234123412341";

    /** Connects one seeded credential with no `previousCredential`, so the connect time is its `createdAt`. */
    async function connectSeed(args: {
      accountEmail?: string | null;
      hostedDomain?: string | null;
      accountId?: string;
      createdAt?: Date;
    }): Promise<{
      userId: string;
      credentialId: string;
      result: Awaited<ReturnType<typeof recordOrgAffiliationOnCredentialUpsert>>;
    }> {
      const userId = await seedUser();

      const seedArgs: Parameters<typeof seedGoogleCredential>[0] = {
        userId,
        accountId: args.accountId ?? ACCOUNT_ID,
        createdAt: args.createdAt ?? T0,
      };

      if (args.accountEmail !== undefined) seedArgs.accountEmail = args.accountEmail;

      if (args.hostedDomain !== undefined) seedArgs.hostedDomain = args.hostedDomain;

      const credentialId = await seedGoogleCredential(seedArgs);

      const result = await recordOrgAffiliationOnCredentialUpsert(
        { credentialId, changedAt: T0 },
        "own",
      );

      return { userId, credentialId, result };
    }

    test("work account with a matching hosted domain grounds employer at connect time", async () => {
      const { userId, result } = await connectSeed({});

      assert.equal(result.connectedCurrent.status, "emitted");

      const familyKey = `org_affiliation:${ACCOUNT_ID}:oliv.ai`;

      const rows = await db()
        .select({
          occurredAt: observations.occurredAt,
          payload: observations.payload,
          supersedesObservationId: observations.supersedesObservationId,
        })
        .from(observations)
        .where(and(eq(observations.userId, userId), eq(observations.familyKey, familyKey)))
        .orderBy(asc(observations.occurredAt));

      const [row] = rows;

      assert.equal(rows.length, 1);
      assert.ok(row);
      assert.equal(row.occurredAt.getTime(), T0.getTime());
      assert.deepEqual(row.payload, {
        accountId: ACCOUNT_ID,
        accountEmail: "yash.k@oliv.ai",
        orgDomain: "oliv.ai",
        verifiedHostedDomain: "oliv.ai",
        domainClass: "corporate_domain",
        status: "connected",
        evidence: "connected_google_account",
      });
    });

    test("connected and disconnected writes both pass the real observation write boundary", async () => {
      const { userId, result } = await connectSeed({});

      assert.equal(result.connectedCurrent.status, "emitted");

      const disconnected = await recordOrgAffiliationOnDisconnect(
        {
          userId,
          accountId: ACCOUNT_ID,
          accountEmail: "yash.k@oliv.ai",
          metadata: { googleHostedDomain: "oliv.ai" },
        },
        new Date(T0.getTime() + 1000),
        "own",
      );

      assert.equal(disconnected.status, "emitted");
    });

    test("consumer gmail classifies as consumer_email with no verified domain", async () => {
      const { userId, result } = await connectSeed({
        accountEmail: "yash@gmail.com",
        hostedDomain: null,
      });

      assert.equal(result.connectedCurrent.status, "emitted");

      const familyKey = `org_affiliation:${ACCOUNT_ID}:gmail.com`;

      const rows = await db()
        .select({
          occurredAt: observations.occurredAt,
          payload: observations.payload,
          supersedesObservationId: observations.supersedesObservationId,
        })
        .from(observations)
        .where(and(eq(observations.userId, userId), eq(observations.familyKey, familyKey)))
        .orderBy(asc(observations.occurredAt));

      const [row] = rows;

      assert.equal(rows.length, 1);
      assert.ok(row);
      assert.equal(row.payload.domainClass, "consumer_email");
      // `getStringPath` returns undefined for both an absent field and a null one,
      // which is what "no verified domain" means here.
      assert.equal(getStringPath(row.payload, "verifiedHostedDomain"), undefined);
      assert.equal(getStringPath(row.payload, "orgDomain"), "gmail.com");
    });

    test("custom domain with no hosted-domain claim stays ambiguous (no employer grounding)", async () => {
      const { userId, result } = await connectSeed({
        accountEmail: "z@yourelasticdash.co",
        hostedDomain: null,
      });

      assert.equal(result.connectedCurrent.status, "emitted");

      const familyKey = `org_affiliation:${ACCOUNT_ID}:yourelasticdash.co`;

      const rows = await db()
        .select({
          occurredAt: observations.occurredAt,
          payload: observations.payload,
          supersedesObservationId: observations.supersedesObservationId,
        })
        .from(observations)
        .where(and(eq(observations.userId, userId), eq(observations.familyKey, familyKey)))
        .orderBy(asc(observations.occurredAt));

      const [row] = rows;

      assert.equal(rows.length, 1);
      assert.ok(row);
      assert.equal(row.payload.domainClass, "ambiguous_domain");
      // `getStringPath` returns undefined for both an absent field and a null one,
      // which is what "no employer grounding" means here.
      assert.equal(getStringPath(row.payload, "verifiedHostedDomain"), undefined);
    });

    test("a hosted domain that differs from the email domain verifies the Workspace org", async () => {
      // Key the org by Google's `hd`; the email can carry an alias domain.
      const { userId, result } = await connectSeed({
        accountEmail: "contractor@vendor.com",
        hostedDomain: "oliv.ai",
      });

      assert.equal(result.connectedCurrent.status, "emitted");

      const familyKey = `org_affiliation:${ACCOUNT_ID}:oliv.ai`;

      const rows = await db()
        .select({
          occurredAt: observations.occurredAt,
          payload: observations.payload,
          supersedesObservationId: observations.supersedesObservationId,
        })
        .from(observations)
        .where(and(eq(observations.userId, userId), eq(observations.familyKey, familyKey)))
        .orderBy(asc(observations.occurredAt));

      const [row] = rows;

      assert.equal(rows.length, 1);
      assert.ok(row);
      assert.equal(row.payload.domainClass, "corporate_domain");
      assert.equal(getStringPath(row.payload, "verifiedHostedDomain"), "oliv.ai");
    });

    test("a role/service mailbox is never an employer grounding", async () => {
      const { userId, result } = await connectSeed({ accountEmail: "noreply@oliv.ai" });

      assert.equal(result.connectedCurrent.status, "emitted");

      const familyKey = `org_affiliation:${ACCOUNT_ID}:oliv.ai`;

      const rows = await db()
        .select({
          occurredAt: observations.occurredAt,
          payload: observations.payload,
          supersedesObservationId: observations.supersedesObservationId,
        })
        .from(observations)
        .where(and(eq(observations.userId, userId), eq(observations.familyKey, familyKey)))
        .orderBy(asc(observations.occurredAt));

      const [row] = rows;

      assert.equal(rows.length, 1);
      assert.ok(row);
      assert.equal(row.payload.domainClass, "service_or_role_account");
    });

    test("the account email is canonicalized (trimmed + lowercased)", async () => {
      const { userId, result } = await connectSeed({ accountEmail: "  Yash.K@OLIV.ai  " });

      assert.equal(result.connectedCurrent.status, "emitted");

      const familyKey = `org_affiliation:${ACCOUNT_ID}:oliv.ai`;

      const rows = await db()
        .select({
          occurredAt: observations.occurredAt,
          payload: observations.payload,
          supersedesObservationId: observations.supersedesObservationId,
        })
        .from(observations)
        .where(and(eq(observations.userId, userId), eq(observations.familyKey, familyKey)))
        .orderBy(asc(observations.occurredAt));

      const [row] = rows;

      assert.equal(rows.length, 1);
      assert.ok(row);
      assert.equal(getStringPath(row.payload, "accountEmail"), "yash.k@oliv.ai");
      assert.equal(getStringPath(row.payload, "orgDomain"), "oliv.ai");
    });

    for (const [label, over, reason] of [
      ["missing account id", { accountId: "   " }, "missing_account_id"],
      ["missing email", { accountEmail: null }, "missing_account_email"],
      [
        "whitespace-only email (present but unusable)",
        { accountEmail: "   " },
        "invalid_account_email",
      ],
      ["malformed email", { accountEmail: "not-an-email" }, "invalid_account_email"],
    ] as const) {
      test(`skips with a typed reason: ${label}`, async () => {
        const { result } = await connectSeed(over);

        assert.deepEqual(result.connectedCurrent, { status: "skipped", reason });
      });
    }

    describe("evidenceHash idempotency / lifecycle distinctness", () => {
      test("same credential + same occurredAt → identical evidenceHash (re-run/re-auth dedups)", async () => {
        const { credentialId, result } = await connectSeed({});

        assert.equal(result.connectedCurrent.status, "emitted");

        const again = await recordOrgAffiliationOnCredentialUpsert(
          { credentialId, changedAt: T0 },
          "own",
        );

        assert.equal(again.connectedCurrent.status, "deduped");
      });

      test("a later occurredAt → different evidenceHash (reconnect advances the family)", async () => {
        const { userId, credentialId, result } = await connectSeed({});

        assert.equal(result.connectedCurrent.status, "emitted");

        await db()
          .update(integrationCredentials)
          .set({ createdAt: new Date(T0.getTime() + 1000) })
          .where(eq(integrationCredentials.id, credentialId));

        const reconnected = await recordOrgAffiliationOnCredentialUpsert(
          { credentialId, changedAt: T0 },
          "own",
        );

        assert.equal(reconnected.connectedCurrent.status, "emitted");

        const familyKey = `org_affiliation:${ACCOUNT_ID}:oliv.ai`;

        const rows = await db()
          .select({
            occurredAt: observations.occurredAt,
            payload: observations.payload,
            supersedesObservationId: observations.supersedesObservationId,
          })
          .from(observations)
          .where(and(eq(observations.userId, userId), eq(observations.familyKey, familyKey)))
          .orderBy(asc(observations.occurredAt));

        assert.equal(rows.length, 2);
      });

      test("connected vs disconnected at the same time → different evidenceHash, same family", async () => {
        const { userId, result } = await connectSeed({});

        assert.equal(result.connectedCurrent.status, "emitted");

        const disconnected = await recordOrgAffiliationOnDisconnect(
          {
            userId,
            accountId: ACCOUNT_ID,
            accountEmail: "yash.k@oliv.ai",
            metadata: { googleHostedDomain: "oliv.ai" },
          },
          T0,
          "own",
        );

        assert.equal(disconnected.status, "emitted");

        const familyKey = `org_affiliation:${ACCOUNT_ID}:oliv.ai`;

        const rows = await db()
          .select({
            occurredAt: observations.occurredAt,
            payload: observations.payload,
            supersedesObservationId: observations.supersedesObservationId,
          })
          .from(observations)
          .where(and(eq(observations.userId, userId), eq(observations.familyKey, familyKey)))
          .orderBy(asc(observations.occurredAt));

        const [connectedRow, disconnectedRow] = rows;

        assert.equal(rows.length, 2);
        assert.ok(connectedRow);
        assert.ok(disconnectedRow);
        assert.equal(getStringPath(connectedRow.payload, "status"), "connected");
        assert.equal(getStringPath(disconnectedRow.payload, "status"), "disconnected");
        assert.equal(disconnectedRow.occurredAt.getTime(), T0.getTime());
      });
    });
  },
);

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

    const { connectedCurrent: connected } = await recordOrgAffiliationOnCredentialUpsert(
      { credentialId: firstCredentialId, changedAt: connectAt },
      "own",
    );

    assert.equal(connected.status, "emitted");

    const { connectedCurrent: duplicateConnect } = await recordOrgAffiliationOnCredentialUpsert(
      { credentialId: firstCredentialId, changedAt: connectAt },
      "own",
    );

    assert.equal(duplicateConnect.status, "deduped");

    const disconnected = await recordOrgAffiliationOnDisconnect(
      {
        userId,
        accountId,
        accountEmail: "yash.k@oliv.ai",
        metadata: { googleHostedDomain: "oliv.ai" },
      },
      disconnectAt,
      "own",
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

    const { connectedCurrent: reconnected } = await recordOrgAffiliationOnCredentialUpsert(
      { credentialId: secondCredentialId, changedAt: reconnectAt },
      "own",
    );

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
    assert.equal(getStringPath(rows[0]?.payload, "status"), "connected");
    assert.equal(rows[0]?.supersedesObservationId, null);
    assert.equal(getStringPath(rows[1]?.payload, "status"), "disconnected");
    assert.equal(rows[1]?.supersedesObservationId, rows[0].id);
    assert.equal(getStringPath(rows[2]?.payload, "status"), "connected");
    assert.equal(rows[2]?.supersedesObservationId, rows[1].id);

    const [head] = await db()
      .select({ headObservationId: observationFamilyHeads.headObservationId })
      .from(observationFamilyHeads)
      .where(
        and(
          eq(observationFamilyHeads.userId, userId),
          eq(observationFamilyHeads.familyKey, familyKey),
        ),
      );

    assert.equal(head?.headObservationId, rows[2].id);
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

    const { connectedCurrent: connected } = await recordOrgAffiliationOnCredentialUpsert(
      { credentialId, changedAt: connectAt },
      "own",
    );

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

    const changed = await recordOrgAffiliationOnCredentialUpsert(
      {
        credentialId,
        previousCredential,
        changedAt,
      },
      "own",
    );

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
    assert.equal(getStringPath(oldRows[0]?.payload, "status"), "connected");
    assert.equal(getStringPath(oldRows[1]?.payload, "status"), "disconnected");
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
    assert.equal(getStringPath(newRows[0]?.payload, "status"), "connected");
    assert.equal(newRows[0]?.occurredAt.getTime(), changedAt.getTime());
  });

  test("same-family grounding change connects at change time instead of backdating to credential creation", async () => {
    const userId = await seedUser();
    const accountId = `google-sub-${randomUUID()}`;
    const connectAt = new Date("2026-06-01T12:00:00.000Z");
    const changedAt = new Date("2026-06-04T12:00:00.000Z");

    const credentialId = await seedGoogleCredential({
      userId,
      accountId,
      accountEmail: "owner@oliv.ai",
      hostedDomain: null,
      createdAt: connectAt,
    });

    const { connectedCurrent: connected } = await recordOrgAffiliationOnCredentialUpsert(
      { credentialId, changedAt: connectAt },
      "own",
    );

    assert.equal(connected.status, "emitted");

    const previousCredential: CredentialForAffiliation = {
      userId,
      accountId,
      accountEmail: "owner@oliv.ai",
      metadata: {},
    };

    await db()
      .update(integrationCredentials)
      .set({ metadata: { googleHostedDomain: "oliv.ai" } })
      .where(eq(integrationCredentials.id, credentialId));

    const changed = await recordOrgAffiliationOnCredentialUpsert(
      {
        credentialId,
        previousCredential,
        changedAt,
      },
      "own",
    );

    assert.equal(changed.disconnectedPrevious, undefined);
    assert.equal(changed.connectedCurrent.status, "emitted");

    const rows = await db()
      .select({
        occurredAt: observations.occurredAt,
        supersedesObservationId: observations.supersedesObservationId,
        payload: observations.payload,
      })
      .from(observations)
      .where(
        and(
          eq(observations.userId, userId),
          eq(observations.familyKey, `org_affiliation:${accountId}:oliv.ai`),
        ),
      )
      .orderBy(asc(observations.occurredAt));

    assert.equal(rows.length, 2);
    assert.equal(getStringPath(rows[0]?.payload, "domainClass"), "ambiguous_domain");
    assert.equal(rows[0]?.occurredAt.getTime(), connectAt.getTime());
    assert.equal(getStringPath(rows[1]?.payload, "domainClass"), "corporate_domain");
    assert.equal(rows[1]?.occurredAt.getTime(), changedAt.getTime());
    assert.equal(rows[1].supersedesObservationId !== null, true);
  });
});
