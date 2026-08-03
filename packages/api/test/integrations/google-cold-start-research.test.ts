import { EVENT_ACTIVE_RUN_INDEX, RUN_DEDUP_KEY_INDEX } from "@alfred/db/schemas";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createGoogleColdStartResearchHandler } from "../../src/composition/google-cold-start-research";
import {
  googleColdStartResearchRequestSchema,
  googleColdStartResearchResultSchema,
  NoGoogleColdStartResearchHandlerRegisteredError,
  registerGoogleColdStartResearchHandler,
  requestGoogleColdStartResearch,
} from "../../src/modules/integrations/google-cold-start-research";
import { requestColdStartResearchAfterGoogleCallback } from "../../src/modules/integrations/google-routes";

const request = {
  userId: "user-1",
  credentialId: "credential-1",
};

function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error(`duplicate ${constraint}`), {
    code: "23505",
    constraint,
  });
}

describe("Google cold-start research composition seam", () => {
  test("owns strict request and result schemas and rejects missing composition", async () => {
    assert.equal(googleColdStartResearchRequestSchema.safeParse(request).success, true);
    assert.equal(
      googleColdStartResearchRequestSchema.safeParse({ ...request, unexpected: true }).success,
      false,
    );
    assert.equal(
      googleColdStartResearchResultSchema.safeParse({ status: "enqueued" }).success,
      true,
    );
    assert.equal(
      googleColdStartResearchResultSchema.safeParse({ status: "duplicate", runId: "run-1" })
        .success,
      false,
    );

    await assert.rejects(
      () => requestGoogleColdStartResearch(request),
      NoGoogleColdStartResearchHandlerRegisteredError,
    );
  });

  test("validates registered handler results and unregisters by identity", async () => {
    const unregister = registerGoogleColdStartResearchHandler(async () => ({
      status: "enqueued",
      unexpected: true,
    }));

    try {
      await assert.rejects(() => requestGoogleColdStartResearch(request));
    } finally {
      unregister();
    }

    await assert.rejects(
      () => requestGoogleColdStartResearch(request),
      NoGoogleColdStartResearchHandlerRegisteredError,
    );
  });

  test("creates the exact event run before enqueueing it", async () => {
    const calls: string[] = [];
    const received: unknown[] = [];
    const handler = createGoogleColdStartResearchHandler({
      async createRun(args) {
        calls.push("create");
        received.push(args);
        return { runId: "run-1", created: true };
      },
      async enqueueRun(runId) {
        calls.push(`enqueue:${runId}`);
      },
    });

    assert.deepEqual(await handler(request), { status: "enqueued" });
    assert.deepEqual(calls, ["create", "enqueue:run-1"]);
    assert.deepEqual(received, [
      {
        userId: "user-1",
        workflowSlug: "cold-start-research",
        input: { reason: "signup" },
        trigger: {
          kind: "event",
          source: "google.oauth.callback",
          type: "completed",
          eventId: "google.callback:credential-1",
        },
        workflowRevisionId: null,
        occurrence: {
          kind: "event",
          workflowId: "cold-start-research",
          provider: "google.oauth.callback",
          eventId: "google.callback:credential-1",
        },
      },
    ]);
  });

  for (const constraint of [EVENT_ACTIVE_RUN_INDEX, RUN_DEDUP_KEY_INDEX]) {
    test(`maps ${constraint} to a duplicate without enqueueing`, async () => {
      let enqueues = 0;
      const handler = createGoogleColdStartResearchHandler({
        async createRun() {
          throw uniqueViolation(constraint);
        },
        async enqueueRun() {
          enqueues++;
        },
      });

      assert.deepEqual(await handler(request), { status: "duplicate" });
      assert.equal(enqueues, 0);
    });
  }

  test("rethrows unrelated create failures and enqueue failures", async () => {
    const unrelated = uniqueViolation("some_other_unique_idx");
    const createFailure = new Error("create unavailable");
    const enqueueFailure = new Error("queue unavailable");

    for (const failure of [unrelated, createFailure]) {
      const handler = createGoogleColdStartResearchHandler({
        async createRun() {
          throw failure;
        },
      });
      await assert.rejects(() => handler(request), failure);
    }

    const handler = createGoogleColdStartResearchHandler({
      async createRun() {
        return { runId: "run-1", created: true };
      },
      async enqueueRun() {
        throw enqueueFailure;
      },
    });
    await assert.rejects(() => handler(request), enqueueFailure);
  });

  test("keeps scheduling failures best-effort at the OAuth callback boundary", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      await requestColdStartResearchAfterGoogleCallback(request, async () => {
        throw new Error("research unavailable");
      });
      assert.match(String(warnings[0]?.[0]), /failed to enqueue cold-start research for user-1/);
      assert.equal(warnings[0]?.[1], "research unavailable");
    } finally {
      console.warn = originalWarn;
    }
  });
});
