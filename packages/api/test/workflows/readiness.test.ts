import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import type { WorkflowRevisionDefinition } from "@alfred/contracts";

import type { IntegrationAvailabilitySnapshot } from "../../src/modules/integrations/availability";
import { registerBuiltinTools } from "../../src/modules/tools";
import { resolveWorkflowReadiness } from "../../src/modules/workflows/readiness";

before(() => registerBuiltinTools());

const unavailable: IntegrationAvailabilitySnapshot = {
  integrations: new Map(),
  providers: new Map(),
  passthroughEnabled: new Map(),
};

const gmailAvailability: IntegrationAvailabilitySnapshot = {
  integrations: new Map([["gmail", { health: "active", accountLabel: "other@example.com" }]]),
  providers: new Map([
    [
      "google",
      [
        {
          accountId: "account-1",
          status: "active",
          scopes: new Set(["https://www.googleapis.com/auth/gmail.readonly"]),
          accountLabel: "selected@example.com",
          metadata: { watch: { expiresAt: "2026-08-01T00:00:00.000Z" } },
        },
        {
          accountId: "account-2",
          status: "active",
          scopes: new Set(["https://www.googleapis.com/auth/gmail.readonly"]),
          accountLabel: "other@example.com",
          metadata: { watch: { expiresAt: "2026-07-30T00:00:00.000Z" } },
        },
      ],
    ],
  ]),
  passthroughEnabled: new Map(),
};

function definition(
  overrides: Partial<WorkflowRevisionDefinition> = {},
): WorkflowRevisionDefinition {
  return {
    name: "Manual workflow",
    description: null,
    brief: "Report the current time.",
    trigger: { kind: "manual" },
    allowedIntegrations: ["system"],
    allowedTools: ["system.current_time"],
    requiredCapabilities: [{ tool: "system.current_time" }],
    ...overrides,
  };
}

describe("workflow readiness", () => {
  test("a local system capability is ready without integration credentials", () => {
    assert.deepEqual(
      resolveWorkflowReadiness({ definition: definition(), availability: unavailable }),
      [],
    );
  });

  test("a disconnected exact tool blocks activation", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        allowedIntegrations: ["gmail"],
        allowedTools: ["gmail.search"],
        requiredCapabilities: [{ tool: "gmail.search" }],
      }),
      availability: unavailable,
    });
    assert.equal(problems[0]?.code, "not_connected");
  });

  test("an exact account reference binds to the matching provider row", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        allowedIntegrations: ["gmail"],
        allowedTools: ["gmail.search"],
        requiredCapabilities: [{ tool: "gmail.search", accountRef: "account-1" }],
      }),
      availability: gmailAvailability,
    });
    assert.deepEqual(problems, []);
  });

  test("an unknown account reference fails closed", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        allowedIntegrations: ["gmail"],
        allowedTools: ["gmail.search"],
        requiredCapabilities: [{ tool: "gmail.search", accountRef: "missing@example.com" }],
      }),
      availability: gmailAvailability,
    });
    assert.equal(problems[0]?.code, "choose_account");
  });

  test("an unverifiable resource scope fails closed", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        requiredCapabilities: [
          { tool: "system.current_time", resourceScope: { calendarId: "primary" } },
        ],
      }),
      availability: unavailable,
    });
    assert.equal(problems[0]?.code, "resource_not_granted");
  });

  test("a Gmail event requires a live watch", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        trigger: { kind: "event", source: "gmail", type: "message_received" },
      }),
      availability: unavailable,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });
    assert.equal(problems.at(-1)?.code, "trigger_not_ready");
  });

  test("a Gmail event watch belongs to the selected account", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        trigger: { kind: "event", source: "gmail", type: "message_received" },
        allowedIntegrations: ["gmail"],
        allowedTools: ["gmail.search"],
        requiredCapabilities: [{ tool: "gmail.search", accountRef: "other@example.com" }],
      }),
      availability: gmailAvailability,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });
    assert.equal(problems.at(-1)?.code, "trigger_not_ready");
  });
});
