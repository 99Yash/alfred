import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user, workflows } from "@alfred/db/schemas";
import { IDB_KEY } from "@alfred/sync";
import { inArray } from "drizzle-orm";

import { _resetRegistryForTests, registerRecipe } from "@alfred/assistant/execution/registry";
import { createRun } from "@alfred/assistant/execution/service";
import { resolveWorkflowForRun } from "@alfred/assistant/execution/resolve-workflow";
import type { AgentDbExecutor, Workflow } from "@alfred/assistant/execution/types";
import { handlePull } from "../../src/sync/pull";
import { seedBuiltinWorkflowsForUser } from "@alfred/assistant/automation/seeder";
import { closeRedis } from "@alfred/db/redis";
import { dbBackedSkip } from "../support/db-backed";

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
    registerRecipe(resumeOnlyWorkflow());
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
    registerRecipe(workflow);

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
          occurrence: {
            kind: "manual",
            requestId: "resume-only-rejection",
          },
        },
        rejectDatabaseAccess,
      ),
      /available only to resume existing runs/,
    );
    assert.equal(initialized, false);
  });
});

const SERVER_ENV_FIXTURES = {
  BETTER_AUTH_SECRET: "test better auth secret with length",
  // #453: `serverEnv()` requires a 32-byte credential KEK in every environment.
  OAUTH_CREDENTIAL_KEK: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
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
} satisfies Record<string, string>;

// The fixtures must land before the first `serverEnv()` call in a test body,
// and `serverEnv()` memoizes. So this stays at module scope. It sets neither
// DATABASE_URL nor REDIS_URL, so it cannot hide an absent service from the
// guard below.
for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
  process.env[key] ??= value;
}

const SKIP_TOMBSTONE = dbBackedSkip("database+redis");
const createdUserIds: string[] = [];

describe(
  "resume-only built-in retirement pull semantics (DB/Redis-backed)",
  { skip: SKIP_TOMBSTONE },
  () => {
    beforeEach(() => {
      _resetRegistryForTests();
      registerRecipe(resumeOnlyWorkflow());
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
      await db()
        .insert(workflows)
        .values({
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
