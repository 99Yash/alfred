import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { DOCS_SCOPE, DRIVE_SCOPE, GMAIL_READONLY_SCOPE } from "@alfred/integrations/google";
import { inArray, like } from "drizzle-orm";

import { AppError } from "../../src/lib/app-errors";
import {
  activeGoogleCredentials,
  resolveGoogleCredential,
} from "../../src/modules/tools/google-credentials";

/**
 * DB-backed test for the shared Google credential resolver. Pins the behavior
 * the six tool pickers now share — in particular the scope enforcement that
 * docs/sheets/slides previously lacked (a Gmail-only account used to be handed
 * to a Drive/Docs call and silently 403).
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated
 * Postgres; skipped otherwise. Seeds throwaway `test-gcreds-*` users and
 * cascades them (and their credentials) away on teardown.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-gcreds-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

async function seedCredential(
  userId: string,
  opts: { scopes: string[]; status?: string },
): Promise<string> {
  const [row] = await db()
    .insert(integrationCredentials)
    .values({
      userId,
      provider: "google",
      accountId: randomUUID(),
      accessToken: "at",
      refreshToken: "rt",
      scopes: opts.scopes,
      status: opts.status ?? "active",
    })
    .returning({ id: integrationCredentials.id });
  assert.ok(row, "seed credential returned no row");
  return row.id;
}

async function expectAppError(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.code, code, `expected AppError code ${code}, got ${err.code}`);
    return true;
  });
}

describe("shared Google credential resolver (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("no connected account → noConnection error", async () => {
    const userId = await seedUser();
    await expectAppError(
      () =>
        resolveGoogleCredential(userId, {
          scopes: [DRIVE_SCOPE],
          noConnection: "drive_connection_required",
          noScope: "drive_scope_required",
        }),
      "drive_connection_required",
    );
  });

  test("connected but lacking the scope → noScope error (the docs/sheets/slides 403 fix)", async () => {
    const userId = await seedUser();
    // A Gmail-only account: previously handed to a Docs call and 403'd.
    await seedCredential(userId, { scopes: [GMAIL_READONLY_SCOPE] });
    await expectAppError(
      () =>
        resolveGoogleCredential(userId, {
          scopes: [DOCS_SCOPE],
          noConnection: "google_connection_required",
          noScope: "docs_scope_required",
        }),
      "docs_scope_required",
    );
  });

  test("noScope falls back to noConnection when omitted", async () => {
    const userId = await seedUser();
    await seedCredential(userId, { scopes: [GMAIL_READONLY_SCOPE] });
    await expectAppError(
      () =>
        resolveGoogleCredential(userId, {
          scopes: [DRIVE_SCOPE],
          noConnection: "drive_connection_required",
        }),
      "drive_connection_required",
    );
  });

  test("picks the scope-satisfying credential among several", async () => {
    const userId = await seedUser();
    await seedCredential(userId, { scopes: [GMAIL_READONLY_SCOPE] });
    const driveId = await seedCredential(userId, { scopes: [DRIVE_SCOPE] });
    const resolved = await resolveGoogleCredential(userId, {
      scopes: [DRIVE_SCOPE],
      noConnection: "drive_connection_required",
      noScope: "drive_scope_required",
    });
    assert.equal(resolved.id, driveId, "must pick the Drive-scoped credential, not first-active");
  });

  test("a needs_reauth credential is not eligible", async () => {
    const userId = await seedUser();
    await seedCredential(userId, { scopes: [DRIVE_SCOPE], status: "needs_reauth" });
    await expectAppError(
      () =>
        resolveGoogleCredential(userId, {
          scopes: [DRIVE_SCOPE],
          noConnection: "drive_connection_required",
          noScope: "drive_scope_required",
        }),
      "drive_connection_required",
    );
  });

  test("activeGoogleCredentials (scopeless) returns every active account", async () => {
    // `resolveGoogleCredential` requires a scope policy (a scopeless resolve
    // would reintroduce the first-active mis-routing bug), but the plural
    // finder still accepts an omitted scope — the singular resolver relies on
    // that to fetch all active accounts before filtering by policy scope.
    const userId = await seedUser();
    const a = await seedCredential(userId, { scopes: [GMAIL_READONLY_SCOPE] });
    const b = await seedCredential(userId, { scopes: [DRIVE_SCOPE] });
    await seedCredential(userId, { scopes: [DRIVE_SCOPE], status: "needs_reauth" }); // inactive
    const ids = (await activeGoogleCredentials(userId)).map((c) => c.id).sort();
    assert.deepEqual(ids, [a, b].sort(), "every active account, no scope filter");
  });

  test("activeGoogleCredentials returns every scope-satisfying active account", async () => {
    const userId = await seedUser();
    const a = await seedCredential(userId, { scopes: [GMAIL_READONLY_SCOPE, DRIVE_SCOPE] });
    const b = await seedCredential(userId, { scopes: [DRIVE_SCOPE] });
    await seedCredential(userId, { scopes: [GMAIL_READONLY_SCOPE] }); // not Drive-scoped
    await seedCredential(userId, { scopes: [DRIVE_SCOPE], status: "needs_reauth" }); // inactive
    const ids = (await activeGoogleCredentials(userId, [DRIVE_SCOPE])).map((c) => c.id).sort();
    assert.deepEqual(ids, [a, b].sort(), "only active Drive-scoped credentials");
  });
});
