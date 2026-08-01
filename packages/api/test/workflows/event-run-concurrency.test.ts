import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import type { AgentRunTrigger } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import {
  EVENT_ACTIVE_RUN_INDEX,
  RUN_DEDUP_KEY_INDEX,
  agentRuns,
  user,
  workflows,
} from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  _resetRegistryForTests,
  getWorkflow,
  registerWorkflow,
} from "../../src/modules/agent/registry";
import { createRun } from "../../src/modules/agent/service";
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
 * per-thread active-run index. These tests lock the identity the index keys on
 * (including `reason`, which deliberately keeps an outbound-reply re-eval a
 * distinct event; and excluding nothing when a trigger omits `source`/`type`,
 * which NULLs would otherwise exempt from enforcement entirely) and that the
 * losing dispatch is dropped as a duplicate rather than counted as a failure —
 * whichever of the two duplicate-run indexes it collided on.
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
const SINGLETON_WORKFLOW_SLUG = "__test-event-dedup-singleton";
const SOURCE = "gmail";
const TYPE = "message_received";
const createdUserIds: string[] = [];

const finishStep: StepResult<Record<string, never>> = { kind: "done", state: {} };

const eventWorkflow: Workflow<Record<string, never>> = {
  slug: EVENT_WORKFLOW_SLUG,
  name: "event dedup test",
  trigger: { kind: "event", source: SOURCE, type: TYPE },
  initialState: () => ({}),
  initialStep: "finish",
  closure: { kind: "none" },
  steps: {
    finish: {
      id: "finish",
      run: async (): Promise<StepResult<Record<string, never>>> => finishStep,
    },
  },
};

/**
 * An event-triggered workflow that ALSO declares a `dedupKey` — a lifetime-once
 * singleton like cold-start-research. Two dispatches of *different* events land
 * on the same dedup key, so the losing insert collides on
 * {@link RUN_DEDUP_KEY_INDEX} rather than the event identity index. Both mean
 * "a run for this already exists"; a catch that only names the event index
 * counted this one as a failure (#530/#531 review, D7).
 */
const singletonEventWorkflow: Workflow<Record<string, never>> = {
  slug: SINGLETON_WORKFLOW_SLUG,
  name: "event dedup singleton test",
  trigger: { kind: "event", source: SOURCE, type: TYPE },
  initialState: () => ({}),
  initialStep: "finish",
  closure: { kind: "none" },
  dedupKey: () => "singleton",
  steps: {
    finish: {
      id: "finish",
      run: async (): Promise<StepResult<Record<string, never>>> => finishStep,
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

/**
 * A user with one event-triggered workflow active, so `emitEvent` matches it.
 * Only the requested slug is seeded — a user holding both test workflows would
 * make every dispatch match twice and blur which index fired.
 */
async function seedUserWithEventWorkflow(
  slug = EVENT_WORKFLOW_SLUG,
  accountRef?: string,
): Promise<string> {
  const userId = await seedUser();
  await db()
    .insert(workflows)
    .values({
      userId,
      slug,
      name: "event dedup test",
      trigger: {
        kind: "event",
        source: SOURCE,
        type: TYPE,
        ...(accountRef ? { accountRef } : {}),
      },
      allowedIntegrations: ["gmail"],
      status: "active",
      // The runtime body is registered above, so this is a built-in fixture.
      // Built-ins do not pin database revisions; user-authored rows must.
      isBuiltin: true,
    });
  return userId;
}

/** Insert an event-triggered run row shaped exactly as `createRun` writes it. */
async function insertEventRun(args: {
  userId: string;
  eventId: string;
  reason?: string | undefined;
  status?: string;
  /**
   * Write the trigger without `source`/`type` — the pre-ADR-0047 shape the
   * contract still accepts (both fields are optional). The index has to keep
   * enforcing on it, which is why its key coalesces the two (D6).
   */
  omitSourceAndType?: boolean;
}): Promise<string> {
  const runId = `run_${randomUUID().slice(0, 12)}`;
  const trigger: AgentRunTrigger = args.omitSourceAndType
    ? { kind: "event", eventId: args.eventId, payload: { reason: args.reason } }
    : {
        kind: "event",
        source: SOURCE,
        type: TYPE,
        eventId: args.eventId,
        payload: { reason: args.reason },
      };
  await db()
    .insert(agentRuns)
    .values({
      id: runId,
      userId: args.userId,
      workflowSlug: EVENT_WORKFLOW_SLUG,
      currentStep: "finish",
      status: args.status ?? "pending",
      trigger,
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
async function countActiveEventRuns(
  userId: string,
  eventId: string,
  workflowSlug = EVENT_WORKFLOW_SLUG,
): Promise<number> {
  const rows = await db()
    .select({ status: agentRuns.status, trigger: agentRuns.trigger })
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, workflowSlug)));
  return rows.filter((r) => {
    const trigger = r.trigger as { eventId?: unknown } | null;
    return trigger?.eventId === eventId && !TERMINAL.has(r.status);
  }).length;
}

/** Every non-terminal run the user holds for one workflow, regardless of event. */
async function countActiveRuns(userId: string, workflowSlug: string): Promise<number> {
  const rows = await db()
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, workflowSlug)));
  return rows.filter((r) => !TERMINAL.has(r.status)).length;
}

