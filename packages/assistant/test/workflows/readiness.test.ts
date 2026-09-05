import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import type {
  IntegrationAvailabilitySnapshot,
  ToolName,
  WorkflowRevisionDefinition,
} from "@alfred/contracts";

import { registerBuiltinTools } from "@alfred/assistant/tool-runtime/builtin-tools";
import { workflowToolCatalog, type WorkflowToolFacts } from "@alfred/assistant/tool-runtime";
import {
  canonicalizeWorkflowAccounts,
  resolveWorkflowCapabilities,
  resolveWorkflowApprovalDisplay,
  resolveWorkflowReadiness as resolveWorkflowReadinessBase,
} from "@alfred/assistant/automation/readiness";
import { runtimeReadinessDisposition } from "@alfred/assistant/automation/runtime-readiness";
import { validateWorkflowDefinition } from "@alfred/assistant/automation/revisions";

function resolveWorkflowReadiness(
  args: Omit<
    Parameters<typeof resolveWorkflowReadinessBase>[0],
    "gmailEventHealth" | "inboundTriggerHealth" | "toolCatalog"
  > & {
    gmailEventHealth?: Parameters<typeof resolveWorkflowReadinessBase>[0]["gmailEventHealth"];
  },
) {
  return resolveWorkflowReadinessBase({
    ...args,
    gmailEventHealth: args.gmailEventHealth ?? new Map(),
    inboundTriggerHealth: new Map(),
    toolCatalog: workflowToolCatalog(),
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
          installationId: null,
          accountLabel: "selected@example.com",
          metadata: { watch: { expiresAt: "2026-08-01T00:00:00.000Z" } },
        },
        {
          credentialId: "credential-2",
          accountId: "account-2",
          status: "active",
          scopes: new Set(["https://www.googleapis.com/auth/gmail.readonly"]),
          installationId: null,
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
  test("runtime defers provider health but blocks credential loss", () => {
    assert.equal(
      runtimeReadinessDisposition([
        { code: "provider_unhealthy", message: "Provider is unavailable.", field: "trigger" },
      ]),
      "deferred",
    );
    assert.equal(
      runtimeReadinessDisposition([
        { code: "needs_reauth", message: "Reconnect the account.", field: "capability" },
      ]),
      "blocked",
    );
  });
  test("the pure resolver derives an exact active envelope", () => {
    const result = resolveWorkflowCapabilities({
      definition: definition(),
      requested: [{ tool: "system.current_time" }],
      availability: unavailable,
      toolCatalog: workflowToolCatalog(),
      gmailEventHealth: new Map(),
      inboundTriggerHealth: new Map(),
    });
    assert.deepEqual(result.definition.allowedIntegrations, ["system"]);
    assert.deepEqual(result.definition.allowedTools, ["system.current_time"]);
    assert.equal(result.definition.requiredCapabilities[0]?.tool, "system.current_time");
    assert.deepEqual(result.missing, []);
  });

  test("the pure resolver preserves exact resource-access evidence", () => {
    const result = resolveWorkflowCapabilities({
      definition: definition(),
      requested: [{ tool: "system.current_time", resourceScope: { calendarId: "primary" } }],
      availability: unavailable,
      toolCatalog: workflowToolCatalog(),
      gmailEventHealth: new Map(),
      inboundTriggerHealth: new Map(),
      resourceAccessFacts: [
        {
          tool: "system.current_time",
          resourceScope: { calendarId: "primary" },
          granted: true,
        },
      ],
    });
    assert.deepEqual(result.missing, []);
  });

  test("the pure resolver includes the trigger source and gives no fake action for Slack", () => {
    const result = resolveWorkflowCapabilities({
      definition: definition({
        trigger: { kind: "event", source: "gmail", type: "message_received" },
      }),
      requested: [{ tool: "slack.send_message" }],
      availability: unavailable,
      toolCatalog: workflowToolCatalog(),
      gmailEventHealth: new Map(),
      inboundTriggerHealth: new Map(),
    });
    assert.deepEqual(result.definition.allowedIntegrations, ["gmail", "slack"]);
    assert.deepEqual(result.definition.allowedTools, []);
    assert.equal(result.missing[0]?.code, "no_tool_surface");
    assert.equal(result.missing[0]?.recoveryAction, undefined);
  });

  test("a catalog tool without a runtime implementation stays inside the envelope", () => {
    const result = resolveWorkflowCapabilities({
      definition: definition(),
      requested: [{ tool: "system.current_time" }],
      availability: unavailable,
      toolCatalog: new Map<ToolName, WorkflowToolFacts>(),
      gmailEventHealth: new Map(),
      inboundTriggerHealth: new Map(),
    });
    assert.deepEqual(result.definition.allowedTools, ["system.current_time"]);
    assert.deepEqual(result.definition.requiredCapabilities, [{ tool: "system.current_time" }]);
    assert.equal(result.missing[0]?.code, "no_tool_surface");
  });

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
    assert.deepEqual(problems[0]?.recoveryAction, {
      kind: "connect",
      integration: "gmail",
    });
  });

  test("a credential that needs reauthorization returns the selected account action", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        allowedIntegrations: ["gmail"],
        allowedTools: ["gmail.search"],
        requiredCapabilities: [{ tool: "gmail.search", accountRef: "account-1" }],
      }),
      availability: {
        integrations: new Map([["gmail", { health: "needs_reauth", accountLabel: null }]]),
        providers: new Map([
          [
            "google",
            [
              {
                credentialId: "credential-1",
                accountId: "account-1",
                status: "needs_reauth",
                scopes: new Set(["https://www.googleapis.com/auth/gmail.readonly"]),
                installationId: null,
                accountLabel: "selected@example.com",
                metadata: {},
              },
            ],
          ],
        ]),
        passthroughEnabled: new Map(),
      },
    });
    assert.equal(problems[0]?.code, "needs_reauth");
    assert.deepEqual(problems[0]?.recoveryAction, {
      kind: "reauthorize",
      integration: "gmail",
      accountRef: "account-1",
      acceptableScopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
    });
  });

  test("a Gmail write on a read-only account names the missing permission action", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        allowedIntegrations: ["gmail"],
        allowedTools: ["gmail.send_draft"],
        requiredCapabilities: [{ tool: "gmail.send_draft", accountRef: "account-1" }],
      }),
      availability: gmailAvailability,
    });
    assert.equal(problems[0]?.code, "missing_scope");
    assert.deepEqual(problems[0]?.recoveryAction, {
      kind: "reauthorize",
      integration: "gmail",
      accountRef: "account-1",
      acceptableScopes: ["https://www.googleapis.com/auth/gmail.send"],
    });
  });

  test("a disabled passthrough feature returns an enable action", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        allowedIntegrations: ["gmail"],
        allowedTools: ["gmail.request"],
        requiredCapabilities: [{ tool: "gmail.request" }],
      }),
      availability: {
        ...gmailAvailability,
        passthroughEnabled: new Map([["gmail", false]]),
      },
    });
    assert.equal(problems[0]?.code, "feature_disabled");
    assert.deepEqual(problems[0]?.recoveryAction, {
      kind: "enable_feature",
      integration: "gmail",
    });
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
      toolCatalog: workflowToolCatalog(),
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
      workflowToolCatalog(),
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

  test("an approved scope without an external grant fact is enforced at dispatch", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        requiredCapabilities: [
          { tool: "system.current_time", resourceScope: { calendarId: "primary" } },
        ],
      }),
      availability: unavailable,
    });
    assert.deepEqual(problems, []);
  });

  test("an explicit current resource denial blocks readiness", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        requiredCapabilities: [
          { tool: "system.current_time", resourceScope: { calendarId: "primary" } },
        ],
      }),
      availability: unavailable,
      resourceAccessFacts: [
        {
          tool: "system.current_time",
          resourceScope: { calendarId: "primary" },
          granted: false,
        },
      ],
    });
    assert.equal(problems[0]?.code, "resource_not_granted");
  });

  test("a supplied exact resource grant satisfies the resource boundary", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        requiredCapabilities: [
          { tool: "system.current_time", resourceScope: { calendarId: "primary" } },
        ],
      }),
      availability: unavailable,
      resourceAccessFacts: [
        {
          tool: "system.current_time",
          resourceScope: { calendarId: "primary" },
          granted: true,
        },
      ],
    });
    assert.deepEqual(problems, []);
  });

  test("connection recovery takes priority over a resource grant", () => {
    const problems = resolveWorkflowReadiness({
      definition: definition({
        allowedIntegrations: ["gmail"],
        allowedTools: ["gmail.search"],
        requiredCapabilities: [{ tool: "gmail.search", resourceScope: { labelId: "important" } }],
      }),
      availability: unavailable,
    });
    assert.equal(problems.length, 1);
    assert.equal(problems[0]?.code, "not_connected");
    assert.deepEqual(problems[0]?.recoveryAction, {
      kind: "connect",
      integration: "gmail",
    });
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
                  topic: "projects/example/topics/gmail",
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

  test("an expired Gmail watch asks for renewal even when sync is stale", () => {
    const selected = gmailAvailability.providers.get("google")?.[0];
    assert.ok(selected);
    const problems = resolveWorkflowReadiness({
      definition: definition({
        trigger: {
          kind: "event",
          source: "gmail",
          type: "message_received",
          accountRef: "account-1",
        },
      }),
      availability: {
        ...gmailAvailability,
        providers: new Map([
          [
            "google",
            [
              {
                ...selected,
                metadata: {
                  watch: {
                    topic: "projects/example/topics/gmail",
                    expiresAt: "2026-07-30T00:00:00.000Z",
                    baselineHistoryId: "123",
                    installedAt: "2026-07-29T00:00:00.000Z",
                  },
                },
              },
            ],
          ],
        ]),
      },
      gmailEventHealth: new Map([
        [
          "credential-1",
          {
            receiverConfigured: true,
            topicMatches: true,
            cursorReady: true,
            coverageGap: true,
            lastSyncAt: new Date("2026-07-30T00:00:00.000Z"),
          },
        ],
      ]),
      now: new Date("2026-07-31T00:10:00.000Z"),
    });
    assert.equal(problems.at(-1)?.code, "trigger_not_ready");
    assert.match(problems.at(-1)?.message ?? "", /renew its watch/);
  });

  test("a configured live watch reports delayed delivery as provider health", () => {
    const selected = gmailAvailability.providers.get("google")?.[0];
    assert.ok(selected);
    const problems = resolveWorkflowReadiness({
      definition: definition({
        trigger: {
          kind: "event",
          source: "gmail",
          type: "message_received",
          accountRef: "account-1",
        },
      }),
      availability: {
        ...gmailAvailability,
        providers: new Map([
          [
            "google",
            [
              {
                ...selected,
                metadata: {
                  watch: {
                    topic: "projects/example/topics/gmail",
                    expiresAt: "2026-08-01T00:00:00.000Z",
                    baselineHistoryId: "123",
                    installedAt: "2026-07-29T00:00:00.000Z",
                  },
                },
              },
            ],
          ],
        ]),
      },
      gmailEventHealth: new Map([
        [
          "credential-1",
          {
            receiverConfigured: true,
            topicMatches: true,
            cursorReady: true,
            coverageGap: true,
            lastSyncAt: new Date("2026-07-30T00:00:00.000Z"),
          },
        ],
      ]),
      now: new Date("2026-07-31T00:10:00.000Z"),
    });
    assert.equal(problems.at(-1)?.code, "provider_unhealthy");
  });

  test("server-side Gmail delivery configuration does not offer OAuth recovery", () => {
    const selected = gmailAvailability.providers.get("google")?.[0];
    assert.ok(selected);
    const problems = resolveWorkflowReadiness({
      definition: definition({
        trigger: {
          kind: "event",
          source: "gmail",
          type: "message_received",
          accountRef: "account-1",
        },
      }),
      availability: {
        ...gmailAvailability,
        providers: new Map([
          [
            "google",
            [
              {
                ...selected,
                metadata: {
                  watch: {
                    topic: "projects/example/topics/gmail",
                    expiresAt: "2026-08-01T00:00:00.000Z",
                    baselineHistoryId: "123",
                    installedAt: "2026-07-29T00:00:00.000Z",
                  },
                },
              },
            ],
          ],
        ]),
      },
      gmailEventHealth: new Map([
        [
          "credential-1",
          {
            receiverConfigured: false,
            topicMatches: false,
            cursorReady: true,
            coverageGap: false,
            lastSyncAt: new Date("2026-07-31T00:05:00.000Z"),
          },
        ],
      ]),
      now: new Date("2026-07-31T00:10:00.000Z"),
    });
    assert.equal(problems.at(-1)?.code, "provider_unhealthy");
    assert.equal(problems.at(-1)?.recoveryAction, undefined);
  });
});
