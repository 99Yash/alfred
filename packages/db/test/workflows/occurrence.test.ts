import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { workflowOccurrenceKey } from "@alfred/db/workflow-occurrence";

describe("durable workflow occurrence identity (#558)", () => {
  test("cron identity includes the pinned revision and scheduled instant", () => {
    const base = {
      kind: "cron" as const,
      workflowId: "wf_1",
      revisionId: "wfr_1",
      scheduledFor: "2026-08-01T07:00:00.000Z",
    };
    assert.equal(workflowOccurrenceKey(base), workflowOccurrenceKey({ ...base }));
    assert.notEqual(
      workflowOccurrenceKey(base),
      workflowOccurrenceKey({ ...base, revisionId: "wfr_2" }),
    );
    assert.notEqual(
      workflowOccurrenceKey(base),
      workflowOccurrenceKey({ ...base, scheduledFor: "2026-08-02T07:00:00.000Z" }),
    );
  });

  test("event identity is only the workflow, provider, and stable delivery id", () => {
    const base = {
      kind: "event" as const,
      workflowId: "wf_1",
      provider: "gmail",
      eventId: "delivery_1",
    };
    assert.equal(workflowOccurrenceKey(base), workflowOccurrenceKey({ ...base }));
  });

  test("manual identity is the workflow plus caller request id", () => {
    const first = workflowOccurrenceKey({
      kind: "manual",
      workflowId: "wf_1",
      requestId: "request_1",
    });
    assert.equal(
      first,
      workflowOccurrenceKey({ kind: "manual", workflowId: "wf_1", requestId: "request_1" }),
    );
    assert.notEqual(
      first,
      workflowOccurrenceKey({ kind: "manual", workflowId: "wf_1", requestId: "request_2" }),
    );
  });
});
