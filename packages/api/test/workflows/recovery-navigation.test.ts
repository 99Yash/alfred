import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { workflowRecoveryNavigation } from "@alfred/assistant/automation/recovery-navigation";

describe("workflow recovery navigation", () => {
  test("builds a context-preserving Google OAuth target", () => {
    assert.deepEqual(
      workflowRecoveryNavigation({
        workflowId: "workflow/1",
        revisionId: "revision?1",
        readiness: [
          {
            code: "missing_scope",
            field: "requiredCapabilities.0.tool",
            message: "Reconnect Gmail.",
            recoveryAction: { kind: "reauthorize", integration: "gmail" },
          },
        ],
      }),
      {
        kind: "oauth",
        label: "Reconnect Gmail",
        path: "/api/integrations/google/connect?workflowId=workflow%2F1&revisionId=revision%3F1",
      },
    );
  });

  test("does not invent navigation for a recovery flow the product does not own", () => {
    assert.equal(
      workflowRecoveryNavigation({
        workflowId: "workflow-1",
        revisionId: "revision-1",
        readiness: [
          {
            code: "resource_not_granted",
            field: "requiredCapabilities.0.resourceScope",
            message: "Grant the resource.",
            recoveryAction: {
              kind: "grant_resource",
              integration: "github",
              resourceScope: { repository: "99Yash/alfred" },
            },
          },
        ],
      }),
      undefined,
    );
  });
});
