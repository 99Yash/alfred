import assert from "node:assert/strict";
import test from "node:test";
import {
  FULL_RESYNC_REPLY_REEVAL_THREAD_LIMIT,
  hasGmailPostInsertSideEffects,
  planGmailPostInsertSideEffects,
} from "../../src/modules/integrations/queue";
import {
  planGmailThreadReconcile,
  type ReconcileStoredGmailDoc,
} from "../../src/modules/triage/gmail-reconcile";

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
  assert.equal(plan.replyReevalThreadLimit, null);
  assert.equal(plan.skippedReplyReevalSentDocs, 0);
  assert.deepEqual(plan.protectedDocumentIds, ["doc_in_1", "doc_sent_1", "doc_sent_2"]);
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
  assert.equal(plan.replyReevalThreadLimit, null);
  assert.equal(plan.skippedReplyReevalSentDocs, 1);
  assert.deepEqual(plan.protectedDocumentIds, ["doc_in_1", "doc_sent_1"]);
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
  assert.equal(plan.replyReevalThreadLimit, null);
  assert.equal(plan.skippedReplyReevalSentDocs, 0);
  assert.deepEqual(plan.protectedDocumentIds, ["doc_in_1", "doc_sent_1"]);
});

test("gmail realtime duplicate sent row still runs reply re-eval side effects", () => {
  assert.equal(
    hasGmailPostInsertSideEffects({
      insertedDocumentIds: [],
      sentDocumentIds: ["doc_sent_existing"],
      touchedThreadIds: ["thread_1"],
    }),
    true,
  );

  const plan = planGmailPostInsertSideEffects({
    jobKind: "gmail.poll_recent",
    triageDocumentIds: [],
    sentDocumentIds: ["doc_sent_existing"],
    touchedThreadIds: ["thread_1"],
  });

  assert.equal(plan.triageReason, "webhook");
  assert.deepEqual(plan.triageDocumentIds, []);
  assert.deepEqual(plan.reconcileThreadIds, ["thread_1"]);
  assert.deepEqual(plan.replyReevalSentDocumentIds, ["doc_sent_existing"]);
  assert.deepEqual(plan.protectedDocumentIds, ["doc_sent_existing"]);
});

test("gmail side-effect gate stays closed for empty no-op polls", () => {
  assert.equal(
    hasGmailPostInsertSideEffects({
      insertedDocumentIds: [],
      sentDocumentIds: [],
      touchedThreadIds: [],
    }),
    false,
  );
});

test("gmail history full-resync skips normal triage but runs bounded reply re-eval", () => {
  const sentDocumentIds = Array.from(
    { length: FULL_RESYNC_REPLY_REEVAL_THREAD_LIMIT + 2 },
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
  assert.deepEqual(plan.replyReevalSentDocumentIds, sentDocumentIds);
  assert.equal(plan.replyReevalThreadLimit, FULL_RESYNC_REPLY_REEVAL_THREAD_LIMIT);
  assert.equal(plan.skippedReplyReevalSentDocs, 0);
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
  assert.equal(plan.replyReevalThreadLimit, null);
  assert.equal(plan.skippedReplyReevalSentDocs, 0);
});

test("gmail thread reconcile repoints dead triage pointer to newest live inbound, not sent", () => {
  const fetchedAt = new Date("2026-06-26T10:00:00Z");
  const plan = planGmailThreadReconcile({
    storedDocs: [
      doc("doc_dead_pointed", "msg_dead", "2026-06-26T09:59:00Z", false),
      doc("doc_live_sent", "msg_live_sent", "2026-06-26T09:58:00Z", true),
      doc("doc_live_inbound", "msg_live_inbound", "2026-06-26T09:57:00Z", false),
    ],
    liveSourceIds: new Set(["msg_live_sent", "msg_live_inbound"]),
    triageDocumentId: "doc_dead_pointed",
    liveFetchedAt: fetchedAt,
  });

  assert.equal(plan.repointDocumentId, "doc_live_inbound");
  assert.deepEqual(plan.deadDocumentIdsToDelete, ["doc_dead_pointed"]);
});

test("gmail thread reconcile keeps pointed dead doc when only live candidate is sent", () => {
  const fetchedAt = new Date("2026-06-26T10:00:00Z");
  const plan = planGmailThreadReconcile({
    storedDocs: [
      doc("doc_dead_pointed", "msg_dead_1", "2026-06-26T09:59:00Z", false),
      doc("doc_dead_other", "msg_dead_2", "2026-06-26T09:58:00Z", false),
      doc("doc_live_sent", "msg_live_sent", "2026-06-26T09:57:00Z", true),
    ],
    liveSourceIds: new Set(["msg_live_sent"]),
    triageDocumentId: "doc_dead_pointed",
    liveFetchedAt: fetchedAt,
  });

  assert.equal(plan.repointDocumentId, null);
  assert.deepEqual(plan.deadDocumentIdsToDelete, ["doc_dead_other"]);
});

test("gmail thread reconcile repoints a live sent triage pointer to newest live inbound", () => {
  const fetchedAt = new Date("2026-06-26T10:00:00Z");
  const plan = planGmailThreadReconcile({
    storedDocs: [
      doc("doc_live_sent_pointed", "msg_live_sent", "2026-06-26T09:59:00Z", true),
      doc("doc_live_inbound", "msg_live_inbound", "2026-06-26T09:58:00Z", false),
    ],
    liveSourceIds: new Set(["msg_live_sent", "msg_live_inbound"]),
    triageDocumentId: "doc_live_sent_pointed",
    liveFetchedAt: fetchedAt,
  });

  assert.equal(plan.repointDocumentId, "doc_live_inbound");
  assert.deepEqual(plan.deadDocumentIdsToDelete, []);
});

test("gmail thread reconcile does not delete rows inserted after live fetch started", () => {
  const fetchedAt = new Date("2026-06-26T10:00:00Z");
  const plan = planGmailThreadReconcile({
    storedDocs: [
      doc("doc_old_dead", "msg_old_dead", "2026-06-26T09:55:00Z", false),
      {
        ...doc("doc_new_unseen", "msg_new_unseen", "2026-06-26T10:00:01Z", false),
        ingestedAt: new Date("2026-06-26T10:00:01Z"),
      },
    ],
    liveSourceIds: new Set(),
    triageDocumentId: null,
    liveFetchedAt: fetchedAt,
  });

  assert.equal(plan.repointDocumentId, null);
  assert.deepEqual(plan.deadDocumentIdsToDelete, ["doc_old_dead"]);
});

test("gmail thread reconcile does not delete protected current-job rows", () => {
  const fetchedAt = new Date("2026-06-26T10:00:00Z");
  const plan = planGmailThreadReconcile({
    storedDocs: [doc("doc_protected_dead", "msg_dead", "2026-06-26T09:59:00Z", false)],
    liveSourceIds: new Set(),
    triageDocumentId: null,
    liveFetchedAt: fetchedAt,
    protectedDocumentIds: new Set(["doc_protected_dead"]),
  });

  assert.equal(plan.repointDocumentId, null);
  assert.deepEqual(plan.deadDocumentIdsToDelete, []);
});

function doc(
  id: string,
  sourceId: string,
  authoredAt: string,
  isSent: boolean,
): ReconcileStoredGmailDoc {
  return {
    id,
    sourceId,
    authoredAt: new Date(authoredAt),
    ingestedAt: new Date("2026-06-26T09:00:00Z"),
    isSent,
  };
}
