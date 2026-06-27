import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { parseEmailAddress } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { documents, driftMetrics, emailTriage, todos, user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { serverEnv } from "@alfred/env/server";
import { eq, inArray } from "drizzle-orm";

import {
  attentionShare7d,
  type RunDriftHealthCheckOptions,
  runDriftHealthCheck,
  selfIngestionCount,
  todoDismissDoneRatio,
} from "../../src/modules/drift-audit/metrics";

function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}

const SKIP = hasDatabaseUrl() ? false : "DATABASE_URL not set — skipping DB-backed test";
const ID_PREFIX = "test-drift-audit-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Drift Test User", email: `${userId}@example.test` });
  return userId;
}

async function seedGmailDoc(userId: string, from: string | null): Promise<void> {
  await db()
    .insert(documents)
    .values({
      id: `doc_${randomUUID().slice(0, 12)}`,
      userId,
      source: "gmail",
      sourceId: `msg_${randomUUID()}`,
      sourceThreadId: `thr_${randomUUID().slice(0, 8)}`,
      title: "drift fixture",
      content: "fixture",
      contentHash: `hash_${randomUUID()}`,
      authoredAt: new Date(),
      metadata: from ? { from } : {},
    });
}

async function seedTriage(userId: string, category: string): Promise<void> {
  await db()
    .insert(emailTriage)
    .values({
      userId,
      sourceThreadId: `thr_${randomUUID()}`,
      category,
      confidence: 0.9,
      model: "test-model",
    });
}

async function seedTodo(
  userId: string,
  status: "done" | "dismissed",
  createdBy: "agent" | "user" = "agent",
): Promise<void> {
  await db()
    .insert(todos)
    .values({
      userId,
      name: "drift fixture todo",
      status,
      createdBy,
      completedAt: status === "done" ? new Date() : null,
    });
}

async function seedBreachingAttentionShare(userId: string): Promise<void> {
  // 3 attention of 12 = 25% > 20%, with enough denominator to alert.
  await Promise.all([
    seedTriage(userId, "urgent"),
    seedTriage(userId, "action_needed"),
    seedTriage(userId, "urgent"),
    ...Array.from({ length: 9 }, () => seedTriage(userId, "fyi")),
  ]);
}

