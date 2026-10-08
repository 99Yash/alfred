import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ensureAuthTestEnv } from "./support/env";

/**
 * CVE-2026-53516 lives in Better Auth, so the fix is a version floor. Pin it twice:
 * every lockfile resolution, and the catalog range. Either alone misses a case.
 * Also assert `requireLocalEmailVerified` is never `false`.
 */

/** The first release that checks the *local* account's `emailVerified`. */
const FIXED_VERSION = [1, 6, 11] as const;

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
    // Check every resolution: an older copy through another dependency is the failure.
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
    // Caret only: `~1.6.11` or `>=1.3.28` pass a naive floor check yet can resolve below the fix.
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
    // `false` restores the bug even on a patched release.
    const linking = auth().options.account?.accountLinking;
    assert.notEqual(linking?.requireLocalEmailVerified, false);
  });
});
