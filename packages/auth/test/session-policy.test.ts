import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ensureAuthTestEnv } from "./support/env";

/**
 * Coverage for the session lifetime (#454).
 *
 * Three of the four numbers restate a Better Auth default, so every case here
 * asserts an exact value rather than "is a number". The point of the issue was
 * that a default is not a decision: a case that accepted any number would pass
 * against the very silent-default drift the block exists to stop.
 */

// Set before the imports below, not with a static import: the auth module
// reaches `serverEnv()` and `@alfred/db`, and a static import is hoisted above
// this line. See `.lessons/import-environment-sensitive-modules-after-test-fixtures.md`.
ensureAuthTestEnv();

const [{ SESSION_LIFETIME_SECONDS, authSessionPolicy }, { createAuthMiddleware }, { auth }] =
  await Promise.all([
    import("../src/session-policy"),
    import("better-auth/api"),
    import("../src/index"),
  ]);

const DAY_SECONDS = 60 * 60 * 24;

function sessionUpdateHook() {
  const before = authSessionPolicy().databaseHooks.session?.update?.before;
  assert.ok(before, "the session update boundary must clamp sliding expiry");
  return before;
}

function updateContext(createdAt: Date) {
  // SAFETY: The hook reads only `context.session.session.createdAt`; this fixture
  // supplies that exact Better Auth-owned path and no other context capability.
  return {
    context: {
      session: {
        session: { createdAt },
      },
    },
  } as Parameters<ReturnType<typeof sessionUpdateHook>>[1];
}

describe("session lifetime (#454)", () => {
  test("the block states an idle window, a slide step and a freshness window", () => {
    const { session } = authSessionPolicy();
    assert.equal(session.expiresIn, DAY_SECONDS * 7, "idle window moved");
    assert.equal(session.updateAge, DAY_SECONDS, "slide step moved");
    assert.equal(session.freshAge, DAY_SECONDS, "freshness window moved");
  });

  test("freshness stays on", () => {
    // Better Auth reads `freshAge: 0` as "always fresh" and skips its freshness
    // checks. That disables the policy; it is not a shorter window. Route
    // behavior belongs in `docs/reference/auth.md`.
    assert.notEqual(authSessionPolicy().session.freshAge, 0);
  });

  test("the absolute cap sits above the idle window", () => {
    // A cap below the idle window would not be a cap: it would silently become
    // the idle window instead, and every "7 day" statement about this system
    // would be wrong.
    assert.equal(SESSION_LIFETIME_SECONDS.absoluteMax, DAY_SECONDS * 30);
    assert.ok(
      SESSION_LIFETIME_SECONDS.absoluteMax > SESSION_LIFETIME_SECONDS.idle,
      "the absolute cap must not undercut the idle window",
    );
  });

  test("a sliding update cannot persist an expiry beyond the absolute cap", async (t) => {
    const now = Date.UTC(2026, 7, 18, 12, 0, 0);
    t.mock.timers.enable({ apis: ["Date"], now });
    const createdAt = new Date(now - DAY_SECONDS * 24 * 1000);
    const proposedExpiry = new Date(now + DAY_SECONDS * 7 * 1000);

    const result = await sessionUpdateHook()(
      { expiresAt: proposedExpiry },
      updateContext(createdAt),
    );

    assert.deepEqual(result, {
      data: {
        expiresAt: new Date(createdAt.getTime() + SESSION_LIFETIME_SECONDS.absoluteMax * 1000),
      },
    });
  });

  test("an early sliding update keeps Better Auth's shorter proposed expiry", async (t) => {
    const now = Date.UTC(2026, 7, 18, 12, 0, 0);
    t.mock.timers.enable({ apis: ["Date"], now });
    const proposedExpiry = new Date(now + DAY_SECONDS * 7 * 1000);
    const result = await sessionUpdateHook()(
      { expiresAt: proposedExpiry },
      updateContext(new Date(now)),
    );

    assert.deepEqual(result, { data: { expiresAt: proposedExpiry } });
  });

  test("the clamp is stable across repeated late updates and at the deadline", async (t) => {
    const now = Date.UTC(2026, 7, 18, 12, 0, 0);
    t.mock.timers.enable({ apis: ["Date"], now });
    const createdAt = new Date(now - DAY_SECONDS * 30 * 1000);
    const hook = sessionUpdateHook();

    for (const proposedExpiry of [
      new Date(now + DAY_SECONDS * 7 * 1000),
      new Date(now + DAY_SECONDS * 14 * 1000),
    ]) {
      const result = await hook({ expiresAt: proposedExpiry }, updateContext(createdAt));
      assert.deepEqual(result, { data: { expiresAt: new Date(now) } });
    }
  });

  test("an unusable origin or missing request session fails closed", async () => {
    const hook = sessionUpdateHook();
    assert.equal(await hook({ expiresAt: new Date() }, null), false);
    assert.equal(await hook({ expiresAt: new Date() }, updateContext(new Date(Number.NaN))), false);
  });

  test("an after hook composes without exposing replacement of the owner before hook", () => {
    const after = createAuthMiddleware(async () => {});
    const attemptedBefore = createAuthMiddleware(async () => {});
    const policy = authSessionPolicy({
      hooks: {
        after,
        // @ts-expect-error The auth owner does not accept a replacement before hook.
        before: attemptedBefore,
      },
    });

    assert.equal(policy.hooks.after, after, "the unrelated after hook must be preserved");
    assert.notEqual(
      policy.hooks.before,
      attemptedBefore,
      "the owner guard must win even if an untyped caller supplies before",
    );
  });

  test("the Better Auth instance takes the complete session policy", () => {
    const options = auth().options;
    const policy = authSessionPolicy();

    assert.ok(options.session, "auth configures no session block");
    assert.equal(options.session.expiresIn, policy.session.expiresIn, "auth idle window");
    assert.equal(options.session.updateAge, policy.session.updateAge, "auth slide step");
    assert.equal(options.session.freshAge, policy.session.freshAge, "auth freshness window");
    assert.ok(
      options.databaseHooks?.session?.update?.before,
      "auth configures no absolute-cap update hook",
    );
    assert.ok(options.hooks?.before, "auth configures no absolute-cap read guard");
  });
});
