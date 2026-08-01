import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import type { WorkflowRevisionDefinition } from "@alfred/contracts";

import type { IntegrationAvailabilitySnapshot } from "../../src/modules/integrations/availability";
import { registerBuiltinTools } from "../../src/modules/tools";
import {
  canonicalizeWorkflowAccounts,
  resolveWorkflowApprovalDisplay,
  resolveWorkflowReadiness as resolveWorkflowReadinessBase,
} from "../../src/modules/workflows/readiness";
import { validateWorkflowDefinition } from "../../src/modules/workflows/revisions";

function resolveWorkflowReadiness(
  args: Omit<Parameters<typeof resolveWorkflowReadinessBase>[0], "gmailEventHealth"> & {
    gmailEventHealth?: Parameters<typeof resolveWorkflowReadinessBase>[0]["gmailEventHealth"];
  },
) {
  return resolveWorkflowReadinessBase({
    ...args,
    gmailEventHealth: args.gmailEventHealth ?? new Map(),
  });
}

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
          credentialId: "credential-1",
          accountId: "account-1",
          status: "active",
          scopes: new Set(["https://www.googleapis.com/auth/gmail.readonly"]),
          accountLabel: "selected@example.com",
          metadata: { watch: { expiresAt: "2026-08-01T00:00:00.000Z" } },
        },
        {
          credentialId: "credential-2",
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
  test("activation rejects a tool with no matching capability", () => {
    const result = validateWorkflowDefinition(
      definition({
        allowedIntegrations: ["system"],
        allowedTools: ["system.current_time", "system.read_user_context"],
        requiredCapabilities: [{ tool: "system.current_time" }],
      }),
      { timezone: "UTC", requireActivatable: true },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(
      result.problems.some((problem) => problem.code === "tool_without_capability"),
      true,
    );
  });

  test("activation rejects more than one account binding for the same tool", () => {
    const candidate = definition({
      allowedIntegrations: ["gmail"],
      allowedTools: ["gmail.search"],
      requiredCapabilities: [
        { tool: "gmail.search", accountRef: "account-1" },
        { tool: "gmail.search", accountRef: "account-2" },
      ],
    });
    const validated = validateWorkflowDefinition(candidate, {
      timezone: "UTC",
      requireActivatable: true,
    });
    assert.equal(validated.ok, false);
    if (!validated.ok) {
      assert.equal(
        validated.problems.some((problem) => problem.code === "ambiguous_tool_capability"),
        true,
      );
    }
    assert.equal(
      resolveWorkflowReadiness({ definition: candidate, availability: gmailAvailability }).some(
        (problem) => problem.code === "choose_account",
      ),
      true,
    );
  });

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

  test("thread-only tools are refused for a background workflow", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        allowedTools: ["system.read_chat_history"],
        requiredCapabilities: [{ tool: "system.read_chat_history" }],
      }),
      availability: unavailable,
    });
    assert.equal(problems[0]?.code, "requires_thread");
  });

  test("an unsupported requested tool becomes a truthful blocker", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        allowedIntegrations: ["slack"],
        allowedTools: [],
        requiredCapabilities: [],
      }),
      availability: unavailable,
      requestedCapabilities: [{ tool: "slack.send_message" }],
    });
    assert.equal(problems[0]?.code, "no_tool_surface");
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

  test("an unambiguous account is canonicalized to its durable id", () => {
    const canonical = canonicalizeWorkflowAccounts({
      definition: definition({
        allowedIntegrations: ["gmail"],
        allowedTools: ["gmail.search"],
        requiredCapabilities: [{ tool: "gmail.search", accountRef: "selected@example.com" }],
      }),
      availability: gmailAvailability,
    });
    assert.equal(canonical.requiredCapabilities[0]?.accountRef, "account-1");
  });

  test("the approval display pairs durable account ids with user-facing labels", () => {
    const display = resolveWorkflowApprovalDisplay(
      definition({
        allowedIntegrations: ["gmail"],
        allowedTools: ["gmail.search"],
        requiredCapabilities: [{ tool: "gmail.search", accountRef: "account-1" }],
      }),
      gmailAvailability,
    );
    assert.deepEqual(display.resolvedAccounts, [
      {
        provider: "google",
        accountRef: "account-1",
        accountLabel: "selected@example.com",
      },
    ]);
    assert.deepEqual(display.resolvedCapabilities, [
      {
        tool: "gmail.search",
        title: "search Gmail",
        accountRef: "account-1",
        accountLabel: "selected@example.com",
      },
    ]);
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

  test("an unsupported resource scope stays blocked", () => {
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

  test("a Gmail event requires receiver, cursor, and recent-sync health", () => {
    const healthy: IntegrationAvailabilitySnapshot = {
      ...gmailAvailability,
      providers: new Map([
        [
          "google",
          [
            {
              credentialId: "credential-1",
              accountId: "account-1",
              status: "active",
              scopes: new Set(["https://www.googleapis.com/auth/gmail.readonly"]),
              accountLabel: "selected@example.com",
              metadata: {
                watch: {
                  expiresAt: "2026-08-01T00:00:00.000Z",
                  baselineHistoryId: "123",
                  installedAt: "2026-07-31T00:00:00.000Z",
                },
              },
            },
          ],
        ],
      ]),
    };
    const problems = resolveWorkflowReadiness({
      definition: definition({
        trigger: {
          kind: "event",
          source: "gmail",
          type: "message_received",
          accountRef: "account-1",
        },
      }),
      availability: healthy,
      gmailEventHealth: new Map([
        [
          "credential-1",
          {
            receiverConfigured: true,
            topicMatches: true,
            cursorReady: true,
            coverageGap: false,
            lastSyncAt: new Date("2026-07-31T00:05:00.000Z"),
          },
        ],
      ]),
      now: new Date("2026-07-31T00:10:00.000Z"),
    });
    assert.deepEqual(problems, []);
  });
});
