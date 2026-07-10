import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user, workflows } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { serverEnv } from "@alfred/env/server";
import { IDB_KEY } from "@alfred/sync";
import { inArray } from "drizzle-orm";

import {
  _resetRegistryForTests,
  registerWorkflow,
} from "../../src/modules/agent/registry";
import {
  createRun,
  resolveWorkflowForRun,
} from "../../src/modules/agent/service";
import type { AgentDbExecutor, Workflow } from "../../src/modules/agent/types";
import { handlePull } from "../../src/modules/replicache/pull";
import { seedBuiltinWorkflowsForUser } from "../../src/modules/workflows/seeder";
import { closeRedis } from "../../src/queue/connection";

const RESUME_ONLY_SLUG = "retired-built-in";

function resumeOnlyWorkflow(): Workflow<unknown> {
  return {
    slug: RESUME_ONLY_SLUG,
    name: "Retired built-in",
    resumeOnly: true,
    trigger: { kind: "manual" },
    initialState: () => ({}),
    initialStep: "finish",
    steps: {
      finish: {
        id: "finish",
        run: async () => ({ kind: "done", state: {} }),
      },
    },
  };
}

describe("resume-only workflow run behavior", () => {
  beforeEach(() => {
    _resetRegistryForTests();
    registerWorkflow(resumeOnlyWorkflow());
  });

  afterEach(() => {
    _resetRegistryForTests();
  });

  test("an existing persisted run can still resolve its registered workflow", async () => {
    const rejectDatabaseAccess = new Proxy(
      {},
      {
        get() {
          throw new Error("registered workflow resolution must not access the database");
        },
      },
    ) as AgentDbExecutor;

    const resolved = await resolveWorkflowForRun({
      userId: "persisted-run-owner",
      workflowSlug: RESUME_ONLY_SLUG,
      tx: rejectDatabaseAccess,
    });

    assert.equal(resolved.workflow.slug, RESUME_ONLY_SLUG);
    assert.equal(resolved.workflow.resumeOnly, true);
    assert.ok(resolved.workflow.steps.finish);
  });

  test("a new createRun attempt is rejected before initialization or persistence", async () => {
    let initialized = false;
    const workflow = resumeOnlyWorkflow();
    workflow.initialState = () => {
      initialized = true;
      return {};
    };
    _resetRegistryForTests();
    registerWorkflow(workflow);

    const rejectDatabaseAccess = new Proxy(
      {},
      {
        get() {
          throw new Error("resume-only rejection must not access persistence");
        },
      },
    ) as AgentDbExecutor;

    await assert.rejects(
      createRun(
        {
          userId: "new-run-owner",
          workflowSlug: RESUME_ONLY_SLUG,
          trigger: { kind: "manual" },
        },
        rejectDatabaseAccess,
      ),
      /available only to resume existing runs/,
    );
    assert.equal(initialized, false);
  });
});

const SERVER_ENV_FIXTURES: Record<string, string> = {
  BETTER_AUTH_SECRET: "test better auth secret with length",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALFRED_ALLOWED_EMAIL: "test@example.com",
  RESEND_API_KEY: "test-resend",
  RESEND_FROM_EMAIL: "Alfred <noreply@example.com>",
  ANTHROPIC_API_KEY: "test-anthropic",
  GOOGLE_GENERATIVE_AI_API_KEY: "test-google-ai",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/auth/callback/google",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_CLIENT_ID: "test-github-client",
  GITHUB_APP_CLIENT_SECRET: "test-github-secret",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
};

function hasDatabaseAndRedis(): boolean {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value;
  }
  try {
    return Boolean(databaseEnv().DATABASE_URL && serverEnv().REDIS_URL);
  } catch {
    return false;
  }
}

const SKIP_TOMBSTONE = hasDatabaseAndRedis()
  ? false
  : "DATABASE_URL/REDIS_URL not set — skipping DB/Redis-backed test";
const createdUserIds: string[] = [];

describe(
  "resume-only built-in retirement pull semantics (DB/Redis-backed)",
  { skip: SKIP_TOMBSTONE },
  () => {
    beforeEach(() => {
      _resetRegistryForTests();
      registerWorkflow(resumeOnlyWorkflow());
    });

    afterEach(() => {
      _resetRegistryForTests();
    });

    after(async () => {
      if (createdUserIds.length > 0) {
        await db().delete(user).where(inArray(user.id, createdUserIds));
      }
      await closeRedis();
      await closeConnections();
    });

    test("deleting a stale built-in produces a workflow tombstone on the next pull", async () => {
      const userId = `test-resume-only-${randomUUID()}`;
      const clientGroupID = `test-resume-only-cg-${randomUUID()}`;
      createdUserIds.push(userId);
      await db()
        .insert(user)
        .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
      await db().insert(workflows).values({
        userId,
        slug: RESUME_ONLY_SLUG,
        name: "Stale built-in",
        trigger: { kind: "manual" },
        status: "active",
        isBuiltin: true,
      });

      const firstPull = await handlePull(userId, {
        pullVersion: 1,
        clientGroupID,
        cookie: null,
      });
      assert.ok(!("forbidden" in firstPull));
      const workflowKey = IDB_KEY.WORKFLOW({ id: RESUME_ONLY_SLUG });
      assert.ok(
        firstPull.patch.some((op) => op.op === "put" && op.key === workflowKey),
        "the stale built-in must be present in the client's prior view",
      );

      const retired = await seedBuiltinWorkflowsForUser(userId);
      assert.equal(retired.retired, 1);

      const secondPull = await handlePull(userId, {
        pullVersion: 1,
        clientGroupID,
        cookie: firstPull.cookie,
      });
      assert.ok(!("forbidden" in secondPull));
      assert.deepEqual(
        secondPull.patch.filter((op) => "key" in op && op.key === workflowKey),
        [{ op: "del", key: workflowKey }],
      );
    });
  },
);
