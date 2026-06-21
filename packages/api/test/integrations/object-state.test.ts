import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { getObjectDef, isLoopClosingCategory, isTerminalCategory } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";

import {
  extractGithubKeys,
  isGithubNotificationSender,
  objectStateStore,
  reduceGithubEvent,
} from "../../src/modules/integrations/object-state";

/**
 * Contract tests for integration object-state memory (ADR-0062, #212).
 *
 * The pure suite (reducer + registry + key extraction) always runs. The store
 * suite is DB-backed and opt-in — it runs only when `DATABASE_URL` points at a
 * reachable migrated Postgres, mirroring the other DB-backed tests; it asserts
 * the load-bearing ADR-0048-D contract: a terminal state closes a loop, an
 * unknown one never does, and replay/redelivery can't regress a merged PR.
 */

const SHA_A = "a1b2c3d4".repeat(5); // 40 hex
const SHA_B = "f0e1d2c3".repeat(5);

function prPayload(
  number: number,
  sha: string,
  opts: { id?: number; merged?: boolean; repo?: string } = {},
) {
  return {
    pull_request: {
      id: opts.id ?? number,
      number,
      title: `PR ${number}`,
      html_url: `https://github.com/${opts.repo ?? "o/r"}/pull/${number}`,
      merged: opts.merged ?? false,
      head: { sha, ref: "feature" },
    },
    repository: {
      full_name: opts.repo ?? "o/r",
      html_url: `https://github.com/${opts.repo ?? "o/r"}`,
    },
  };
}

describe("github reducer (pure)", () => {
  test("opened / synchronize / reopened map to the open native state + head_sha key", () => {
    for (const action of ["opened", "synchronize", "reopened"]) {
      const delta = reduceGithubEvent("pull_request", action, prPayload(7, SHA_A));
      assert.ok(delta, `${action} should produce a delta`);
      assert.equal(delta?.kind, "pull_request");
      assert.equal(delta?.externalId, "7");
      assert.equal(delta?.nativeState, "open");
      assert.deepEqual(
        delta?.keys.find((k) => k.keyKind === "head_sha"),
        { keyKind: "head_sha", keyValue: SHA_A },
      );
    }
  });

  test("closed collapses the merged boolean into merged vs closed", () => {
    assert.equal(
      reduceGithubEvent("pull_request", "closed", prPayload(7, SHA_A, { merged: true }))
        ?.nativeState,
      "merged",
    );
    assert.equal(
      reduceGithubEvent("pull_request", "closed", prPayload(7, SHA_A, { merged: false }))
        ?.nativeState,
      "closed",
    );
  });

  test("externalId uses GitHub's global PR id, not the repo-scoped PR number", () => {
    const first = reduceGithubEvent(
      "pull_request",
      "opened",
      prPayload(1, SHA_A, { id: 111, repo: "o/one" }),
    );
    const second = reduceGithubEvent(
      "pull_request",
      "opened",
      prPayload(1, SHA_B, { id: 222, repo: "o/two" }),
    );

    assert.equal(first?.externalId, "111");
    assert.equal(second?.externalId, "222");
    assert.notEqual(first?.externalId, second?.externalId);
  });

  test("non-lifecycle actions and non-PR events are no-ops", () => {
    assert.equal(reduceGithubEvent("pull_request", "labeled", prPayload(7, SHA_A)), null);
    assert.equal(reduceGithubEvent("push", "created", prPayload(7, SHA_A)), null);
    assert.equal(reduceGithubEvent("pull_request", "opened", {}), null);
  });
});

