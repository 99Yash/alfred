import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, test } from "node:test";

import { encryptedAuthAdapter, type AuthAdapter } from "../src/credential-adapter";
import { createCredentialVault, CredentialVaultError } from "@alfred/db/credential-vault";

/**
 * Coverage for the Better Auth adapter boundary (#453).
 *
 * The whole contract is a direction: the *inner* adapter (what reaches Postgres)
 * must only ever see envelopes, and the *outer* caller (Better Auth) must only
 * ever see plaintext. Every case below asserts both halves, because asserting
 * one alone cannot tell a working decorator from one that seals on write and
 * forgets to open on read.
 */

const vault = createCredentialVault(randomBytes(32));

const ACCESS = "ya29.access-token";
const REFRESH = "1//refresh-token";
const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig";

type Call = { op: string; model: string; payload: unknown };

/**
 * A recording adapter standing in for drizzle. `stored` is what "Postgres"
 * holds, so a test can read it back the way a real query would.
 */
function recordingAdapter() {
  const calls: Call[] = [];
  let stored: Record<string, unknown> = {};

  const fake = {
    id: "recording",
    create: async (data: { model: string; data: Record<string, unknown> }) => {
      calls.push({ op: "create", model: data.model, payload: data.data });
      stored = { id: "acc_1", ...data.data };
      return stored;
    },
    findOne: async (data: { model: string }) => {
      calls.push({ op: "findOne", model: data.model, payload: null });
      return stored;
    },
    findMany: async (data: { model: string }) => {
      calls.push({ op: "findMany", model: data.model, payload: null });
      return [stored];
    },
    update: async (data: { model: string; update: Record<string, unknown> }) => {
      calls.push({ op: "update", model: data.model, payload: data.update });
      stored = { ...stored, ...data.update };
      return stored;
    },
    updateMany: async (data: { model: string; update: Record<string, unknown> }) => {
      calls.push({ op: "updateMany", model: data.model, payload: data.update });
      stored = { ...stored, ...data.update };
      return 1;
    },
    count: async (data: { model: string }) => {
      calls.push({ op: "count", model: data.model, payload: null });
      return 1;
    },
    delete: async (data: { model: string }) => {
      calls.push({ op: "delete", model: data.model, payload: null });
    },
    deleteMany: async (data: { model: string }) => {
      calls.push({ op: "deleteMany", model: data.model, payload: null });
      return 1;
    },
    // Both added by better-auth 1.6.25. They take a `where` and return a row,
    // so they sit on the same side of this boundary as `findOne` and `update`.
    consumeOne: async (data: { model: string }) => {
      calls.push({ op: "consumeOne", model: data.model, payload: null });
      return stored;
    },
    incrementOne: async (data: {
      model: string;
      increment: Record<string, number>;
      set?: Record<string, unknown> | undefined;
    }) => {
      calls.push({ op: "incrementOne", model: data.model, payload: data.set ?? null });
      stored = { ...stored, ...data.set };
      return stored;
    },
    transaction: async <R>(callback: (trx: unknown) => Promise<R>) => {
      calls.push({ op: "transaction", model: "-", payload: null });
      // Hand the callback a *separate* undecorated handle, exactly as drizzle
      // does. If `encryptedAuthAdapter` forgets to recurse, the callback writes
      // plaintext and the assertions below catch it.
      return callback(fake);
    },
  };

  return {
    calls,
    setStored: (row: Record<string, unknown>) => {
      stored = row;
    },
    getStored: () => stored,
    // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- boundary cast: source type is structurally incompatible with target
    adapter: fake as unknown as AuthAdapter,
  };
}

function build() {
  const inner = recordingAdapter();
  const factory = encryptedAuthAdapter(() => inner.adapter, vault);
  // `betterAuth` passes its resolved options; the decorator does not read them.
  const outer = factory({} as Parameters<typeof factory>[0]);
  return { inner, outer };
}

/** The payload the inner adapter received for one operation. */
function payloadOf(
  inner: ReturnType<typeof recordingAdapter>,
  op: string,
): Record<string, unknown> {
  const call = inner.calls.find((c) => c.op === op);
  assert.ok(call, `expected the inner adapter to receive a ${op}`);
  assert.ok(call.payload && typeof call.payload === "object");
  return call.payload as Record<string, unknown>;
}

let harness: ReturnType<typeof build>;
beforeEach(() => {
  harness = build();
});

