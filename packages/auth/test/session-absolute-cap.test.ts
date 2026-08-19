import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { makeSignature } from "better-auth/crypto";
import type { AuthAdapter, AuthAdapterFactory } from "../src/credential-adapter";
import { authSessionPolicy, SESSION_LIFETIME_SECONDS } from "../src/session-policy";

// eslint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test boundary: one adapter stores Better Auth's generic model rows and validates every field it reads below
type Row = Record<string, unknown>;

function matches(row: Row, where: Array<{ field: string; value: unknown }> = []): boolean {
  return where.every(({ field, value }) => row[field] === value);
}

/** A shared two-instance store that exercises Better Auth's real handler and hooks. */
function sessionStore(
  sessionOrigin: Date,
  firstExpiry: Date,
  { failSessionFindManyOnce = false } = {},
) {
  const rows = new Map<string, Row[]>();
  const deleteCalls: Array<Parameters<AuthAdapter["delete"]>[0]> = [];
  let sessionFindManyFailures = 0;
  const table = (model: string) => {
    const existing = rows.get(model);
    if (existing) return existing;
    const created: Row[] = [];
    rows.set(model, created);
    return created;
  };

  const adapter = {
    id: "session-policy-memory",
    create: async ({ model, data }: { model: string; data: Row }) => {
      const row = {
        id: data.id ?? `${model}-${table(model).length + 1}`,
        ...data,
        ...(model === "session" ? { createdAt: sessionOrigin, expiresAt: firstExpiry } : {}),
      };
      table(model).push(row);
      return row;
    },
    findOne: async ({
      model,
      where,
      join,
    }: {
      model: string;
      where?: Array<{ field: string; value: unknown }>;
      join?: Row;
    }) => {
      const row = table(model).find((candidate) => matches(candidate, where));
      if (!row) return null;
      if (model === "session" && join?.user) {
        const user = table("user").find((candidate) => candidate.id === row.userId);
        return user ? { ...row, user } : null;
      }
      return row;
    },
    findMany: async ({ model, where }: Parameters<AuthAdapter["findMany"]>[0]) => {
      if (model === "session" && failSessionFindManyOnce && sessionFindManyFailures === 0) {
        sessionFindManyFailures += 1;
        throw new Error("transient session snapshot failure");
      }
      return table(model).filter((candidate) => matches(candidate, where));
    },
    update: async ({
      model,
      update,
      where,
    }: {
      model: string;
      update: Row;
      where?: Array<{ field: string; value: unknown }>;
    }) => {
      const row = table(model).find((candidate) => matches(candidate, where));
      if (!row) return null;
      Object.assign(row, update);
      return row;
    },
    updateMany: async ({
      model,
      update,
      where,
    }: {
      model: string;
      update: Row;
      where?: Array<{ field: string; value: unknown }>;
    }) => {
      const found = table(model).filter((candidate) => matches(candidate, where));
      for (const row of found) Object.assign(row, update);
      return found.length;
    },
    delete: async (input: Parameters<AuthAdapter["delete"]>[0]) => {
      deleteCalls.push(input);
      const { model, where } = input;
      const index = table(model).findIndex((candidate) => matches(candidate, where));
      if (index >= 0) table(model).splice(index, 1);
    },
    deleteMany: async ({
      model,
      where,
    }: {
      model: string;
      where?: Array<{ field: string; value: unknown }>;
    }) => {
      const kept = table(model).filter((candidate) => !matches(candidate, where));
      const deleted = table(model).length - kept.length;
      rows.set(model, kept);
      return deleted;
    },
    count: async ({
      model,
      where,
    }: {
      model: string;
      where?: Array<{ field: string; value: unknown }>;
    }) => table(model).filter((candidate) => matches(candidate, where)).length,
    consumeOne: async ({
      model,
      where,
    }: {
      model: string;
      where?: Array<{ field: string; value: unknown }>;
    }) => {
      const index = table(model).findIndex((candidate) => matches(candidate, where));
      if (index < 0) return null;
      return table(model).splice(index, 1)[0] ?? null;
    },
    incrementOne: async ({
      model,
      where,
      increment,
      set,
    }: {
      model: string;
      where?: Array<{ field: string; value: unknown }>;
      increment: Record<string, number>;
      set?: Row;
    }) => {
      const row = table(model).find((candidate) => matches(candidate, where));
      if (!row) return null;
      for (const [field, amount] of Object.entries(increment)) {
        row[field] = Number(row[field] ?? 0) + amount;
      }
      Object.assign(row, set);
      return row;
    },
    transaction: async <R>(callback: (trx: AuthAdapter) => Promise<R>) =>
      // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test boundary: the callback sees the same focused adapter that the factory exposes
      callback(adapter as unknown as AuthAdapter),
  };

  // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test boundary: the focused in-memory adapter implements the operations Better Auth drives here
  const factory = (() => adapter as unknown as AuthAdapter) as AuthAdapterFactory;
  return {
    deleteCalls: (): readonly Parameters<AuthAdapter["delete"]>[0][] => deleteCalls,
    factory,
    session: () => table("session")[0],
    sessionFindManyFailures: () => sessionFindManyFailures,
    sessions: (): readonly Row[] => table("session"),
  };
}

