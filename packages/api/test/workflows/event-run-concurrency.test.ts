import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { EVENT_ACTIVE_RUN_INDEX, agentRuns, user, workflows } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  _resetRegistryForTests,
  getWorkflow,
  registerWorkflow,
} from "../../src/modules/agent/registry";
import type { StepResult, Workflow } from "../../src/modules/agent/types";
import { emitEvent } from "../../src/modules/workflows/events";
import { uniqueViolationConstraint } from "../../src/lib/pg-errors";
import { closeRedis } from "../../src/queue/connection";

/**
 * DB-backed guard for the event-dispatch duplicate-run invariant (#531).
 *
 * `emitEvent` gated duplicates with a soft `hasNonTerminalEventRun` read
 * immediately followed by `createRun` — a check-then-create TOCTOU with nothing
 * at the DB level behind it. The general dedup index only fires on a non-null
 * `dedup_key`, which event-triggered runs don't have, so two concurrent
 * dispatches of one event (a webhook and its retry, or a webhook and a poll)
 * both read zero matches and both spawn a run: duplicate triage/brief,
 * duplicate model spend, duplicate side effects.
 *
 * The fix is a partial unique index over the event identity on non-terminal
 * rows — {@link EVENT_ACTIVE_RUN_INDEX} — mirroring the chat path's
 * per-thread active-run index. These lock the identity the index keys on
 * (including `reason`, which deliberately keeps an outbound-reply re-eval a
 * distinct event) and that the losing dispatch is dropped, not failed.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated Postgres.
 */
const SKIP = (() => {
  try {
    databaseEnv();
    return false;
  } catch {
    return "DATABASE_URL not set — skipping DB-backed test";
  }
})();

const ID_PREFIX = "test-event-dedup-";
const EVENT_WORKFLOW_SLUG = "__test-event-dedup";
const SOURCE = "gmail";
const TYPE = "message_received";
const createdUserIds: string[] = [];

const eventWorkflow: Workflow<Record<string, never>> = {
  slug: EVENT_WORKFLOW_SLUG,
  name: "event dedup test",
  trigger: { kind: "event", source: SOURCE, type: TYPE },
  initialState: () => ({}),
  initialStep: "finish",
  steps: {
    finish: {
      id: "finish",
      run: async (): Promise<StepResult<Record<string, never>>> => ({ kind: "done", state: {} }),
    },
  },
};

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

/** A user with the event-triggered workflow active, so `emitEvent` matches it. */
async function seedUserWithEventWorkflow(): Promise<string> {
  const userId = await seedUser();
  await db()
    .insert(workflows)
    .values({
      userId,
      slug: EVENT_WORKFLOW_SLUG,
      name: "event dedup test",
      trigger: { kind: "event", source: SOURCE, type: TYPE },
      status: "active",
    });
  return userId;
}

/** Insert an event-triggered run row shaped exactly as `createRun` writes it. */
async function insertEventRun(args: {
  userId: string;
  eventId: string;
  reason?: string | undefined;
  status?: string;
}): Promise<string> {
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db()
    .insert(agentRuns)
    .values({
      id: runId,
      userId: args.userId,
      workflowSlug: EVENT_WORKFLOW_SLUG,
      currentStep: "finish",
      status: args.status ?? "pending",
      trigger: {
        kind: "event",
        source: SOURCE,
        type: TYPE,
        eventId: args.eventId,
        payload: { reason: args.reason },
      },
    });
  return runId;
}

async function expectUniqueViolation(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
  } catch (err) {
    return uniqueViolationConstraint(err);
  }
  throw new Error("expected a unique violation, but the insert succeeded");
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Count of NON-terminal runs the user holds for one event id — the guarded quantity. */
async function countActiveEventRuns(userId: string, eventId: string): Promise<number> {
  const rows = await db()
    .select({ status: agentRuns.status, trigger: agentRuns.trigger })
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, EVENT_WORKFLOW_SLUG)));
  return rows.filter((r) => {
    const trigger = r.trigger as { eventId?: unknown } | null;
    return trigger?.eventId === eventId && !TERMINAL.has(r.status);
  }).length;
}

describe("event-dispatch duplicate-run guard (#531)", { skip: SKIP }, () => {
  before(() => {
    if (!getWorkflow(EVENT_WORKFLOW_SLUG)) registerWorkflow(eventWorkflow);
  });
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    _resetRegistryForTests();
    await closeConnections();
    await closeRedis();
  });

  test("local schema has the event active-run unique index", async () => {
    const result = await db().execute(sql`
      select count(*)::int as count
      from pg_indexes
      where tablename = 'agent_runs'
        and indexname = ${EVENT_ACTIVE_RUN_INDEX}
    `);
    const row = Array.isArray(result) ? result[0] : result.rows[0];
    assert.equal(Number((row as { count: number }).count), 1);
  });

  test("a second run for the same in-flight event is rejected → exactly one run", async () => {
    const userId = await seedUser();
    const eventId = `evt-${randomUUID()}`;
    await insertEventRun({ userId, eventId });

    const constraint = await expectUniqueViolation(() => insertEventRun({ userId, eventId }));
    assert.equal(constraint, EVENT_ACTIVE_RUN_INDEX);
    assert.equal(await countActiveEventRuns(userId, eventId), 1);
  });

  test("a different event id is unaffected", async () => {
    const userId = await seedUser();
    await insertEventRun({ userId, eventId: `evt-${randomUUID()}` });
    await insertEventRun({ userId, eventId: `evt-${randomUUID()}` });
  });

  test("a re-key with a different reason is a distinct event (#282 reply re-eval)", async () => {
    const userId = await seedUser();
    const eventId = `evt-${randomUUID()}`;
    await insertEventRun({ userId, eventId });
    await insertEventRun({ userId, eventId, reason: "reply" });
    assert.equal(await countActiveEventRuns(userId, eventId), 2);
  });

  test("once the first run is terminal the same event can be dispatched again", async () => {
    const userId = await seedUser();
    const eventId = `evt-${randomUUID()}`;
    const first = await insertEventRun({ userId, eventId });
    await db().update(agentRuns).set({ status: "completed" }).where(eq(agentRuns.id, first));

    await insertEventRun({ userId, eventId });
    assert.equal(await countActiveEventRuns(userId, eventId), 1);
  });

  test("concurrent emitEvent dispatches of one event create exactly one run", async () => {
    const userId = await seedUserWithEventWorkflow();
    const eventId = `evt-${randomUUID()}`;
    const dispatch = () => emitEvent({ userId, source: SOURCE, type: TYPE, eventId });

    const [a, b] = await Promise.all([dispatch(), dispatch()]);

    assert.equal(a.matched + b.matched, 2, "both dispatches matched the workflow");
    assert.equal(a.created + b.created, 1, "only one of them created a run");
    assert.equal(
      a.skippedDuplicate + b.skippedDuplicate,
      1,
      "the loser is reported as a dropped duplicate",
    );
    assert.equal(a.failed + b.failed, 0, "and not as a failure");
    assert.equal(await countActiveEventRuns(userId, eventId), 1);
  });
});
