import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  APPROVAL_EXPIRY_QUEUE_NAME,
  APPROVAL_NOTIFICATION_QUEUE_NAME,
  approvalExpiryJobId,
  approvalNotificationJobId,
  closeApprovalExpiryQueue,
  closeApprovalNotificationQueue,
  removeApprovalExpiryJob,
  removeApprovalNotificationJob,
  scheduleApprovalExpiryJob,
  scheduleApprovalNotificationJob,
} from "@alfred/assistant/tool-runtime";
import {
  expireStaging,
  startApprovalExpiryWorker,
  startApprovalNotificationWorker,
  stopApprovalExpiryWorker,
  stopApprovalNotificationWorker,
} from "../../src/modules/agent";

/**
 * Seam guard for the approvals 3-way split (slice 06 / ADR-0034).
 *
 * The approval machinery dissolved from one `approvals` module into three
 * owners: the delayed-job SCHEDULING surface into `tool-runtime` (a sink), the
 * wake/notify WORKERS into `agent` (execution), and workflow-activation into
 * `workflows`. This test pins the two things a move must not silently break:
 *
 *   1. The BullMQ queue IDENTITIES — the queue-name string constants and the
 *      dot-separated job-id format. If a re-spelling slipped in, an in-flight
 *      delayed job at deploy would land on a queue no worker reads and a parked
 *      run would never be woken or notified.
 *   2. Public REACHABILITY through the new owner indexes — the scheduling
 *      helpers resolve from the tool-runtime index, the workers from the agent
 *      index. `expireStaging` needs a live DB, so its transition stays covered
 *      by the `smoke-expiry` exerciser; here we only assert it is reachable.
 */
describe("approvals split — queue identity + owner-index reachability", () => {
  test("queue-name constants are byte-identical to before the split", () => {
    assert.equal(APPROVAL_EXPIRY_QUEUE_NAME, "staging-expire");
    assert.equal(APPROVAL_NOTIFICATION_QUEUE_NAME, "staging-notify");
  });

  test("job-id formats are the dot-separated logical ids", () => {
    assert.equal(approvalExpiryJobId("abc"), "staging-expire.abc");
    assert.equal(approvalNotificationJobId("abc"), "staging-notify.abc");
  });

  test("scheduling surface is reachable from the tool-runtime index", () => {
    for (const fn of [
      scheduleApprovalExpiryJob,
      removeApprovalExpiryJob,
      closeApprovalExpiryQueue,
      scheduleApprovalNotificationJob,
      removeApprovalNotificationJob,
      closeApprovalNotificationQueue,
    ]) {
      assert.equal(typeof fn, "function");
    }
  });

  test("workers + expiry transition are reachable from the agent index", () => {
    for (const fn of [
      expireStaging,
      startApprovalExpiryWorker,
      stopApprovalExpiryWorker,
      startApprovalNotificationWorker,
      stopApprovalNotificationWorker,
    ]) {
      assert.equal(typeof fn, "function");
    }
  });
});