describe("encryptedAuthAdapter: account writes are sealed", () => {
  test("create seals all three token fields and returns plaintext", async () => {
    const created = await harness.outer.create<Record<string, unknown>, Record<string, unknown>>({
      model: "account",
      data: { accountId: "goog_1", accessToken: ACCESS, refreshToken: REFRESH, idToken: ID_TOKEN },
    });

    const written = payloadOf(harness.inner, "create");
    for (const [field, plaintext] of [
      ["accessToken", ACCESS],
      ["refreshToken", REFRESH],
      ["idToken", ID_TOKEN],
    ] as const) {
      assert.ok(vault.isSealed(written[field]), `${field} reached the database unsealed`);
      assert.notEqual(written[field], plaintext);
      assert.equal(created[field], plaintext, `${field} was not opened for the caller`);
    }
    // Non-secret columns pass through untouched.
    assert.equal(written.accountId, "goog_1");
  });

  test("update and updateMany seal the fields they carry", async () => {
    await harness.outer.update({
      model: "account",
      where: [{ field: "id", value: "acc_1" }],
      update: { accessToken: "ya29.rotated" },
    });
    const updated = payloadOf(harness.inner, "update");
    assert.ok(vault.isSealed(updated.accessToken));
    assert.equal(vault.open(updated.accessToken), "ya29.rotated");

    await harness.outer.updateMany({
      model: "account",
      where: [{ field: "userId", value: "usr_1" }],
      update: { refreshToken: "1//rotated", scope: "email" },
    });
    const many = payloadOf(harness.inner, "updateMany");
    assert.ok(vault.isSealed(many.refreshToken));
    assert.equal(vault.open(many.refreshToken), "1//rotated");
    assert.equal(many.scope, "email", "a non-secret field must not be touched");
  });

  test("update returns the opened row", async () => {
    harness.inner.setStored({ id: "acc_1", accessToken: vault.seal(ACCESS) });
    const result = await harness.outer.update<Record<string, unknown>>({
      model: "account",
      where: [{ field: "id", value: "acc_1" }],
      update: { scope: "email" },
    });
    assert.equal(result?.accessToken, ACCESS);
  });

  test("omitted and null token fields stay omitted and null", async () => {
    const created = await harness.outer.create<Record<string, unknown>, Record<string, unknown>>({
      model: "account",
      data: { accountId: "goog_1", accessToken: ACCESS, refreshToken: null },
    });
    const written = payloadOf(harness.inner, "create");
    assert.equal(written.refreshToken, null, "null must not be sealed into a string");
    assert.ok(!("idToken" in written), "an absent field must not be invented");
    assert.equal(created.refreshToken, null);
  });
});

