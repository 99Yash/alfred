import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  captureGmailObservations,
  gmailKindRefoldResultSchema,
  gmailKindRefoldSweepResultSchema,
  gmailObservationCaptureRequestSchema,
  gmailObservationCaptureResultSchema,
  NoGmailUserModelHandlerRegisteredError,
  refoldGmailKindProjection,
  registerGmailUserModelHandler,
  scheduleGmailKindRefoldSweep,
  type GmailUserModelHandler,
} from "@alfred/assistant/connections/ingestion/gmail-user-model";
import { createGmailUserModelHandler } from "../../src/composition/gmail-user-model";
import type { GmailDocumentForReduction } from "@alfred/assistant/knowledge";
import { runGmailKindRefoldJob } from "@alfred/assistant/connections/ingestion/queue";

const captureRequest = {
  userId: "user-1",
  documentIds: ["document-1", "document-2"],
};

describe("Gmail user-model composition seam", () => {
  test("owns strict request and result schemas", () => {
    assert.equal(gmailObservationCaptureRequestSchema.safeParse(captureRequest).success, true);
    assert.equal(
      gmailObservationCaptureRequestSchema.safeParse({
        ...captureRequest,
        unexpected: true,
      }).success,
      false,
    );
    assert.equal(
      gmailObservationCaptureResultSchema.safeParse({ status: "captured" }).success,
      true,
    );
    assert.equal(
      gmailObservationCaptureResultSchema.safeParse({
        status: "captured",
        inserted: 1,
      }).success,
      false,
    );
    assert.equal(
      gmailKindRefoldResultSchema.safeParse({
        status: "activated",
        projectionVersion: 2,
        profileCount: 4,
        checksum: "checksum-2",
      }).success,
      true,
    );
    assert.equal(gmailKindRefoldSweepResultSchema.safeParse({ enqueued: 2 }).success, true);
    assert.equal(
      gmailKindRefoldResultSchema.safeParse({ status: "skipped", reason: "up-to-date" }).success,
      true,
    );
    assert.equal(
      gmailKindRefoldResultSchema.safeParse({ status: "skipped", reason: "up-to-dtae" }).success,
      false,
    );
    assert.equal(
      gmailObservationCaptureRequestSchema.safeParse({
        userId: "u".repeat(501),
        documentIds: [],
      }).success,
      false,
    );
    assert.equal(
      gmailObservationCaptureRequestSchema.safeParse({
        userId: "user-1",
        documentIds: Array.from({ length: 10_001 }, (_, index) => `document-${index}`),
      }).success,
      false,
    );
  });

  test("passes validated requests and results through the registered handler", async () => {
    let received: unknown;
    const unregister = registerGmailUserModelHandler({
      async capture(request) {
        received = request;
        return { status: "captured" };
      },
      async refold(request) {
        assert.deepEqual(request, { userId: "user-1" });
        return { status: "skipped", reason: "up-to-date" };
      },
      async sweep(request) {
        assert.deepEqual(request, {});
        return { enqueued: 2 };
      },
    });

    try {
      assert.deepEqual(await captureGmailObservations(captureRequest), { status: "captured" });
      assert.deepEqual(received, captureRequest);
      assert.deepEqual(await refoldGmailKindProjection({ userId: "user-1" }), {
        status: "skipped",
        reason: "up-to-date",
      });
      assert.deepEqual(await scheduleGmailKindRefoldSweep({}), { enqueued: 2 });
    } finally {
      unregister();
    }
  });

  test("rejects missing composition and invalid handler output", async () => {
    await assert.rejects(
      () => captureGmailObservations(captureRequest),
      NoGmailUserModelHandlerRegisteredError,
    );
    await assert.rejects(
      () => refoldGmailKindProjection({ userId: "user-1" }),
      NoGmailUserModelHandlerRegisteredError,
    );
    await assert.rejects(
      () => scheduleGmailKindRefoldSweep({}),
      NoGmailUserModelHandlerRegisteredError,
    );

    const invalidHandler = {
      async capture() {
        return { status: "unexpected" };
      },
      async refold() {
        return { status: "activated", projectionVersion: -1 };
      },
      async sweep() {
        return { enqueued: -1 };
      },
    } as unknown as GmailUserModelHandler;
    const unregister = registerGmailUserModelHandler(invalidHandler);
    try {
      await assert.rejects(() => captureGmailObservations(captureRequest));
      await assert.rejects(() => refoldGmailKindProjection({ userId: "user-1" }));
      await assert.rejects(() => scheduleGmailKindRefoldSweep({}));
    } finally {
      unregister();
    }
  });

  test("preserves empty capture without loading, reducing, appending, or scheduling", async () => {
    let calls = 0;
    const unregister = registerGmailUserModelHandler(
      createGmailUserModelHandler({
        async loadDocumentChunk() {
          calls++;
          return [];
        },
        reduceDocument() {
          calls++;
          return { observations: [], issues: [] };
        },
        async appendObservation() {
          calls++;
          return { status: "inserted" };
        },
        async enqueueRefold() {
          calls++;
        },
      }),
    );

    try {
      assert.deepEqual(await captureGmailObservations({ userId: "user-1", documentIds: [] }), {
        status: "captured",
      });
      assert.equal(calls, 0);
    } finally {
      unregister();
    }
  });

  test("loads Gmail documents in 1,000-id chunks", async () => {
    const chunkSizes: number[] = [];
    const unregister = registerGmailUserModelHandler(
      createGmailUserModelHandler({
        async loadDocumentChunk(_userId, documentIds) {
          chunkSizes.push(documentIds.length);
          return [];
        },
      }),
    );

    try {
      const documentIds = Array.from({ length: 2001 }, (_, index) => `document-${index}`);
      assert.deepEqual(await captureGmailObservations({ userId: "user-1", documentIds }), {
        status: "captured",
      });
      assert.deepEqual(chunkSizes, [1000, 1000, 1]);
    } finally {
      unregister();
    }
  });

  test("counts issues, append outcomes, and document errors and schedules one refold", async () => {
    const warnings: unknown[][] = [];
    const logs: unknown[][] = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (...args: unknown[]) => warnings.push(args);
    console.log = (...args: unknown[]) => logs.push(args);
    const enqueued: string[] = [];
    const unregister = registerGmailUserModelHandler(
      createGmailUserModelHandler({
        async loadDocumentChunk() {
          return [
            gmailDoc("inserted"),
            gmailDoc("append-error"),
            gmailDoc("deduped"),
            gmailDoc("skipped"),
            gmailDoc("reduce-error"),
          ];
        },
        reduceDocument(document) {
          if (document.id === "reduce-error") throw new Error("reduce unavailable");
          if (document.id === "skipped") {
            return {
              observations: [],
              issues: [
                {
                  documentId: document.id,
                  severity: "skip",
                  code: "missing_sender",
                  message: "missing sender",
                },
              ],
            };
          }
          return {
            observations: [observationInput(document.id)],
            issues:
              document.id === "inserted"
                ? [
                    {
                      documentId: document.id,
                      severity: "warn" as const,
                      code: "dropped_recipient",
                      message: "dropped recipient",
                    },
                  ]
                : [],
          };
        },
        async appendObservation(input) {
          if (input.familyKey.endsWith(":append-error")) {
            throw new Error("append unavailable");
          }
          return { status: input.familyKey.endsWith(":inserted") ? "inserted" : "deduped" };
        },
        async enqueueRefold(userId) {
          enqueued.push(userId);
        },
      }),
    );

    try {
      assert.deepEqual(await captureGmailObservations(captureRequest), { status: "captured" });
      assert.deepEqual(enqueued, ["user-1"]);
      assert.match(String(warnings[0]?.[0]), /observation warn doc=inserted/);
      assert.match(String(warnings[1]?.[0]), /observation failed doc=append-error/);
      assert.equal(warnings[1]?.[1], "append unavailable");
      assert.match(String(warnings[2]?.[0]), /observation skip doc=skipped/);
      assert.match(String(warnings[3]?.[0]), /observation failed doc=reduce-error/);
      assert.equal(warnings[3]?.[1], "reduce unavailable");
      assert.match(
        String(logs[0]?.[0]),
        /docs=5 inserted=1 deduped=1 skipped=1 warnings=1 errors=2/,
      );
    } finally {
      unregister();
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });

  test("dedup-only capture does not schedule a refold", async () => {
    let enqueued = 0;
    const unregister = registerGmailUserModelHandler(
      createGmailUserModelHandler({
        async loadDocumentChunk() {
          return [gmailDoc("deduped")];
        },
        reduceDocument(document) {
          return { observations: [observationInput(document.id)], issues: [] };
        },
        async appendObservation() {
          return { status: "deduped" };
        },
        async enqueueRefold() {
          enqueued++;
        },
      }),
    );

    try {
      assert.deepEqual(await captureGmailObservations(captureRequest), { status: "captured" });
      assert.equal(enqueued, 0);
    } finally {
      unregister();
    }
  });

  test("keeps capture failures best-effort and refold failures retryable", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    const failure = new Error("user-model unavailable");
    const unregister = registerGmailUserModelHandler(
      createGmailUserModelHandler({
        async loadDocumentChunk() {
          throw failure;
        },
        async refoldProjection() {
          throw failure;
        },
      }),
    );

    try {
      assert.deepEqual(await captureGmailObservations(captureRequest), { status: "failed" });
      assert.match(String(warnings[0]?.[0]), /observation capture failed user=user-1/);
      assert.equal(warnings[0]?.[1], "user-model unavailable");
      await assert.rejects(() => refoldGmailKindProjection({ userId: "user-1" }), failure);
    } finally {
      unregister();
      console.warn = originalWarn;
    }
  });

  test("schedules one refold for each active projection user", async () => {
    const enqueued: string[] = [];
    const unregister = registerGmailUserModelHandler(
      createGmailUserModelHandler({
        async loadActiveProjectionUserIds() {
          return ["user-1", "user-2"];
        },
        async enqueueRefold(userId) {
          enqueued.push(userId);
        },
      }),
    );

    try {
      assert.deepEqual(await scheduleGmailKindRefoldSweep({}), { enqueued: 2 });
      assert.deepEqual(enqueued, ["user-1", "user-2"]);
    } finally {
      unregister();
    }
  });

  test("propagates capture boot errors and failures; keeps refold results and failures retryable", async () => {
    // A missing handler is a boot-wiring failure the integration seam must surface.
    await assert.rejects(
      () => captureGmailObservations({ userId: "user-1", documentIds: ["document-1"] }),
      NoGmailUserModelHandlerRegisteredError,
    );

    const captureFailure = new Error("capture unavailable");
    const refoldFailure = new Error("refold unavailable");
    let shouldFailRefold = false;
    const unregister = registerGmailUserModelHandler({
      async capture() {
        throw captureFailure;
      },
      async refold() {
        if (shouldFailRefold) throw refoldFailure;
        return {
          status: "activated",
          projectionVersion: 2,
          profileCount: 4,
          checksum: "checksum-2",
        };
      },
      async sweep() {
        return { enqueued: 0 };
      },
    });

    try {
      // The integration seam no longer swallows a capture failure — the
      // best-effort swallow now lives at the trigger seam (see the
      // gmail-ingested consumers test), so a raw capture error propagates here.
      await assert.rejects(
        () => captureGmailObservations({ userId: "user-1", documentIds: ["document-1"] }),
        captureFailure,
      );
      assert.deepEqual(await runGmailKindRefoldJob("user-1"), {
        status: "activated",
        projectionVersion: 2,
        profileCount: 4,
        checksum: "checksum-2",
      });

      shouldFailRefold = true;
      await assert.rejects(() => runGmailKindRefoldJob("user-1"), refoldFailure);
    } finally {
      unregister();
    }
  });
});

function gmailDoc(id: string): GmailDocumentForReduction {
  return {
    id,
    userId: "user-1",
    sourceId: `source-${id}`,
    sourceThreadId: `thread-${id}`,
    accountId: "account-1",
    title: "Message",
    authoredAt: new Date("2026-08-02T00:00:00.000Z"),
    raw: {},
    metadata: {},
  };
}

function observationInput(documentId: string) {
  return {
    userId: "user-1",
    source: "gmail" as const,
    kind: "email_message" as const,
    occurredAt: new Date("2026-08-02T00:00:00.000Z"),
    familyKey: `gmail:message:account-1:${documentId}`,
    evidenceHash: `sha256:${documentId}`,
    subjectIdentity: { kind: "email" as const, value: "sender@example.com" },
    payload: {},
  };
}