describe("absolute session cap at the Better Auth boundary (#454)", () => {
  test("the first late get-access-token request cannot open a legacy row", async (t) => {
    const dayMs = 24 * 60 * 60 * 1000;
    const originMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    const nowMs = originMs + 31 * dayMs;
    const legacyExpiryMs = originMs + 36 * dayMs;
    t.mock.timers.enable({ apis: ["Date"], now: nowMs });

    // This row is valid under the old sliding policy but is already one day
    // past the newly deployed absolute deadline. Its first read must not get
    // one authorized request before the update hook can clamp it.
    const store = sessionStore(new Date(originMs), new Date(legacyExpiryMs));
    const owner = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "test-secret-that-is-at-least-thirty-two-characters",
      database: store.factory,
      ...authSessionPolicy(),
      socialProviders: {
        google: {
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        },
      },
    });
    const context = await owner.$context;
    const user = await context.internalAdapter.createUser({
      id: "legacy-user",
      email: "legacy@example.com",
      emailVerified: true,
      name: "Legacy Session",
    });
    const targetSession = await context.internalAdapter.createSession(user.id);
    const siblingSession = await context.internalAdapter.createSession(user.id);
    await context.internalAdapter.createAccount({
      accountId: "legacy-google-account",
      providerId: "google",
      userId: user.id,
      accessToken: "plaintext-google-token",
      accessTokenExpiresAt: new Date(nowMs + dayMs),
    });
    const signedToken = `${targetSession.token}.${await makeSignature(targetSession.token, context.secret)}`;

    const response = await owner.handler(
      new Request("http://localhost:3000/api/auth/get-access-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${context.authCookies.sessionToken.name}=${signedToken}`,
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ providerId: "google" }),
      }),
    );

    assert.equal(response.status, 401);
    assert.doesNotMatch(await response.text(), /plaintext-google-token/);
    assert.deepEqual(store.deleteCalls(), [
      {
        model: "session",
        where: [{ field: "token", value: targetSession.token }],
      },
    ]);
    assert.deepEqual(
      store.sessions().map((row) => row.token),
      [siblingSession.token],
      "the read guard must retire only the session named by the verified cookie",
    );
  });

  test("an over-age request is denied when Better Auth skips cleanup", async (t) => {
    const dayMs = 24 * 60 * 60 * 1000;
    const originMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    const nowMs = originMs + 31 * dayMs;
    const store = sessionStore(new Date(originMs), new Date(originMs + 36 * dayMs), {
      failSessionFindManyOnce: true,
    });
    t.mock.timers.enable({ apis: ["Date"], now: nowMs });

    const owner = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "test-secret-that-is-at-least-thirty-two-characters",
      database: store.factory,
      ...authSessionPolicy(),
      socialProviders: {
        google: {
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        },
      },
    });
    const context = await owner.$context;
    const user = await context.internalAdapter.createUser({
      id: "cleanup-failure-user",
      email: "cleanup-failure@example.com",
      emailVerified: true,
      name: "Cleanup Failure",
    });
    const session = await context.internalAdapter.createSession(user.id);
    await context.internalAdapter.createAccount({
      accountId: "cleanup-failure-google-account",
      providerId: "google",
      userId: user.id,
      accessToken: "plaintext-google-token",
      accessTokenExpiresAt: new Date(nowMs + dayMs),
    });
    const signedToken = `${session.token}.${await makeSignature(session.token, context.secret)}`;

    const response = await owner.handler(
      new Request("http://localhost:3000/api/auth/get-access-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${context.authCookies.sessionToken.name}=${signedToken}`,
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ providerId: "google" }),
      }),
    );

    assert.equal(store.sessionFindManyFailures(), 1);
    assert.deepEqual(store.deleteCalls(), []);
    assert.equal(store.session()?.token, session.token, "Better Auth skipped the failed delete");
    assert.equal(response.status, 401);
    assert.doesNotMatch(await response.text(), /plaintext-google-token/);
  });

  test("a second Better Auth instance inherits the persisted cap", async (t) => {
    const dayMs = 24 * 60 * 60 * 1000;
    const originMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    const slideMs = originMs + 24 * dayMs;
    const capMs = originMs + SESSION_LIFETIME_SECONDS.absoluteMax * 1000;
    t.mock.timers.enable({ apis: ["Date"], now: slideMs });

    // A day-24 row is at Better Auth's refresh threshold. Its proposed slide is
    // day 31, so the owner hook must persist day 30 instead.
    const store = sessionStore(new Date(originMs), new Date(capMs));
    const writer = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "test-secret-that-is-at-least-thirty-two-characters",
      database: store.factory,
      ...authSessionPolicy(),
    });
    const secondProcess = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "test-secret-that-is-at-least-thirty-two-characters",
      database: store.factory,
      ...authSessionPolicy(),
    });
    const context = await writer.$context;
    const user = await context.internalAdapter.createUser({
      id: "user-1",
      email: "session@example.com",
      emailVerified: true,
      name: "Session Test",
    });
    const session = await context.internalAdapter.createSession(user.id);
    const signedToken = `${session.token}.${await makeSignature(session.token, context.secret)}`;
    const headers = new Headers({
      cookie: `${context.authCookies.sessionToken.name}=${signedToken}`,
    });

    const refreshed = await writer.handler(
      new Request("http://localhost:3000/api/auth/get-session", { headers }),
    );
    assert.equal(refreshed.status, 200);
    const persistedExpiry = store.session()?.expiresAt;
    assert.ok(persistedExpiry instanceof Date);
    assert.equal(persistedExpiry.getTime(), capMs);

    t.mock.timers.setTime(capMs);
    await assert.rejects(
      secondProcess.api.getSession({ headers }),
      (error) => error instanceof APIError && error.statusCode === 401,
    );
  });
});