describe("drift-audit metrics (DB-backed)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length > 0) {
      // drift_metrics + documents/email_triage/todos all CASCADE on user delete.
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("selfIngestionCount counts only exact self-address matches", async () => {
    const self = parseEmailAddress(serverEnv().RESEND_FROM_EMAIL);
    assert.ok(self, "RESEND_FROM_EMAIL must parse for this test");
    const userId = await seedUser();

    await seedGmailDoc(userId, serverEnv().RESEND_FROM_EMAIL); // exact self → counts
    await seedGmailDoc(userId, `Someone <not-${self}>`); // mentions but ≠ self → excluded
    await seedGmailDoc(userId, "stranger@example.com"); // unrelated → excluded

    const result = await selfIngestionCount(userId);
    assert.ok(result);
    assert.equal(result.value, 1);
    assert.equal(result.breached, true, "any self-doc breaches the >0 floor");
    assert.equal((result.detail.sampleDocIds as string[]).length, 1);
  });

  test("attentionShare7d is the demanding-lane fraction and respects the threshold", async () => {
    const userId = await seedUser();
    await seedBreachingAttentionShare(userId);

    const result = await attentionShare7d(userId);
    assert.equal(result.detail.total, 12);
    assert.equal(result.detail.attention, 3);
    assert.equal(result.value, 0.25);
    assert.equal(result.breached, true);
  });

  test("attentionShare7d does not breach on tiny denominators", async () => {
    const userId = await seedUser();
    await seedTriage(userId, "urgent");

    const result = await attentionShare7d(userId);
    assert.equal(result.detail.total, 1);
    assert.equal(result.detail.attention, 1);
    assert.equal(result.value, 1);
    assert.equal(result.breached, false, "1/1 is too sparse to page the health monitor");
  });

  test("attentionShare7d with no classified threads is 0, not a divide-by-zero breach", async () => {
    const userId = await seedUser();
    const result = await attentionShare7d(userId);
    assert.equal(result.value, 0);
    assert.equal(result.breached, false);
  });

  test("todoDismissDoneRatio measures Alfred-authored suggestions only", async () => {
    const userId = await seedUser();
    await seedTodo(userId, "dismissed");
    await seedTodo(userId, "dismissed");
    await seedTodo(userId, "done");
    await seedTodo(userId, "dismissed", "user");
    await seedTodo(userId, "done", "user");

    const result = await todoDismissDoneRatio(userId);
    assert.equal(result.detail.dismissed, 2);
    assert.equal(result.detail.done, 1);
    assert.equal(result.value, 2);
    assert.equal(result.breached, false, "2:1 is far under the informational bar");
  });

  test("runDriftHealthCheck writes one snapshot row per metric and sends no alert on a clean user", async () => {
    const userId = await seedUser();
    // No data → self_ingestion 0, attention 0, ratio 0: nothing breaches.
    const result = await runDriftHealthCheck(userId);
    assert.equal(result.breached.length, 0);
    assert.equal(result.alertsSent, 0);

    const rows = await db().select().from(driftMetrics).where(eq(driftMetrics.userId, userId));
    assert.equal(rows.length, result.metrics.length);
    const metricNames = new Set(rows.map((r) => r.metric));
    assert.ok(metricNames.has("attention_share_7d"));
    assert.ok(metricNames.has("todo_dismiss_done_ratio"));
    // self_ingestion_count is present whenever Alfred has a parseable identity.
    for (const row of rows) {
      assert.equal((row.detail as { breached: boolean }).breached, false);
      assert.ok("threshold" in (row.detail as object));
    }
  });

  test("runDriftHealthCheck uses the user's local date in health alert idempotency keys", async () => {
    const userId = await seedUser();
    await seedBreachingAttentionShare(userId);
    const keys: string[] = [];
    const notifyFn: RunDriftHealthCheckOptions["notifyFn"] = async (args) => {
      keys.push(args.idempotencyKey);
      return { status: "sent", emailSendId: "ems_test", providerMessageId: "resend_test" };
    };

    const result = await runDriftHealthCheck(userId, {
      notifyFn,
      timezone: "Asia/Kolkata",
      now: new Date("2026-06-27T20:00:00.000Z"),
    });

    assert.equal(result.alertsSent, 1);
    assert.deepEqual(keys, [`health_alert:${userId}:attention_share_7d:2026-06-28`]);
  });

  test("runDriftHealthCheck treats failed health alert sends as retryable", async () => {
    const userId = await seedUser();
    await seedBreachingAttentionShare(userId);
    const notifyFn: RunDriftHealthCheckOptions["notifyFn"] = async () => ({
      status: "failed",
      emailSendId: "ems_test",
      error: "resend unavailable",
    });

    await assert.rejects(
      runDriftHealthCheck(userId, { notifyFn, timezone: "UTC" }),
      /health_alert send failed.*resend unavailable/,
    );
    await assert.rejects(
      runDriftHealthCheck(userId, { notifyFn, timezone: "UTC" }),
      /health_alert send failed.*resend unavailable/,
    );

    const rows = await db().select().from(driftMetrics).where(eq(driftMetrics.userId, userId));
    assert.equal(rows.length, 3, "retryable alert failures must not duplicate daily snapshots");
    assert.equal(new Set(rows.map((r) => `${r.metric}:${r.captureKey}`)).size, 3);
  });

  test("runDriftHealthCheck fails loudly when every metric evaluator fails", async () => {
    const userId = await seedUser();
    const failing = async () => {
      throw new Error("database unavailable");
    };

    await assert.rejects(
      runDriftHealthCheck(userId, {
        metricEvaluators: [failing, failing, failing],
      }),
      /all metrics failed.*database unavailable/,
    );

    const rows = await db().select().from(driftMetrics).where(eq(driftMetrics.userId, userId));
    assert.equal(rows.length, 0);
  });
});
