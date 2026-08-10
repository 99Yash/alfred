import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { closeConnections, db } from "@alfred/db";
import type { SealedCredentialSecret } from "@alfred/db/credential-vault";
import { ingestionState, integrationCredentials, user } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";

// Imports the RELOCATED consumer module (Phase-5 item 01). The cursor-seed
// logic used to live in the provider package's `google/watch.ts`
// (`seedHistoryCursorIfAbsent`); it now lives here so `@alfred/integrations`
// writes no ingestion-domain tables. This test pins the relocated seam so a
// byte-identical move is provably unchanged — and it is the one delicate piece
// of the move (Risk: a watch install that fails to seed a cursor drops a
// freshly-watched credential into perpetual full re-sync).
import { seedGmailHistoryCursorIfAbsent } from "@alfred/assistant/connections/ingestion/internal";

const ID_PREFIX = "test-gmail-ingest-";
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const createdUserIds: string[] = [];

after(async () => {
  if (createdUserIds.length) {
    // integration_credentials + ingestion_state cascade on user delete.
    await db().delete(user).where(inArray(user.id, createdUserIds));
  }
  await closeConnections();
});

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Gmail Ingest Test", email: `${userId}@example.test` });
  return userId;
}

async function seedGoogleCredential(userId: string): Promise<string> {
  const [row] = await db()
    .insert(integrationCredentials)
    .values({
      userId,
      provider: "google",
      accountId: randomUUID(),
      accountLabel: `${userId}@example.test`,
      // Deliberate unsealed write: this test never opens the token; the seed
      // path only reads `user_id` off the credential row.
      accessToken: "access-token" as unknown as SealedCredentialSecret,
      refreshToken: "refresh-token" as unknown as SealedCredentialSecret,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [],
      status: "active",
    })
    .returning({ id: integrationCredentials.id });
  assert.ok(row);
  return row.id;
}

async function loadCursor(credentialId: string): Promise<{
  historyId: string | undefined;
  lastSyncAt: Date | null;
} | null> {
  const rows = await db()
    .select({ state: ingestionState.state, lastSyncAt: ingestionState.lastSyncAt })
    .from(ingestionState)
    .where(
      and(eq(ingestionState.credentialId, credentialId), eq(ingestionState.stream, "messages")),
    );
  const row = rows[0];
  if (!row) return null;
  const state = row.state as { historyId?: string } | undefined;
  return { historyId: state?.historyId, lastSyncAt: row.lastSyncAt };
}

describe(
  "seedGmailHistoryCursorIfAbsent — relocated cursor seed (DB-backed)",
  { skip: SKIP },
  () => {
    test("seeds a messages-stream cursor row when none exists", async () => {
      const userId = await seedUser();
      const credentialId = await seedGoogleCredential(userId);

      assert.equal(await loadCursor(credentialId), null, "no cursor before seed");

      await seedGmailHistoryCursorIfAbsent({ credentialId, historyId: "1000" });

      const seeded = await loadCursor(credentialId);
      assert.ok(seeded, "cursor row exists after seed");
      assert.equal(seeded.historyId, "1000", "cursor seeded to the watch baseline historyId");
      assert.equal(seeded.lastSyncAt, null, "seed leaves last_sync_at null (no delta synced yet)");
    });

    test("is a no-op that never resets an existing cursor (renewal safety)", async () => {
      const userId = await seedUser();
      const credentialId = await seedGoogleCredential(userId);

      await seedGmailHistoryCursorIfAbsent({ credentialId, historyId: "1000" });
      // A renewal re-seeds with a fresh baseline; it must NOT roll the rolling
      // cursor backward or forward — the poll/webhook deltas own it after seed.
      await seedGmailHistoryCursorIfAbsent({ credentialId, historyId: "500" });

      const after = await loadCursor(credentialId);
      assert.ok(after);
      assert.equal(after.historyId, "1000", "existing cursor preserved across re-seed");
    });

    test("throws when the credential row is absent (FK cannot be satisfied)", async () => {
      await assert.rejects(
        () =>
          seedGmailHistoryCursorIfAbsent({
            credentialId: `missing-${randomUUID()}`,
            historyId: "1",
          }),
        /credential vanished mid-install/,
      );
    });
  },
);
