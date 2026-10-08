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
import { and, eq, inArray, sql } from "drizzle-orm";
import { coldStartResearchWorkflow } from "@alfred/assistant/knowledge";

import {
  _resetRegistryForTests,
  getWorkflow,
  registerRecipe,
} from "@alfred/assistant/execution/registry";
import { createRun } from "@alfred/assistant/execution/service";
import type { StepResult, Workflow } from "@alfred/assistant/execution";
import {
  registerTriggerConsumers,
  unregisterTriggerConsumers,
} from "@alfred/assistant/runtime/test-support";
import { publishDomainEvent } from "@alfred/assistant/triggers";
import { acceptEvent } from "@alfred/assistant/automation";
import { publishGoogleCallbackCompleted } from "@alfred/assistant/connections";
import { COLD_START_WORKFLOW_SLUG } from "@alfred/assistant/knowledge/cold-start";
import { uniqueViolationConstraint } from "@alfred/db/pg-errors";
import { closeRedis } from "@alfred/db/redis";
import { dbBackedSkip } from "../support/db-backed";

/**
 * Two concurrent dispatches of one event must create one run (#531).
 * {@link EVENT_ACTIVE_RUN_INDEX} keys on the event identity of non-terminal runs, `reason` included.
 * The losing dispatch counts as a duplicate, not a failure, on either dedup index.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-event-dedup-";

const EVENT_WORKFLOW_SLUG = "__test-event-dedup";

const SINGLETON_WORKFLOW_SLUG = "__test-event-dedup-singleton";

const RAW_WORKFLOW_SLUG = "__test-event-dedup-raw";

const SOURCE = "gmail";

const TYPE = "message_received";

const RAW_SOURCE = "sentry";

const RAW_KIND = "comment.created";

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

/** Event workflow with a `dedupKey`: different events collide on {@link RUN_DEDUP_KEY_INDEX} (D7). */
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

/** Raw-kind subscriber (ADR-0097). A redelivered receipt has the same event id, so it collides too. */
const rawEventWorkflow: Workflow<Record<string, never>> = {
  slug: RAW_WORKFLOW_SLUG,
  name: "event dedup raw kind test",
  trigger: { kind: "event", source: RAW_SOURCE, type: "raw", rawKind: RAW_KIND },
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

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });

  return userId;
}

/** Seed only one workflow, or every dispatch matches twice and blurs which index fired. */
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
      // Built-ins need no pinned revision; the body is registered above.
      isBuiltin: true,
    });

  return userId;
}

async function seedUserWithRawEventWorkflow(): Promise<string> {
  const userId = await seedUser();
  await db()
    .insert(workflows)
    .values({
      userId,
      slug: RAW_WORKFLOW_SLUG,
      name: "event dedup raw kind test",
      trigger: { kind: "event", source: RAW_SOURCE, type: "raw", rawKind: RAW_KIND },
      allowedIntegrations: [RAW_SOURCE],
      status: "active",
      isBuiltin: true,
    });

  return userId;
}

async function seedUserWithGoogleCallbackWorkflow(): Promise<string> {
  const userId = await seedUser();
  await db()
    .insert(workflows)
    .values({
      userId,
      slug: COLD_START_WORKFLOW_SLUG,
      name: "cold-start callback reason test",
      trigger: { kind: "event", source: "google.oauth.callback", type: "completed" },
      allowedIntegrations: [],
      status: "active",
      isBuiltin: true,
    });

  return userId;
}

/** Insert a run row shaped as `createRun` writes it. */
async function insertEventRun(args: {
  userId: string;
  eventId: string;
  reason?: string | undefined;
  status?: string;
  /** The pre-ADR-0047 shape without `source`/`type`, which the contract still accepts (D6). */
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

/** Non-terminal runs for one event id. */
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

async function countActiveRuns(userId: string, workflowSlug: string): Promise<number> {
  const rows = await db()
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, workflowSlug)));

  return rows.filter((r) => !TERMINAL.has(r.status)).length;
}

