import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  APPROVAL_EXPIRY_QUEUE_NAME,
  APPROVAL_NOTIFICATION_QUEUE_NAME,
  approvalExpiryJobId,
  closeApprovalExpiryQueue,
  closeApprovalNotificationQueue,
  removeApprovalExpiryJob,
  removeApprovalNotificationJob,
  scheduleApprovalExpiryJob,
  scheduleApprovalNotificationJob,
} from "@alfred/assistant/tool-runtime";
import {
  stagedAction,
  startApprovalExpiryWorker,
  startApprovalNotificationWorker,
  stopApprovalExpiryWorker,
  stopApprovalNotificationWorker,
} from "@alfred/assistant/execution";
import { approvalNotificationJobId } from "../../src/tool-runtime/approval-notification-queue";

/**
 * Approval queue names and job-id formats must not change: a delayed job in flight
 * at deploy would land on a queue no worker reads. Also checks the owner indexes
 * export the helpers. `smoke-expiry` covers `stagedAction(...).expire()` against a live DB.
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
      stagedAction,
      startApprovalExpiryWorker,
      stopApprovalExpiryWorker,
      startApprovalNotificationWorker,
      stopApprovalNotificationWorker,
    ]) {
      assert.equal(typeof fn, "function");
    }
  });
});
