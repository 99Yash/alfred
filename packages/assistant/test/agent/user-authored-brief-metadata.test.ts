import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { userAuthoredBriefWorkflow } from "@alfred/assistant/execution/workflows/user-authored-brief";

const baseInput = {
  userId: "user-1",
  brief: "Report the current time.",
  trigger: { kind: "manual" as const },
  input: undefined,
};

// `createRun` parses metadata with the workflow's own schema before any hook runs.
const parseMetadata = (metadata: unknown) =>
  userAuthoredBriefWorkflow.metadataSchema.parse(metadata);

describe("user-authored brief metadata", () => {
  test("derives the initial capability envelope from valid revision metadata", () => {
    const state = userAuthoredBriefWorkflow.initialState({
      ...baseInput,
      metadata: parseMetadata({
        allowedIntegrations: ["system"],
        allowedTools: ["system.current_time"],
        requiredCapabilities: [{ tool: "system.current_time" }],
      }),
    });

    assert.deepEqual(state.allowedIntegrations, ["system"]);
    assert.deepEqual(state.allowedTools, ["system.current_time"]);
    assert.deepEqual(state.requiredCapabilities, [{ tool: "system.current_time" }]);
  });

  test("fails closed when one present capability field is malformed", () => {
    assert.throws(
      () =>
        parseMetadata({
          allowedIntegrations: ["system"],
          allowedTools: ["system.current_time"],
          requiredCapabilities: [{ tool: "not-a-registered-tool" }],
        }),
      /Invalid tool name/,
    );
  });
});
