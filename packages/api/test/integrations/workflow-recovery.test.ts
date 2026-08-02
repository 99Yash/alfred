import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  registerWorkflowRecoveryHandler,
  resolveWorkflowRecoveryTarget,
  workflowRecoveryRequestSchema,
  workflowRecoveryResultSchema,
} from "../../src/modules/integrations/workflow-recovery";

const request = {
  userId: "user-1",
  workflowId: "workflow/1",
  revisionId: "revision?1",
};

describe("integration workflow recovery", () => {
  test("validates strict recovery requests and results from their source schemas", () => {
    assert.equal(workflowRecoveryRequestSchema.safeParse(request).success, true);
    assert.equal(
      workflowRecoveryRequestSchema.safeParse({ ...request, unexpected: true }).success,
      false,
    );
    assert.equal(
      workflowRecoveryResultSchema.safeParse({
        status: "ready",
        workflowSlug: "weekly-report",
        revisionId: "revision-1",
      }).success,
      true,
    );
    assert.equal(
      workflowRecoveryResultSchema.safeParse({
        status: "failure",
        failureKind: "stale_revision",
        revisionId: "revision-1",
      }).success,
      false,
    );
  });

  test("parses unknown input at the exported recovery interface", async () => {
    await assert.rejects(
      resolveWorkflowRecoveryTarget({ ...request, unexpected: true }),
      /Unrecognized key/,
    );
  });

  test("returns the ready workflow redirect from a successful recovery", async () => {
    const unregister = registerWorkflowRecoveryHandler(async () => ({
      status: "ready",
      workflowSlug: "weekly/report",
      revisionId: "revision?1",
    }));

    try {
      assert.equal(
        await resolveWorkflowRecoveryTarget(request),
        "/workflows/weekly%2Freport?workflow_recovery=ready&revision_id=revision%3F1",
      );
    } finally {
      unregister();
    }
  });

  test("returns the blocked workflow redirect from a successful recovery", async () => {
    const unregister = registerWorkflowRecoveryHandler(async () => ({
      status: "blocked",
      workflowSlug: "weekly-report",
      revisionId: "revision-1",
    }));

    try {
      assert.equal(
        await resolveWorkflowRecoveryTarget(request),
        "/workflows/weekly-report?workflow_recovery=blocked&revision_id=revision-1",
      );
    } finally {
      unregister();
    }
  });

  test("preserves a typed workflow recovery failure in the redirect", async () => {
    const unregister = registerWorkflowRecoveryHandler(async () => ({
      status: "failure",
      failureKind: "stale_revision",
    }));

    try {
      assert.equal(
        await resolveWorkflowRecoveryTarget(request),
        "/workflows?workflow_recovery=stale_revision",
      );
    } finally {
      unregister();
    }
  });

  test("maps a thrown recovery failure to the generic failure redirect", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    const unregister = registerWorkflowRecoveryHandler(async () => {
      throw new Error("recovery unavailable");
    });

    try {
      assert.equal(
        await resolveWorkflowRecoveryTarget(request),
        "/workflows?workflow_recovery=failed",
      );
      assert.match(String(warnings[0]?.[0]), /failed to recover workflow workflow\/1/);
      assert.equal(warnings[0]?.[1], "recovery unavailable");
    } finally {
      unregister();
      console.warn = originalWarn;
    }
  });
});
