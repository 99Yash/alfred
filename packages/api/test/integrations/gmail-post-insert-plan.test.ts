import assert from "node:assert/strict";
import test from "node:test";
import {
  FULL_RESYNC_REPLY_REEVAL_SENT_DOC_LIMIT,
  planGmailPostInsertSideEffects,
} from "../../src/modules/integrations/queue";

test("gmail initial triage seed emits normal triage and exactly one reply re-eval set", () => {
  const plan = planGmailPostInsertSideEffects({
    jobKind: "gmail.ingest_recent",
    triageInsertedDocs: true,
    triageDocumentIds: ["doc_in_1"],
    sentDocumentIds: ["doc_sent_1", "doc_sent_2"],
    touchedThreadIds: ["thread_1"],
  });

  assert.equal(plan.triageReason, "ingest");
  assert.deepEqual(plan.triageDocumentIds, ["doc_in_1"]);
  assert.deepEqual(plan.reconcileThreadIds, ["thread_1"]);
  assert.deepEqual(plan.replyReevalSentDocumentIds, ["doc_sent_1", "doc_sent_2"]);
  assert.equal(plan.skippedReplyReevalSentDocs, 0);
});

test("gmail bulk ingest skips costly reply re-eval but still reconciles touched threads", () => {
  const plan = planGmailPostInsertSideEffects({
    jobKind: "gmail.ingest_recent",
    triageInsertedDocs: false,
    triageDocumentIds: ["doc_in_1"],
    sentDocumentIds: ["doc_sent_1"],
    touchedThreadIds: ["thread_1"],
  });

  assert.equal(plan.triageReason, null);
  assert.deepEqual(plan.triageDocumentIds, []);
  assert.deepEqual(plan.reconcileThreadIds, ["thread_1"]);
  assert.deepEqual(plan.replyReevalSentDocumentIds, []);
  assert.equal(plan.skippedReplyReevalSentDocs, 1);
});

test("gmail realtime poll emits webhook triage and reply re-eval", () => {
  const plan = planGmailPostInsertSideEffects({
    jobKind: "gmail.poll_recent",
    triageDocumentIds: ["doc_in_1"],
    sentDocumentIds: ["doc_sent_1"],
    touchedThreadIds: ["thread_1"],
  });

  assert.equal(plan.triageReason, "webhook");
  assert.deepEqual(plan.triageDocumentIds, ["doc_in_1"]);
  assert.deepEqual(plan.replyReevalSentDocumentIds, ["doc_sent_1"]);
  assert.equal(plan.skippedReplyReevalSentDocs, 0);
});

test("gmail history full-resync skips normal triage but runs bounded reply re-eval", () => {
  const sentDocumentIds = Array.from(
    { length: FULL_RESYNC_REPLY_REEVAL_SENT_DOC_LIMIT + 2 },
    (_, i) => `doc_sent_${i}`,
  );
  const plan = planGmailPostInsertSideEffects({
    jobKind: "gmail.poll_history",
    fullResync: true,
    triageDocumentIds: ["doc_in_1"],
    sentDocumentIds,
    touchedThreadIds: ["thread_1"],
  });

  assert.equal(plan.triageReason, null);
  assert.deepEqual(plan.triageDocumentIds, []);
  assert.deepEqual(plan.reconcileThreadIds, ["thread_1"]);
  assert.deepEqual(
    plan.replyReevalSentDocumentIds,
    sentDocumentIds.slice(0, FULL_RESYNC_REPLY_REEVAL_SENT_DOC_LIMIT),
  );
  assert.equal(plan.skippedReplyReevalSentDocs, 2);
});

test("gmail normal history catch-up emits ingest triage and unbounded reply re-eval", () => {
  const plan = planGmailPostInsertSideEffects({
    jobKind: "gmail.poll_history",
    fullResync: false,
    triageDocumentIds: ["doc_in_1"],
    sentDocumentIds: ["doc_sent_1", "doc_sent_2"],
    touchedThreadIds: ["thread_1"],
  });

  assert.equal(plan.triageReason, "ingest");
  assert.deepEqual(plan.triageDocumentIds, ["doc_in_1"]);
  assert.deepEqual(plan.replyReevalSentDocumentIds, ["doc_sent_1", "doc_sent_2"]);
  assert.equal(plan.skippedReplyReevalSentDocs, 0);
});
