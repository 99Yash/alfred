import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  approvalExpiryJobId,
  approvalExpiryQueue,
  approvalNotificationQueue,
  removeApprovalExpiryJob,
  removeApprovalNotificationJob,
  scheduleApprovalExpiryJob,
  scheduleApprovalNotificationJob,
} from "@alfred/assistant/tool-runtime";
import {
  approvalExpiryWorker,
  approvalNotificationWorker,
  stagedAction,
} from "@alfred/assistant/execution";
import { approvalNotificationJobId } from "../../src/tool-runtime/approval-notification-queue";

/**
 * Approval queue names and job-id formats must not change: a delayed job in flight
 * at deploy would land on a queue no worker reads. Also checks the owner indexes
 * export the helpers. `smoke-expiry` covers `stagedAction(...).expire()` against a live DB.
 */
describe("approvals split — queue identity + owner-index reachability", () => {
  test("queue names are byte-identical to before the split", () => {
    assert.equal(approvalExpiryQueue.name, "staging-expire");
    assert.equal(approvalNotificationQueue.name, "staging-notify");
  });

  test("job-id formats are the dot-separated logical ids", () => {
    assert.equal(approvalExpiryJobId("abc"), "staging-expire.abc");
    assert.equal(approvalNotificationJobId("abc"), "staging-notify.abc");
  });

  test("scheduling surface is reachable from the tool-runtime index", () => {
    for (const fn of [
      scheduleApprovalExpiryJob,
      removeApprovalExpiryJob,
      approvalExpiryQueue.close,
      scheduleApprovalNotificationJob,
      removeApprovalNotificationJob,
      approvalNotificationQueue.close,
    ]) {
      assert.equal(typeof fn, "function");
    }
  });

  test("workers + expiry transition are reachable from the agent index", () => {
    for (const fn of [
      stagedAction,
      approvalExpiryWorker.start,
      approvalExpiryWorker.stop,
      approvalNotificationWorker.start,
      approvalNotificationWorker.stop,
    ]) {
      assert.equal(typeof fn, "function");
    }
  });
});
