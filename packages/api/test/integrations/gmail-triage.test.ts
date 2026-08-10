import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  gmailPostInsertTriageRequestSchema,
  gmailPostInsertTriageResultSchema,
  gmailTriageRelabelRequestSchema,
  gmailTriageRelabelResultSchema,
  NoGmailTriageHandlerRegisteredError,
  registerGmailTriageHandler,
  runGmailPostInsertTriage,
  runGmailTriageRelabel,
  type GmailTriageHandler,
} from "@alfred/assistant/connections/ingestion/gmail-triage";
import { pairReplyReevalTargets } from "../../src/composition/gmail-ingested-consumers";
import { createGmailTriageHandler } from "../../src/composition/gmail-triage";

const postInsertRequest = {
  credentialId: "credential-1",
  userId: "user-1",
  reconcileThreadIds: ["thread-1", "thread-2"],
  protectedDocumentIds: ["document-new"],
  replyReevalThreadIds: ["thread-2"],
};

describe("Gmail triage composition seam", () => {
  test("owns strict request and result schemas", () => {
    assert.equal(gmailPostInsertTriageRequestSchema.safeParse(postInsertRequest).success, true);
    assert.equal(
      gmailPostInsertTriageRequestSchema.safeParse({
        ...postInsertRequest,
        unexpected: true,
      }).success,
      false,
    );
    assert.equal(
      gmailPostInsertTriageResultSchema.safeParse({
        replyReevalTargets: [{ threadId: "thread-2", documentId: "document-inbound" }],
      }).success,
      true,
    );
    assert.equal(
      gmailTriageRelabelRequestSchema.safeParse({
        userId: "user-1",
        sourceThreadId: "thread-1",
      }).success,
      true,
    );
    assert.equal(
      gmailTriageRelabelResultSchema.safeParse({
        applied: false,
        reason: "writes-disabled",
      }).success,
      true,
    );
  });

  test("passes the complete post-insert batch and validates the handler result", async () => {
    let received: unknown;
    const unregister = registerGmailTriageHandler({
      async postInsert(request) {
        received = request;
        return {
          replyReevalTargets: [{ threadId: "thread-2", documentId: "document-inbound" }],
        };
      },
      async relabel() {
        return { applied: false, reason: "tag-not-found" };
      },
    });

    try {
      assert.deepEqual(await runGmailPostInsertTriage(postInsertRequest), {
        replyReevalTargets: [{ threadId: "thread-2", documentId: "document-inbound" }],
      });
      assert.deepEqual(received, postInsertRequest);
    } finally {
      unregister();
    }
  });

  test("preserves empty batches without calling private triage code directly", async () => {
    const emptyRequest = {
      ...postInsertRequest,
      reconcileThreadIds: [],
      protectedDocumentIds: [],
      replyReevalThreadIds: [],
    };
    const unregister = registerGmailTriageHandler({
      async postInsert(request) {
        assert.deepEqual(request, emptyRequest);
        return { replyReevalTargets: [] };
      },
      async relabel() {
        return { applied: false, reason: "tag-not-found" };
      },
    });

    try {
      assert.deepEqual(await runGmailPostInsertTriage(emptyRequest), {
        replyReevalTargets: [],
      });
    } finally {
      unregister();
    }
  });

  test("keeps the sent document id as the reply event id", () => {
    assert.deepEqual(
      pairReplyReevalTargets(
        [{ threadId: "thread-2", eventId: "sent-document-id" }],
        [
          { threadId: "thread-2", documentId: "inbound-document-id" },
          { threadId: "unrequested-thread", documentId: "ignored-document-id" },
        ],
      ),
      [
        {
          threadId: "thread-2",
          documentId: "inbound-document-id",
          eventId: "sent-document-id",
        },
      ],
    );
  });

  test("runs one queued relabel through the registered handler", async () => {
    const unregister = registerGmailTriageHandler({
      async postInsert() {
        return { replyReevalTargets: [] };
      },
      async relabel(request) {
        assert.deepEqual(request, { userId: "user-1", sourceThreadId: "thread-1" });
        return { applied: true, appliedLabelId: "label-1" };
      },
    });

    try {
      assert.deepEqual(
        await runGmailTriageRelabel({ userId: "user-1", sourceThreadId: "thread-1" }),
        { applied: true, appliedLabelId: "label-1" },
      );
    } finally {
      unregister();
    }
  });

  test("rejects missing composition so BullMQ can retry the job", async () => {
    await assert.rejects(
      () => runGmailPostInsertTriage(postInsertRequest),
      NoGmailTriageHandlerRegisteredError,
    );
  });

  test("rejects invalid adapter output at the interface", async () => {
    const invalidHandler = {
      async postInsert() {
        return { replyReevalTargets: [{ threadId: "thread-2" }] };
      },
      async relabel() {
        return { applied: false, reason: "not-a-reason" };
      },
    } as unknown as GmailTriageHandler;
    const unregister = registerGmailTriageHandler(invalidHandler);

    try {
      await assert.rejects(() => runGmailPostInsertTriage(postInsertRequest));
      await assert.rejects(() =>
        runGmailTriageRelabel({ userId: "user-1", sourceThreadId: "thread-1" }),
      );
    } finally {
      unregister();
    }
  });

  test("preserves thrown adapter failures for normal job retry", async () => {
    const failure = new Error("triage unavailable");
    const unregister = registerGmailTriageHandler({
      async postInsert() {
        throw failure;
      },
      async relabel() {
        throw failure;
      },
    });

    try {
      await assert.rejects(() => runGmailPostInsertTriage(postInsertRequest), failure);
      await assert.rejects(
        () => runGmailTriageRelabel({ userId: "user-1", sourceThreadId: "thread-1" }),
        failure,
      );
    } finally {
      unregister();
    }
  });

  test("the adapter swallows repair lookup failures and returns an empty reply set", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    const unregister = registerGmailTriageHandler(
      createGmailTriageHandler({
        async reconcileThreads() {
          throw new Error("reconcile unavailable");
        },
        async findNewestLiveInbound() {
          throw new Error("lookup unavailable");
        },
      }),
    );

    try {
      assert.deepEqual(await runGmailPostInsertTriage(postInsertRequest), {
        replyReevalTargets: [],
      });
      assert.match(String(warnings[0]?.[0]), /reconcileThreads failed/);
      assert.equal(warnings[0]?.[1], "reconcile unavailable");
      assert.match(String(warnings[1]?.[0]), /live inbound resolve failed/);
      assert.equal(warnings[1]?.[1], "lookup unavailable");
    } finally {
      unregister();
      console.warn = originalWarn;
    }
  });

  test("the adapter enqueues one relabel per repointed thread and projects reply targets", async () => {
    const enqueued: Array<{ userId: string; threadId: string }> = [];
    const logs: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args);
    const unregister = registerGmailTriageHandler(
      createGmailTriageHandler({
        async reconcileThreads() {
          return {
            threadsChecked: 2,
            threadsReconciled: 1,
            docsDeleted: 1,
            triageRepointed: 1,
            repointedThreadIds: ["thread-2"],
          };
        },
        async enqueueRelabel(userId, threadId) {
          enqueued.push({ userId, threadId });
        },
        async findNewestLiveInbound() {
          return [
            {
              threadId: "thread-2",
              documentId: "document-inbound",
              triageInternalField: "must-not-cross",
            },
          ];
        },
      }),
    );

    try {
      assert.deepEqual(await runGmailPostInsertTriage(postInsertRequest), {
        replyReevalTargets: [{ threadId: "thread-2", documentId: "document-inbound" }],
      });
      assert.deepEqual(enqueued, [{ userId: "user-1", threadId: "thread-2" }]);
      assert.match(String(logs[0]?.[0]), /docsDeleted=1 triageRepointed=1/);
    } finally {
      unregister();
      console.log = originalLog;
    }
  });
});