describe("encryptedAuthAdapter: account reads are opened", () => {
  beforeEach(() => {
    harness.inner.setStored({
      id: "acc_1",
      accountId: "goog_1",
      accessToken: vault.seal(ACCESS),
      refreshToken: vault.seal(REFRESH),
      idToken: vault.seal(ID_TOKEN),
      scope: "email profile",
    });
  });

  test("findOne opens every token field", async () => {
    const row = await harness.outer.findOne<Record<string, unknown>>({
      model: "account",
      where: [{ field: "id", value: "acc_1" }],
    });
    assert.equal(row?.accessToken, ACCESS);
    assert.equal(row?.refreshToken, REFRESH);
    assert.equal(row?.idToken, ID_TOKEN);
    assert.equal(row?.scope, "email profile");
  });

  test("findMany opens every row", async () => {
    const rows = await harness.outer.findMany<Record<string, unknown>>({ model: "account" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.accessToken, ACCESS);
  });

  test("a projection that omits the tokens still works", async () => {
    harness.inner.setStored({ id: "acc_1", scope: "email" });
    const row = await harness.outer.findOne<Record<string, unknown>>({
      model: "account",
      where: [{ field: "id", value: "acc_1" }],
      select: ["id", "scope"],
    });
    assert.equal(row?.scope, "email");
    assert.ok(!("accessToken" in (row ?? {})));
  });

  test("a plaintext row fails closed instead of passing through", async () => {
    // The rollout's real risk: a row the backfill missed. Serving it would keep
    // the system working while it still held usable tokens.
    harness.inner.setStored({ id: "acc_1", accessToken: "ya29.never-encrypted" });
    await assert.rejects(
      () => harness.outer.findOne({ model: "account", where: [{ field: "id", value: "acc_1" }] }),
      CredentialVaultError,
    );
  });
});

describe("encryptedAuthAdapter: scope of the boundary", () => {
  test("other models pass through untouched in both directions", async () => {
    // `session.token` looks like a secret and is deliberately NOT in scope: it
    // is a Better Auth session id, and sealing it would break every lookup.
    const created = await harness.outer.create<Record<string, unknown>, Record<string, unknown>>({
      model: "session",
      data: { token: "sess_plain", accessToken: "not-an-account-field" },
    });
    const written = payloadOf(harness.inner, "create");
    assert.equal(written.token, "sess_plain");
    assert.equal(
      written.accessToken,
      "not-an-account-field",
      "a same-named field on another model must not be sealed",
    );
    assert.equal(created.accessToken, "not-an-account-field");
  });

  test("count, delete, and deleteMany delegate unchanged", async () => {
    assert.equal(await harness.outer.count({ model: "account" }), 1);
    await harness.outer.delete({ model: "account", where: [{ field: "id", value: "acc_1" }] });
    assert.equal(
      await harness.outer.deleteMany({ model: "account", where: [{ field: "id", value: "x" }] }),
      1,
    );
    assert.deepEqual(
      harness.inner.calls.map((c) => c.op),
      ["count", "delete", "deleteMany"],
    );
  });

  /**
   * `consumeOne` and `incrementOne` arrived with better-auth 1.6.25 and crossed
   * this boundary undecorated, because completeness rested on a spread. Nothing
   * routes them at `account` today — verification tokens and rate limits only —
   * so these cases pin the boundary rather than a live path.
   */
  test("consumeOne opens the row it deletes", async () => {
    harness.inner.setStored({ id: "acc_1", accessToken: vault.seal(ACCESS) });
    const consumed = await harness.outer.consumeOne<{ accessToken: string }>({
      model: "account",
      where: [{ field: "id", value: "acc_1" }],
    });
    assert.equal(
      consumed?.accessToken,
      ACCESS,
      "an undecorated consumeOne hands Better Auth an envelope and it uses it as a token",
    );
  });

  test("incrementOne seals its `set` map and opens the result", async () => {
    const bumped = await harness.outer.incrementOne<{ accessToken: string }>({
      model: "account",
      where: [{ field: "id", value: "acc_1" }],
      increment: { failedAttempts: 1 },
      // `set` writes absolute values atomically alongside the increments, so it
      // is a token write path.
      set: { accessToken: "ya29.replaced" },
    });

    const written = payloadOf(harness.inner, "incrementOne");
    assert.ok(vault.isSealed(written.accessToken), "`set` reached the database unsealed");
    assert.equal(bumped?.accessToken, "ya29.replaced", "the result was not opened for the caller");
  });

  test("an increment on a sealed column is refused", async () => {
    // A sealed field holds a string envelope, so `field = field + 1` is
    // incoherent rather than merely wrong.
    await assert.rejects(
      () =>
        harness.outer.incrementOne({
          model: "account",
          where: [{ field: "id", value: "acc_1" }],
          increment: { accessToken: 1 },
        }),
      CredentialVaultError,
    );
    assert.equal(harness.inner.calls.length, 0);
  });

  test("consumeOne and incrementOne leave other models alone", async () => {
    harness.inner.setStored({ id: "ver_1", value: "plain-verification-token" });
    const consumed = await harness.outer.consumeOne<{ value: string }>({
      model: "verification",
      where: [{ field: "identifier", value: "x" }],
    });
    assert.equal(consumed?.value, "plain-verification-token");

    const limited = await harness.outer.incrementOne<{ value: string }>({
      model: "rateLimit",
      where: [{ field: "key", value: "k" }],
      increment: { count: 1 },
    });
    assert.equal(limited?.value, "plain-verification-token");
  });

  test("a where clause on a sealed column is rejected, not silently unmatched", async () => {
    // Fresh nonces mean `where accessToken = <plaintext>` can never match. A
    // pass-through would answer "no such account" in the middle of a sign-in.
    await assert.rejects(
      () =>
        harness.outer.findOne({
          model: "account",
          where: [{ field: "accessToken", value: ACCESS }],
        }),
      CredentialVaultError,
    );
    assert.equal(
      harness.inner.calls.length,
      0,
      "the rejected query must not reach the database at all",
    );
  });

  test("every member that takes a where rejects a sealed column", async () => {
    // The guard is on the `where`, not on the return value, so it has to cover
    // the members that carry no token at all. Without it these answer "0 rows"
    // and "count 0" — the same silent wrong answer, just quieter than a failed
    // sign-in.
    const sealedWhere = [{ field: "refreshToken", value: REFRESH }];
    await assert.rejects(
      () => harness.outer.count({ model: "account", where: sealedWhere }),
      CredentialVaultError,
    );
    await assert.rejects(
      () => harness.outer.delete({ model: "account", where: sealedWhere }),
      CredentialVaultError,
    );
    await assert.rejects(
      () => harness.outer.deleteMany({ model: "account", where: sealedWhere }),
      CredentialVaultError,
    );
    await assert.rejects(
      () => harness.outer.findMany({ model: "account", where: sealedWhere }),
      CredentialVaultError,
    );
    await assert.rejects(
      () => harness.outer.updateMany({ model: "account", where: sealedWhere, update: {} }),
      CredentialVaultError,
    );
    await assert.rejects(
      () => harness.outer.consumeOne({ model: "account", where: sealedWhere }),
      CredentialVaultError,
    );
    await assert.rejects(
      () =>
        harness.outer.incrementOne({
          model: "account",
          where: sealedWhere,
          increment: { failedAttempts: 1 },
        }),
      CredentialVaultError,
    );
    assert.equal(harness.inner.calls.length, 0);
  });
});

describe("encryptedAuthAdapter: transactions", () => {
  test("the transaction handle is decorated too", async () => {
    // Better Auth links a social account inside a transaction, so this is the
    // one write that actually stores a fresh OAuth token. An undecorated handle
    // would write plaintext.
    const linked = await harness.outer.transaction(async (trx) =>
      trx.create<Record<string, unknown>, Record<string, unknown>>({
        model: "account",
        data: { accountId: "goog_1", accessToken: ACCESS },
      }),
    );

    const written = payloadOf(harness.inner, "create");
    assert.ok(vault.isSealed(written.accessToken), "the transactional write bypassed the vault");
    assert.equal(linked.accessToken, ACCESS);
    assert.ok(harness.inner.calls.some((c) => c.op === "transaction"));
  });

  test("reads inside a transaction are opened", async () => {
    harness.inner.setStored({ id: "acc_1", accessToken: vault.seal(ACCESS) });
    const row = await harness.outer.transaction(async (trx) =>
      trx.findOne<Record<string, unknown>>({
        model: "account",
        where: [{ field: "id", value: "acc_1" }],
      }),
    );
    assert.equal(row?.accessToken, ACCESS);
  });
});

describe("encryptedAuthAdapter: declared joins", () => {
  test("an account joined onto another model is opened", async () => {
    harness.inner.setStored({
      id: "ses_1",
      token: "sess_plain",
      account: [{ id: "acc_1", accessToken: vault.seal(ACCESS) }],
    });
    const row = await harness.outer.findOne<{
      token: string;
      account: Array<{ accessToken: string }>;
    }>({
      model: "session",
      where: [{ field: "id", value: "ses_1" }],
      join: { account: true },
    });
    assert.equal(row?.token, "sess_plain");
    assert.equal(row?.account[0]?.accessToken, ACCESS);
  });

  test("an outer model may filter on a same-named field while joining account", async () => {
    harness.inner.setStored({
      id: "ses_1",
      accessToken: "session-index-value",
      account: [{ id: "acc_1", accessToken: vault.seal(ACCESS) }],
    });
    const row = await harness.outer.findOne<{
      account: Array<{ accessToken: string }>;
    }>({
      model: "session",
      where: [{ field: "accessToken", value: "session-index-value" }],
      join: { account: true },
    });
    assert.equal(row?.account[0]?.accessToken, ACCESS);
  });

  test("a one-to-one join yields an object, and is opened", async () => {
    harness.inner.setStored({
      id: "ses_1",
      account: { id: "acc_1", accessToken: vault.seal(ACCESS) },
    });
    const row = await harness.outer.findOne<{ account: { accessToken: string } }>({
      model: "session",
      where: [{ field: "id", value: "ses_1" }],
      join: { account: true },
    });
    assert.equal(row?.account.accessToken, ACCESS);
  });

  test("a join to some other model is left alone", async () => {
    // The transform is driven by the declared join key, not by a walk for keys
    // that happen to be named `accessToken`.
    harness.inner.setStored({
      id: "ses_1",
      user: { id: "usr_1", accessToken: "some-unrelated-value" },
    });
    const row = await harness.outer.findOne<{ user: { accessToken: string } }>({
      model: "session",
      where: [{ field: "id", value: "ses_1" }],
      join: { user: true },
    });
    assert.equal(row?.user.accessToken, "some-unrelated-value");
  });
});