describe("github registry normalize", () => {
  test("merged → resolved, closed → abandoned, open → active", () => {
    const def = getObjectDef("github");
    assert.equal(def.normalize("pull_request", "merged"), "resolved");
    assert.equal(def.normalize("pull_request", "closed"), "abandoned");
    assert.equal(def.normalize("pull_request", "open"), "active");
    assert.equal(def.normalize("pull_request", "garbage"), null);
  });

  test("only the closing buckets are terminal", () => {
    assert.equal(isTerminalCategory("resolved"), true);
    assert.equal(isTerminalCategory("abandoned"), true);
    assert.equal(isTerminalCategory("failed"), true);
    assert.equal(isTerminalCategory("active"), false);
  });

  test("briefing loop closure excludes failed because failed is usually the opener", () => {
    assert.equal(isLoopClosingCategory("resolved"), true);
    assert.equal(isLoopClosingCategory("abandoned"), true);
    assert.equal(isLoopClosingCategory("failed"), false);
    assert.equal(isLoopClosingCategory("active"), false);
  });
});

describe("extractGithubKeys", () => {
  test("pulls and dedupes 40-hex head shas from subject + body", () => {
    const keys = extractGithubKeys({
      subject: `Run failed for ${SHA_A}`,
      content: `commit ${SHA_A} on branch; see ${SHA_B}`,
    });
    assert.deepEqual(
      keys.map((k) => k.keyValue),
      [SHA_A, SHA_B],
    );
  });

  test("ignores short / non-hex tokens", () => {
    assert.deepEqual(extractGithubKeys({ subject: "deadbeef", content: "no sha here" }), []);
  });
});

describe("isGithubNotificationSender", () => {
  test("requires an exact github.com sender domain", () => {
    assert.equal(isGithubNotificationSender("GitHub <notifications@github.com>"), true);
    assert.equal(isGithubNotificationSender("spoof@notgithub.com"), false);
    assert.equal(isGithubNotificationSender("GitHub <notifications@github.com.evil.test>"), false);
  });
});

const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

describe("objectStateStore contract (DB-backed)", { skip: SKIP }, () => {
  const userId = `test-objstate-${randomUUID()}`;
  const T1 = new Date("2026-06-01T00:00:00Z");
  const T2 = new Date("2026-06-02T00:00:00Z");
  const T3 = new Date("2026-06-03T00:00:00Z");

  before(async () => {
    await db()
      .insert(user)
      .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  });

  after(async () => {
    // integration_objects / _keys cascade on the user FK.
    await db().delete(user).where(eq(user.id, userId));
    await closeConnections();
  });

  async function apply(action: string, payload: unknown, deliveredAt: Date) {
    await objectStateStore.applyEvent({
      userId,
      provider: "github",
      eventType: "pull_request",
      action,
      payload,
      deliveredAt,
    });
  }

  test("a merged PR resolves by head_sha → terminal state (loop closeable)", async () => {
    await apply("opened", prPayload(101, SHA_A), T1);
    await apply("synchronize", prPayload(101, SHA_A), T2);
    await apply("closed", prPayload(101, SHA_A, { merged: true }), T3);

    const ref = await objectStateStore.resolveByKey(userId, "github", "head_sha", SHA_A);
    assert.ok(ref, "head_sha should resolve to the PR");
    assert.equal(ref?.externalId, "101");

    const state = await objectStateStore.getState(userId, ref!);
    assert.equal(state?.stateCategory, "resolved");
    assert.equal(state?.nativeState, "merged");
    assert.equal(isTerminalCategory(state!.stateCategory), true);
  });

  test("absence never closes: an unseen head_sha resolves to nothing", async () => {
    const ref = await objectStateStore.resolveByKey(userId, "github", "head_sha", SHA_B);
    assert.equal(ref, null);
  });

  test("monotonic: replaying a stale opened delivery cannot regress a merged PR", async () => {
    // A delayed duplicate can have a later receipt time than the merge; resolved
    // PRs are absorbing so stale open/synchronize deliveries cannot reopen them.
    await apply("opened", prPayload(101, SHA_A), new Date("2026-06-04T00:00:00Z"));

    const ref = await objectStateStore.resolveByKey(userId, "github", "head_sha", SHA_A);
    const state = await objectStateStore.getState(userId, ref!);
    assert.equal(state?.stateCategory, "resolved", "out-of-order replay must not reopen");

    // Idempotent: still exactly one object for the user.
    const objects = await objectStateStore.list(userId, "github", { kind: "pull_request" });
    assert.equal(objects.length, 1);
  });
});
