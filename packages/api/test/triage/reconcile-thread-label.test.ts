import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { HttpError } from "@alfred/contracts";
import { reconcileThreadLabel, type ReconcileThreadLabelDeps } from "../../src/modules/triage/tags";
import type { TriageRow, TriageDocumentContext } from "../../src/modules/triage/store";

// ---------------------------------------------------------------------------
// Fixtures — #277: the relabel path wrote the triage label to the message id
// stored on `documents.source_id`, which Gmail reassigns/collapses when a sent
// copy merges into a thread. A dead id 404s the modify; pre-fix the label
// silently never landed and `applied_label_id` stayed NULL. These tests drive
// `reconcileThreadLabel` through its injected collaborators so no live Gmail
// account or DB is needed.
// ---------------------------------------------------------------------------

const USER = "user_1";
const THREAD = "thread_1";

function triageRow(overrides: Partial<TriageRow> = {}): TriageRow {
  return { documentId: "doc_dead", category: "fyi", ...overrides } as TriageRow;
}

function docContext(documentId: string, sourceId: string): TriageDocumentContext {
  return {
    document: {
      id: documentId,
      userId: USER,
      sourceId,
      sourceThreadId: THREAD,
      accountId: "acct_1",
      title: null,
      content: "",
      authoredAt: null,
      metadata: {},
    },
    credentialId: "cred_1",
    persona: null,
    identity: { name: null, email: null },
  };
}

function gmail404(messageId: string): HttpError {
  return new HttpError({
    provider: "gmail",
    status: 404,
    url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    body: '{ "message": "Requested entity was not found." }',
    method: "POST",
  });
}

interface Recorder {
  applyCalls: string[];
  setAppliedLabelCalls: Array<{ documentId?: string; appliedLabelId: string }>;
  setReconciledCalls: Array<{ documentId: string; appliedLabelId: string }>;
}

/**
 * Wire injectable deps over a per-message `applyTriageLabel` behaviour and a
 * `documentId -> sourceId` map for `loadTriageContext`. `liveDoc` is what the
 * re-resolution step (`findNewestLiveInbound`) returns; null means "no live
 * inbound message in the thread".
 */
function makeDeps(opts: {
  row: TriageRow | null;
  docs: Record<string, string>; // documentId -> Gmail message id
  apply: (messageId: string) => { appliedLabelId: string };
  liveDoc: string | null;
}): { deps: Partial<ReconcileThreadLabelDeps>; rec: Recorder } {
  const rec: Recorder = { applyCalls: [], setAppliedLabelCalls: [], setReconciledCalls: [] };
  const deps: Partial<ReconcileThreadLabelDeps> = {
    // These tests exercise the label-write path, so force the #278 gate on —
    // the real default is production-only and `NODE_ENV=test` would otherwise
    // short-circuit every case to `writes-disabled`.
    mailboxWritesEnabled: () => true,
    // The reconcile callback ignores the tx arg, so a dummy satisfies the type.
    withThreadLock: ((_u, _t, fn) =>
      fn(undefined as never)) as ReconcileThreadLabelDeps["withThreadLock"],
    getTriage: async () => opts.row,
    loadTriageContext: async (documentId: string) => {
      const sourceId = opts.docs[documentId];
      return sourceId ? docContext(documentId, sourceId) : null;
    },
    findThreadSiblings: async () => [],
    applyTriageLabel: async ({ messageId }) => {
      rec.applyCalls.push(messageId);
      const result = opts.apply(messageId);
      return { appliedLabelId: result.appliedLabelId, removedLabelIds: [], strippedSiblings: [] };
    },
    findNewestLiveInbound: async () =>
      opts.liveDoc ? [{ threadId: THREAD, documentId: opts.liveDoc }] : [],
    setAppliedLabelId: async (_u, _t, appliedLabelId) => {
      rec.setAppliedLabelCalls.push({ appliedLabelId });
    },
    setReconciledTarget: async (_u, _t, documentId, appliedLabelId) => {
      rec.setReconciledCalls.push({ documentId, appliedLabelId });
    },
  };
  return { deps, rec };
}

