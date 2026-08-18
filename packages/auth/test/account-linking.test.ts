import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ensureAuthTestEnv } from "./support/env";

/**
 * Coverage for CVE-2026-53516 (#455).
 *
 * The bug was in Better Auth's OAuth callback, so no Alfred code path can
 * reproduce it. The fix is the version floor, and the floor is what a later
 * relock or a careless catalog edit can silently undo, so it is asserted in two
 * independent places:
 *
 *   1. every `better-auth` the lockfile resolves is at or above the fix, and
 *   2. the catalog range cannot admit a version below it.
 *
 * The lockfile case alone would pass the moment someone relocks against a
 * loosened range; the catalog case alone would pass a lockfile that still holds
 * a stale vulnerable copy.
 *
 * There is also one configuration case, and it is a *negative* one: the fix
 * defaults `requireLocalEmailVerified` to true, so Alfred asserts it is never
 * set to `false` rather than asserting some flag is set to `true`. Alfred
 * deliberately configures no `accountLinking` block at all — see
 * `packages/auth/src/index.ts` for why `disableImplicitLinking` was dropped.
 */

/** The first release that checks the *local* account's `emailVerified`. */
const FIXED_VERSION = [1, 6, 11] as const;

/** `packages/auth/test` -> repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function parseVersion(raw: string): [number, number, number] {
  const parts = raw.split("-")[0]?.split(".") ?? [];
  const [major, minor, patch] = parts.map((p) => Number.parseInt(p, 10));
  assert.ok(
    Number.isInteger(major) && Number.isInteger(minor) && Number.isInteger(patch),
    `unparseable better-auth version: ${raw}`,
  );
  return [major as number, minor as number, patch as number];
}

function isAtLeast(actual: readonly number[], floor: readonly number[]): boolean {
  for (let i = 0; i < floor.length; i += 1) {
    const a = actual[i] ?? 0;
    const f = floor[i] ?? 0;
    if (a !== f) return a > f;
  }
  return true;
}

describe("account linking (CVE-2026-53516)", () => {
  test("every better-auth the lockfile resolves is at or above the fix", () => {
    // The lockfile, not `node_modules`, is what CI installs, and `better-auth`
    // is not a dependency of this package so it cannot be imported here. Read
    // every resolution rather than one: a second, older copy reachable through
    // some other dependency is the failure this case exists to catch.
    const lock = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
    const found = [...lock.matchAll(/^ {2}better-auth@(\d+\.\d+\.\d+[^(:\s]*)/gm)].map(
      (m) => m[1] as string,
    );
    assert.ok(found.length > 0, "no better-auth resolution found in pnpm-lock.yaml");
    for (const version of new Set(found)) {
      assert.ok(
        isAtLeast(parseVersion(version), FIXED_VERSION),
        `pnpm-lock.yaml resolves better-auth ${version}, below ${FIXED_VERSION.join(".")} — CVE-2026-53516`,
      );
    }
  });

  test("the catalog floor cannot admit a vulnerable release", () => {
    // The lockfile case above passes the moment someone relocks; this one is
    // what stops the relock from choosing a vulnerable version in the first
    // place. Only a caret range is accepted, because `~1.6.11` or `>=1.3.28`
    // would satisfy a naive floor check while still resolving below the fix.
    const workspace = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    const declared = /^ {2}better-auth: \^(\d+\.\d+\.\d+)$/m.exec(workspace)?.[1];
    assert.ok(declared, "pnpm-workspace.yaml must declare better-auth as a caret range");
    assert.ok(
      isAtLeast(parseVersion(declared), FIXED_VERSION),
      `the catalog floor ^${declared} admits releases below ${FIXED_VERSION.join(".")} — CVE-2026-53516`,
    );
  });

  test("auth() does not weaken the local-email-verified check", async () => {
    ensureAuthTestEnv();
    const { auth } = await import("../src/index");
    // The fix defaults this to `true`. Setting it to `false` would restore the
    // vulnerable comparison even on a patched release, so the only acceptable
    // states are "absent" and "true".
    const linking = auth().options.account?.accountLinking;
    assert.notEqual(linking?.requireLocalEmailVerified, false);
  });
});
