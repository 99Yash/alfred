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

// Set before the imports below, not with a static import: both auth modules
// reach `serverEnv()` and `@alfred/db`, and a static import is hoisted above
// this line. See `.lessons/import-environment-sensitive-modules-after-test-fixtures.md`.
ensureAuthTestEnv();

const [
  { SESSION_LIFETIME_SECONDS, authSecureCookies, authSession, isPastAbsoluteLifetime },
  { auth },
  { sessionAuth },
] = await Promise.all([
  import("../src/session-policy"),
  import("../src/index"),
  import("../src/session"),
]);

const DAY_SECONDS = 60 * 60 * 24;

describe("session lifetime (#454)", () => {
  test("the block states an idle window, a slide step and a freshness window", () => {
    const session = authSession();
    assert.equal(session.expiresIn, DAY_SECONDS * 7, "idle window moved");
    assert.equal(session.updateAge, DAY_SECONDS, "slide step moved");
    assert.equal(session.freshAge, DAY_SECONDS, "freshness window moved");
  });

  test("freshness stays on", () => {
    // Better Auth reads `freshAge: 0` as "always fresh" and skips the check in
    // `/update-user` and `/list-sessions` entirely. That is a different posture,
    // not a shorter window, so it must never arrive by accident.
    assert.notEqual(authSession().freshAge, 0);
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

  test("the absolute cap is measured from sign-in and bites exactly once", () => {
    const cap = SESSION_LIFETIME_SECONDS.absoluteMax * 1000;
    const now = Date.UTC(2026, 7, 18, 12, 0, 0);

    assert.equal(isPastAbsoluteLifetime(new Date(now - cap + 1000), now), false, "a second short");
    assert.equal(isPastAbsoluteLifetime(new Date(now - cap), now), true, "exactly at the cap");
    assert.equal(isPastAbsoluteLifetime(new Date(now - cap - 1000), now), true, "past the cap");
    assert.equal(isPastAbsoluteLifetime(new Date(now), now), false, "just signed in");
  });

  test("a created_at that does not parse is treated as past the cap", () => {
    // Fail closed. `session.created_at` is a NOT NULL timestamp, so an
    // unreadable value means a corrupt row, and the cost of being wrong is one
    // sign-in rather than an unbounded session.
    assert.equal(isPastAbsoluteLifetime("not a date"), true);
    assert.equal(isPastAbsoluteLifetime(Number.NaN), true);
  });

  test("secure cookies, and so the __Secure- name prefix, are on in production only", () => {
    // This decides the cookie NAME, not just the attribute. A browser refuses a
    // `__Secure-` cookie over plain HTTP, so turning it on for a local dev run
    // would break sign-in on localhost.
    assert.equal(authSecureCookies("production"), true);
    assert.equal(authSecureCookies("development"), false);
    assert.equal(authSecureCookies("test"), false);
  });

  test("both Better Auth instances take the same session block", () => {
    // The two read the same `session` rows and answer on the same paths, so a
    // longer window on either one is the window that actually holds.
    const instances = [
      ["auth", auth().options],
      ["sessionAuth", sessionAuth().options],
    ] as const;

    for (const [name, options] of instances) {
      assert.ok(options.session, `${name} configures no session block`);
      assert.equal(options.session.expiresIn, authSession().expiresIn, `${name} idle window`);
      assert.equal(options.session.updateAge, authSession().updateAge, `${name} slide step`);
      assert.equal(options.session.freshAge, authSession().freshAge, `${name} freshness window`);
      assert.notEqual(
        options.advanced?.useSecureCookies,
        undefined,
        `${name} leaves the __Secure- prefix implicit`,
      );
    }

    // Equal to each other, not to a constant: `auth()` passes no `baseURL` and
    // `sessionAuth()` passes one, so leaving this implicit lets the two derive
    // the `__Secure-` cookie NAME from different inputs — and then one instance
    // cannot find the cookie the other wrote.
    assert.equal(
      instances[0][1].advanced?.useSecureCookies,
      instances[1][1].advanced?.useSecureCookies,
      "the two instances disagree about the __Secure- cookie name prefix",
    );
  });
});