describe("event-dispatch duplicate-run guard (#531)", { skip: SKIP }, () => {
  before(() => {
    if (!getWorkflow(EVENT_WORKFLOW_SLUG)) registerRecipe(eventWorkflow);

    if (!getWorkflow(SINGLETON_WORKFLOW_SLUG)) registerRecipe(singletonEventWorkflow);

    if (!getWorkflow(RAW_WORKFLOW_SLUG)) registerRecipe(rawEventWorkflow);

    if (!getWorkflow(COLD_START_WORKFLOW_SLUG)) registerRecipe(coldStartResearchWorkflow);
    registerTriggerConsumers();
  });
  after(async () => {
    unregisterTriggerConsumers();

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

  test("concurrent trigger publications create exactly one workflow run", async () => {
    const userId = await seedUserWithEventWorkflow();
    const eventId = `evt-${randomUUID()}`;
    const dispatch = () => publishDomainEvent({ userId, source: SOURCE, type: TYPE, eventId });

    const [a, b] = await Promise.all([dispatch(), dispatch()]);

    // All nine consumers accept the event; eight no-op. The run count is the guard.
    assert.deepEqual(a, { acceptedConsumers: 9 });
    assert.deepEqual(b, { acceptedConsumers: 9 });
    assert.equal(await countActiveEventRuns(userId, eventId), 1);
  });

  test("a raw kind trigger fires once per receipt and only on its own kind (#990)", async () => {
    const userId = await seedUserWithRawEventWorkflow();
    // A raw receipt's event id is its dedup key, so a redelivery carries the same id.
    const eventId = `raw:${RAW_KIND}:${randomUUID()}`;
    const payload = { receiptId: `rcpt-${randomUUID()}`, deliveryKey: eventId };

    const dispatch = () =>
      publishDomainEvent({
        userId,
        source: RAW_SOURCE,
        type: "raw",
        rawKind: RAW_KIND,
        eventId,
        payload,
      });

    // `sentry-activity-fold` returns on `isRawEventType`, so a raw kind reaches no reducer.
    const [a, b] = await Promise.all([dispatch(), dispatch()]);
    assert.deepEqual(a, { acceptedConsumers: 9 });
    assert.deepEqual(b, { acceptedConsumers: 9 });
    assert.equal(await countActiveEventRuns(userId, eventId, RAW_WORKFLOW_SLUG), 1);

    const otherKind = await acceptEvent({
      userId,
      source: RAW_SOURCE,
      type: "raw",
      rawKind: "issue.ignored",
      eventId: `raw:issue.ignored:${randomUUID()}`,
      payload: { receiptId: `rcpt-${randomUUID()}`, deliveryKey: "other" },
    });

    assert.equal(otherKind.matched, 0);
    assert.equal(otherKind.created, 0);
  });

  test("a completed Google callback starts cold-start research with the signup reason", async () => {
    const userId = await seedUserWithGoogleCallbackWorkflow();

    await publishGoogleCallbackCompleted(userId, `credential-${randomUUID()}`);

    const [run] = await db()
      .select({ state: agentRuns.state })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, COLD_START_WORKFLOW_SLUG)),
      );

    assert.deepEqual(run?.state, { reason: "signup" });
  });

  test("an account-bound workflow ignores another account's event", async () => {
    const userId = await seedUserWithEventWorkflow(EVENT_WORKFLOW_SLUG, "gmail-account-a");

    const wrongAccount = await acceptEvent({
      userId,
      source: SOURCE,
      type: TYPE,
      eventId: `evt-${randomUUID()}`,
      accountRef: "gmail-account-b",
    });

    assert.equal(wrongAccount.matched, 0);
    assert.equal(wrongAccount.created, 0);

    const selectedAccount = await acceptEvent({
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

    // Two different events: only the `dedupKey` sees the duplicate.
    const first = await acceptEvent({
      userId,
      source: SOURCE,
      type: TYPE,
      eventId: `evt-${randomUUID()}`,
    });

    const second = await acceptEvent({
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

    // Bypass `acceptEvent`'s catch to pin which index the drop came from.
    const constraint = await expectUniqueViolation(() =>
      createRun({
        userId,
        workflowSlug: SINGLETON_WORKFLOW_SLUG,
        trigger: { kind: "event", source: SOURCE, type: TYPE, eventId: "evt-second" },
        workflowRevisionId: null,
        occurrence: {
          kind: "event",
          workflowId: SINGLETON_WORKFLOW_SLUG,
          provider: SOURCE,
          eventId: "evt-second",
        },
      }),
    );

    assert.equal(constraint, RUN_DEDUP_KEY_INDEX);
  });

  test("the index still enforces when the trigger omits source and type", async () => {
    const userId = await seedUser();
    const eventId = `evt-${randomUUID()}`;
    await insertEventRun({ userId, eventId, omitSourceAndType: true });

    // NULLs are distinct in a unique index; the coalesce in EVENT_RUN_IDENTITY_PARTS closes that (D6).
    const constraint = await expectUniqueViolation(() =>
      insertEventRun({ userId, eventId, omitSourceAndType: true }),
    );

    assert.equal(constraint, EVENT_ACTIVE_RUN_INDEX);
    assert.equal(await countActiveEventRuns(userId, eventId), 1);
  });
});