describe("reconcileThreadLabel — stale Gmail message id (#277)", () => {
  test("a triage row pointing at a dead message id re-resolves and labels a live message", async () => {
    const { deps, rec } = makeDeps({
      row: triageRow({ documentId: "doc_dead" }),
      docs: { doc_dead: "msg_dead", doc_live: "msg_live" },
      apply: (messageId) => {
        if (messageId === "msg_dead") throw gmail404("msg_dead");
        return { appliedLabelId: "label_fyi" };
      },
      liveDoc: "doc_live",
    });

    const result = await reconcileThreadLabel({ userId: USER, sourceThreadId: THREAD }, deps);

    assert.equal(result.applied, true);
    assert.ok(result.applied);
    assert.equal(result.appliedLabelId, "label_fyi");
    // document_id repointed to the message that was actually labeled.
    assert.equal(result.targetDocId, "doc_live");
    // It tried the dead id first, then the re-resolved live id.
    assert.deepEqual(rec.applyCalls, ["msg_dead", "msg_live"]);
    // Persisted via the combined repoint write, NOT the label-only write.
    assert.deepEqual(rec.setReconciledCalls, [
      { documentId: "doc_live", appliedLabelId: "label_fyi" },
    ]);
    assert.deepEqual(rec.setAppliedLabelCalls, []);
  });

  test("a dead message id with no live inbound fallback surfaces target-unresolvable (not silent NULL)", async () => {
    const { deps, rec } = makeDeps({
      row: triageRow({ documentId: "doc_dead" }),
      docs: { doc_dead: "msg_dead" },
      apply: () => {
        throw gmail404("msg_dead");
      },
      liveDoc: null,
    });

    const result = await reconcileThreadLabel({ userId: USER, sourceThreadId: THREAD }, deps);

    assert.equal(result.applied, false);
    assert.ok(!result.applied);
    assert.equal(result.reason, "target-unresolvable");
    assert.equal(result.category, "fyi");
    // Nothing persisted — the worker logs the non-applied reason as the signal.
    assert.deepEqual(rec.setReconciledCalls, []);
    assert.deepEqual(rec.setAppliedLabelCalls, []);
  });

  test("a 404 whose only live fallback is the same dead doc does not loop — target-unresolvable", async () => {
    const { deps } = makeDeps({
      row: triageRow({ documentId: "doc_dead" }),
      docs: { doc_dead: "msg_dead" },
      apply: () => {
        throw gmail404("msg_dead");
      },
      liveDoc: "doc_dead", // re-resolution points back at the doc that just 404'd
    });

    const result = await reconcileThreadLabel({ userId: USER, sourceThreadId: THREAD }, deps);

    assert.equal(result.applied, false);
    assert.ok(!result.applied);
    assert.equal(result.reason, "target-unresolvable");
  });

  test("the happy path (live target) persists via the label-only write, no repoint", async () => {
    const { deps, rec } = makeDeps({
      row: triageRow({ documentId: "doc_live" }),
      docs: { doc_live: "msg_live" },
      apply: () => ({ appliedLabelId: "label_fyi" }),
      liveDoc: "doc_live",
    });

    const result = await reconcileThreadLabel({ userId: USER, sourceThreadId: THREAD }, deps);

    assert.equal(result.applied, true);
    assert.ok(result.applied);
    assert.equal(result.targetDocId, "doc_live");
    assert.deepEqual(rec.applyCalls, ["msg_live"]);
    assert.deepEqual(rec.setAppliedLabelCalls, [{ appliedLabelId: "label_fyi" }]);
    assert.deepEqual(rec.setReconciledCalls, []);
  });

  test("a non-404 error is not swallowed — it bubbles to the job", async () => {
    const { deps } = makeDeps({
      row: triageRow({ documentId: "doc_live" }),
      docs: { doc_live: "msg_live" },
      apply: () => {
        throw new HttpError({
          provider: "gmail",
          status: 500,
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg_live/modify",
          body: "boom",
          method: "POST",
        });
      },
      liveDoc: "doc_live",
    });

    await assert.rejects(
      () => reconcileThreadLabel({ userId: USER, sourceThreadId: THREAD }, deps),
      /500/,
    );
  });
});

describe("reconcileThreadLabel — non-prod mailbox-write gate (#278)", () => {
  test("when mailbox writes are disabled it makes zero Gmail calls and reports writes-disabled", async () => {
    const { deps, rec } = makeDeps({
      row: triageRow({ documentId: "doc_live", category: "urgent" }),
      docs: { doc_live: "msg_live" },
      apply: () => ({ appliedLabelId: "label_urgent" }),
      liveDoc: "doc_live",
    });
    // Flip the gate off — dev/test sharing the real mailbox with prod.
    deps.mailboxWritesEnabled = () => false;

    const result = await reconcileThreadLabel({ userId: USER, sourceThreadId: THREAD }, deps);

    assert.equal(result.applied, false);
    assert.ok(!result.applied);
    assert.equal(result.reason, "writes-disabled");
    // The category is still reported (for logging) from the canonical row...
    assert.equal(result.category, "urgent");
    // ...but NOTHING touched Gmail or persisted an applied label.
    assert.deepEqual(rec.applyCalls, []);
    assert.deepEqual(rec.setAppliedLabelCalls, []);
    assert.deepEqual(rec.setReconciledCalls, []);
  });
});