describe("event-dispatch duplicate-run guard (#531)", { skip: SKIP }, () => {
  before(() => {
    if (!getWorkflow(EVENT_WORKFLOW_SLUG)) registerWorkflow(eventWorkflow);
    if (!getWorkflow(SINGLETON_WORKFLOW_SLUG)) registerWorkflow(singletonEventWorkflow);
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

  test("an account-bound workflow ignores another account's event", async () => {
    const userId = await seedUserWithEventWorkflow(EVENT_WORKFLOW_SLUG, "gmail-account-a");

    const wrongAccount = await emitEvent({
      userId,
      source: SOURCE,
      type: TYPE,
      eventId: `evt-${randomUUID()}`,
      accountRef: "gmail-account-b",
    });
    assert.equal(wrongAccount.matched, 0);
    assert.equal(wrongAccount.created, 0);

    const selectedAccount = await emitEvent({
      userId,
      source: SOURCE,
      type: TYPE,
      eventId: `evt-${randomUUID()}`,
      accountRef: "gmail-account-a",
    });
    assert.equal(selectedAccount.matched, 1);
    assert.equal(selectedAccount.created, 1);
  });

  test("a dedup-key collision on a singleton workflow is a duplicate, not a failure", async () => {
    const userId = await seedUserWithEventWorkflow(SINGLETON_WORKFLOW_SLUG);
    // Two DIFFERENT events. Neither the fast-path read nor the event identity
    // index sees a duplicate — the workflow's `dedupKey` does, so the losing
    // insert raises 23505 on RUN_DEDUP_KEY_INDEX instead.
    const first = await emitEvent({
      userId,
      source: SOURCE,
      type: TYPE,
      eventId: `evt-${randomUUID()}`,
    });
    const second = await emitEvent({
      userId,
      source: SOURCE,
      type: TYPE,
      eventId: `evt-${randomUUID()}`,
    });

    assert.equal(first.created, 1, "the first dispatch creates the singleton run");
    assert.equal(second.created, 0, "the second creates nothing");
    assert.equal(second.skippedDuplicate, 1, "and is reported as a dropped duplicate");
    assert.equal(second.failed, 0, "not as a failure (#530/#531 review, D7)");
    assert.equal(await countActiveRuns(userId, SINGLETON_WORKFLOW_SLUG), 1);

    // Pin WHICH index the drop above came from: bypassing `emitEvent`'s catch
    // shows the raw collision is the dedup-key index, not the event identity
    // one — the case a catch matching only EVENT_ACTIVE_RUN_INDEX rethrew.
    const constraint = await expectUniqueViolation(() =>
      createRun({
        userId,
        workflowSlug: SINGLETON_WORKFLOW_SLUG,
        trigger: { kind: "event", source: SOURCE, type: TYPE, eventId: `evt-${randomUUID()}` },
      }),
    );
    assert.equal(constraint, RUN_DEDUP_KEY_INDEX);
  });

  test("the index still enforces when the trigger omits source and type", async () => {
    const userId = await seedUser();
    const eventId = `evt-${randomUUID()}`;
    await insertEventRun({ userId, eventId, omitSourceAndType: true });

    // With a bare `trigger ->> 'source'` in the index key both rows would carry
    // NULL there, NULLs are distinct in a unique index, and BOTH inserts would
    // succeed — enforcement silently off for the shape the contract still
    // accepts. The coalesce in EVENT_RUN_IDENTITY_PARTS is what closes it (D6).
    const constraint = await expectUniqueViolation(() =>
      insertEventRun({ userId, eventId, omitSourceAndType: true }),
    );
    assert.equal(constraint, EVENT_ACTIVE_RUN_INDEX);
    assert.equal(await countActiveEventRuns(userId, eventId), 1);
  });
});
