import {
  canonicalJson,
  getStringPath,
  humanizeSlug,
  integrationFromToolName,
  isIntegrationSlug,
  isToolName,
  toolLabel,
  type WorkflowAccountDisplay,
  type WorkflowCapabilityDisplay,
  type WorkflowRequestedCapability,
  type WorkflowRequiredCapability,
  type WorkflowRevisionDefinition,
} from "@alfred/contracts";
import { GMAIL_READONLY_SCOPE } from "@alfred/integrations/google";
import {
  evaluateToolAvailability,
  type IntegrationAvailabilitySnapshot,
  type ProviderAvailability,
  type ToolUnavailabilityCode,
} from "../integrations/availability";
import { getTool, type RegisteredTool } from "../tools/registry";
import type { GmailEventHealth } from "./gmail-event-readiness";

export type WorkflowReadinessProblemCode =
  | ToolUnavailabilityCode
  | "no_tool_surface"
  | "choose_account"
  | "resource_not_granted"
  | "trigger_not_ready"
  | "provider_unhealthy";

export interface WorkflowReadinessProblem {
  code: WorkflowReadinessProblemCode;
  message: string;
  field: string;
  recovery?: WorkflowRecoveryAction;
}

export type WorkflowRecoveryAction =
  | { kind: "connect"; integration: string }
  | { kind: "reauthorize"; integration: string }
  | { kind: "choose_account" }
  | { kind: "grant_resource" }
  | { kind: "enable_feature"; integration: string }
  | { kind: "retry" };

export type ResolvedWorkflowCapability = WorkflowRequiredCapability;

export interface WorkflowCapabilityResolution {
  satisfied: boolean;
  resolved: ResolvedWorkflowCapability[];
  missing: WorkflowReadinessProblem[];
  allowedIntegrations: ReturnType<typeof integrationFromToolName>[];
  allowedTools: WorkflowRequiredCapability["tool"][];
}

const GMAIL_EVENT_HEALTH_MAX_AGE_MS = 15 * 60_000;

function recoveryForProblem(
  problem: WorkflowReadinessProblem,
  definition: WorkflowRevisionDefinition,
): WorkflowRecoveryAction | undefined {
  const capabilityIndex = /^requiredCapabilities\.(\d+)/.exec(problem.field)?.[1];
  const capability =
    capabilityIndex === undefined
      ? undefined
      : definition.requiredCapabilities[Number(capabilityIndex)];
  const integration = capability
    ? integrationFromToolName(capability.tool)
    : definition.trigger.kind === "event"
      ? definition.trigger.source
      : undefined;
  switch (problem.code) {
    case "not_connected":
      return integration ? { kind: "connect", integration } : undefined;
    case "needs_reauth":
    case "missing_scope":
      return integration ? { kind: "reauthorize", integration } : undefined;
    case "choose_account":
      return { kind: "choose_account" };
    case "resource_not_granted":
      return { kind: "grant_resource" };
    case "feature_disabled":
      return integration ? { kind: "enable_feature", integration } : undefined;
    case "trigger_not_ready":
    case "provider_unhealthy":
      return { kind: "retry" };
    default:
      // In particular, no_tool_surface has no action: an OAuth flow cannot
      // install an implementation that Alfred does not have.
      return undefined;
  }
}

function matchesAccountRef(row: ProviderAvailability, accountRef: string): boolean {
  const normalizedRef = accountRef.toLocaleLowerCase();
  return (
    row.accountId.toLocaleLowerCase() === normalizedRef ||
    row.accountLabel?.toLocaleLowerCase() === normalizedRef
  );
}

function eligibleRows(
  availability: IntegrationAvailabilitySnapshot,
  capability: WorkflowRequiredCapability,
  lookupTool: (name: WorkflowRequiredCapability["tool"]) => RegisteredTool | undefined = getTool,
): ProviderAvailability[] {
  const credential = lookupTool(capability.tool)?.availability?.credential;
  if (!credential) return [];
  return (availability.providers.get(credential.provider) ?? []).filter(
    (row) =>
      row.status === "active" &&
      (credential.anyOfScopes.length === 0 ||
        credential.anyOfScopes.some((scope) => row.scopes.has(scope))),
  );
}

/** Resolve display labels and unambiguous defaults to durable provider account ids. */
export function canonicalizeWorkflowAccounts<T extends WorkflowRevisionDefinition>(args: {
  definition: T;
  availability: IntegrationAvailabilitySnapshot;
  registeredTools?: readonly RegisteredTool[];
}): T {
  const suppliedTools = args.registeredTools
    ? new Map(args.registeredTools.map((tool) => [tool.name, tool]))
    : null;
  const lookupTool = (name: WorkflowRequiredCapability["tool"]) =>
    suppliedTools ? suppliedTools.get(name) : getTool(name);
  const capabilities = args.definition.requiredCapabilities.map((capability) => {
    const rows = eligibleRows(args.availability, capability, lookupTool);
    const capabilityAccountRef = capability.accountRef;
    const selected = capabilityAccountRef
      ? rows.filter((row) => matchesAccountRef(row, capabilityAccountRef))
      : rows;
    return selected.length === 1
      ? { ...capability, accountRef: selected[0]?.accountId }
      : capability;
  });

  let trigger = args.definition.trigger;
  if (trigger.kind === "event") {
    const gmailRows = (args.availability.providers.get("google") ?? []).filter(
      (row) => row.status === "active" && row.scopes.has(GMAIL_READONLY_SCOPE),
    );
    const triggerAccountRef = trigger.accountRef;
    const selected = triggerAccountRef
      ? gmailRows.filter((row) => matchesAccountRef(row, triggerAccountRef))
      : gmailRows;
    const capabilityAccounts = new Set(
      capabilities.flatMap((capability) =>
        integrationFromToolName(capability.tool) === "gmail" && capability.accountRef
          ? [capability.accountRef]
          : [],
      ),
    );
    const accountRef =
      selected.length === 1
        ? selected[0]?.accountId
        : capabilityAccounts.size === 1
          ? [...capabilityAccounts][0]
          : undefined;
    if (accountRef) trigger = { ...trigger, accountRef };
  }

  return {
    ...args.definition,
    trigger,
    requiredCapabilities: [...new Map(capabilities.map((c) => [canonicalJson(c), c])).values()],
  };
}

export function resolveWorkflowApprovalDisplay(
  definition: WorkflowRevisionDefinition,
  availability: IntegrationAvailabilitySnapshot,
): {
  resolvedAccounts: WorkflowAccountDisplay[];
  resolvedCapabilities: WorkflowCapabilityDisplay[];
} {
  const resolvedAccounts = new Map<string, WorkflowAccountDisplay>();
  const displayAccount = (provider: string, accountRef: string) => {
    const row = (availability.providers.get(provider) ?? []).find(
      (candidate) => candidate.accountId === accountRef,
    );
    const account = {
      provider,
      accountRef,
      accountLabel: row?.accountLabel ?? `${humanizeSlug(provider)} account`,
    };
    resolvedAccounts.set(`${provider}:${accountRef}`, account);
    return account;
  };

  const resolvedCapabilities = definition.requiredCapabilities
    .map((capability) => {
      const tool = getTool(capability.tool);
      const provider = tool?.availability?.credential?.provider;
      const account =
        provider && capability.accountRef
          ? displayAccount(provider, capability.accountRef)
          : undefined;
      return {
        tool: capability.tool,
        title: toolLabel(capability.tool)?.title ?? capability.tool,
        ...(capability.accountRef ? { accountRef: capability.accountRef } : {}),
        ...(account ? { accountLabel: account.accountLabel } : {}),
        ...(capability.resourceScope ? { resourceScope: capability.resourceScope } : {}),
      };
    })
    .sort(
      (a, b) =>
        a.tool.localeCompare(b.tool) || (a.accountRef ?? "").localeCompare(b.accountRef ?? ""),
    );

  if (
    definition.trigger.kind === "event" &&
    definition.trigger.source === "gmail" &&
    definition.trigger.accountRef
  ) {
    displayAccount("google", definition.trigger.accountRef);
  }

  return {
    resolvedAccounts: [...resolvedAccounts.values()].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.accountRef.localeCompare(b.accountRef),
    ),
    resolvedCapabilities,
  };
}

/**
 * Resolve whether one exact workflow definition can run against a supplied
 * availability snapshot. The snapshot is gathered at the caller boundary so
 * authoring and approval can use the same pure verdict while approval chooses
 * a fresh read.
 */
export function resolveWorkflowReadiness(args: {
  definition: WorkflowRevisionDefinition;
  availability: IntegrationAvailabilitySnapshot;
  requestedCapabilities?: readonly WorkflowRequestedCapability[];
  gmailEventHealth: ReadonlyMap<string, GmailEventHealth>;
  now?: Date;
  registeredTools?: readonly RegisteredTool[];
}): WorkflowReadinessProblem[] {
  const problems: WorkflowReadinessProblem[] = [];
  const allowed = new Set(args.definition.allowedIntegrations);
  const capabilityCountByTool = new Map<string, number>();
  const suppliedTools = args.registeredTools
    ? new Map(args.registeredTools.map((tool) => [tool.name, tool]))
    : null;
  const lookupTool = (name: WorkflowRequiredCapability["tool"]) =>
    suppliedTools ? suppliedTools.get(name) : getTool(name);

  for (const capability of args.definition.requiredCapabilities) {
    capabilityCountByTool.set(
      capability.tool,
      (capabilityCountByTool.get(capability.tool) ?? 0) + 1,
    );
  }
  for (const [tool, count] of capabilityCountByTool) {
    if (count === 1) continue;
    problems.push({
      code: "choose_account",
      message: `Choose one account and resource boundary for '${tool}'.`,
      field: "requiredCapabilities",
    });
  }

  for (const [index, capability] of (args.requestedCapabilities ?? []).entries()) {
    if (isToolName(capability.tool)) continue;
    problems.push({
      code: "no_tool_surface",
      message: `Alfred cannot automate '${capability.tool}' because it has no registered tool surface.`,
      field: `requestedCapabilities.${index}.tool`,
    });
  }

  for (const [index, capability] of args.definition.requiredCapabilities.entries()) {
    const field = `requiredCapabilities.${index}`;
    const tool = lookupTool(capability.tool);
    if (!tool) {
      problems.push({
        code: "no_tool_surface",
        message: `Alfred cannot automate '${capability.tool}' because it has no registered tool surface.`,
        field: `${field}.tool`,
      });
      continue;
    }
    if (capability.resourceScope) {
      problems.push({
        code: "resource_not_granted",
        message: `Alfred cannot yet verify the resource boundary for '${capability.tool}'.`,
        field: `${field}.resourceScope`,
      });
      continue;
    }

    const availability = evaluateToolAvailability(args.availability, tool, allowed, {
      caller: "boss",
      hasThread: false,
    });
    if (!availability.available) {
      problems.push({
        code: availability.code,
        message: availability.reason,
        field: `${field}.tool`,
      });
      continue;
    }

    const credential = tool.availability?.credential;
    if (credential) {
      const accountRef = capability.accountRef;
      const selectedRows = accountRef
        ? (args.availability.providers.get(credential.provider) ?? []).filter((row) =>
            matchesAccountRef(row, accountRef),
          )
        : [];
      if (selectedRows.length !== 1) {
        problems.push({
          code: "choose_account",
          message: `Choose the connected account for '${capability.tool}' from the available account labels.`,
          field: `${field}.accountRef`,
        });
      } else if (selectedRows.length === 1) {
        const activeRows = selectedRows.filter((row) => row.status === "active");
        if (activeRows.length === 0) {
          problems.push({
            code: "needs_reauth",
            message: `The selected account for '${capability.tool}' needs to be reconnected.`,
            field: `${field}.accountRef`,
          });
        } else if (
          credential &&
          credential.anyOfScopes.length > 0 &&
          !activeRows.some((row) => credential.anyOfScopes.some((scope) => row.scopes.has(scope)))
        ) {
          problems.push({
            code: "missing_scope",
            message: `The selected account for '${capability.tool}' is missing a required permission.`,
            field: `${field}.accountRef`,
          });
        }
      }
    }
  }

  if (args.definition.trigger.kind === "event") {
    const now = args.now ?? new Date();
    const gmailRows = args.availability.providers.get("google") ?? [];
    const hasReadyWatch = (row: ProviderAvailability) => {
      if (row.status !== "active" || !row.scopes.has(GMAIL_READONLY_SCOPE)) return false;
      const expiresAt = getStringPath(row.metadata, "watch", "expiresAt");
      const baseline = getStringPath(row.metadata, "watch", "baselineHistoryId");
      const installedAt = getStringPath(row.metadata, "watch", "installedAt");
      const health = args.gmailEventHealth.get(row.credentialId);
      return Boolean(
        expiresAt &&
        baseline &&
        installedAt &&
        new Date(expiresAt).getTime() > now.getTime() &&
        health?.receiverConfigured &&
        health.topicMatches &&
        health.cursorReady &&
        !health.coverageGap &&
        health.lastSyncAt &&
        now.getTime() - health.lastSyncAt.getTime() <= GMAIL_EVENT_HEALTH_MAX_AGE_MS,
      );
    };
    const accountRef = args.definition.trigger.accountRef;
    const selectedRows = accountRef
      ? gmailRows.filter((row) => matchesAccountRef(row, accountRef))
      : [];
    const readyWatch = Boolean(
      accountRef &&
      selectedRows.length === 1 &&
      selectedRows.some((row) => hasReadyWatch(row)),
    );
    if (!readyWatch) {
      const selectedHealth = selectedRows[0]
        ? args.gmailEventHealth.get(selectedRows[0].credentialId)
        : undefined;
      const providerUnhealthy = Boolean(
        selectedHealth &&
          (selectedHealth.coverageGap ||
            (selectedHealth.lastSyncAt &&
              now.getTime() - selectedHealth.lastSyncAt.getTime() >
                GMAIL_EVENT_HEALTH_MAX_AGE_MS)),
      );
      problems.push({
        code: providerUnhealthy ? "provider_unhealthy" : "trigger_not_ready",
        message: providerUnhealthy
          ? "Gmail event delivery is unhealthy; retry after delivery coverage recovers."
          : "Gmail event delivery is not ready; reconnect Gmail or renew its watch.",
        field: "trigger",
      });
    }
  }

  return problems.map((problem) => {
    const recovery = recoveryForProblem(problem, args.definition);
    return recovery ? { ...problem, recovery } : problem;
  });
}

/**
 * Pure #557 capability resolver over a caller-supplied tool and availability
 * snapshot. It derives the exact execution envelope and delegates the final
 * runnable verdict to the same availability evaluator used by dispatch.
 */
export function resolveWorkflowCapabilities(args: {
  requested: readonly WorkflowRequestedCapability[];
  trigger: WorkflowRevisionDefinition["trigger"];
  availability: IntegrationAvailabilitySnapshot;
  registeredTools: readonly RegisteredTool[];
  gmailEventHealth?: ReadonlyMap<string, GmailEventHealth>;
  now?: Date;
}): WorkflowCapabilityResolution {
  const toolByName = new Map(args.registeredTools.map((tool) => [tool.name, tool]));
  const requiredCapabilities = args.requested.flatMap((requested) =>
    isToolName(requested.tool) && toolByName.has(requested.tool)
      ? [{ ...requested, tool: requested.tool }]
      : [],
  );
  const allowedTools = [...new Set(requiredCapabilities.map((capability) => capability.tool))];
  const integrationSet = new Set<ReturnType<typeof integrationFromToolName>>(
    allowedTools.map((tool) => integrationFromToolName(tool)),
  );
  for (const requested of args.requested) {
    const separator = requested.tool.indexOf(".");
    const prefix = separator === -1 ? requested.tool : requested.tool.slice(0, separator);
    if (isIntegrationSlug(prefix)) integrationSet.add(prefix);
  }
  if (args.trigger.kind === "event" && isIntegrationSlug(args.trigger.source)) {
    integrationSet.add(args.trigger.source);
  }
  const allowedIntegrations = [...integrationSet].sort();
  const definition = canonicalizeWorkflowAccounts({
    definition: {
    name: "Capability resolution",
    description: null,
    brief: "Resolve the supplied workflow capability snapshot.",
    trigger: args.trigger,
    allowedIntegrations,
    allowedTools,
    requiredCapabilities,
    },
    availability: args.availability,
    registeredTools: args.registeredTools,
  });
  const missing = resolveWorkflowReadiness({
    definition,
    availability: args.availability,
    requestedCapabilities: args.requested,
    gmailEventHealth: args.gmailEventHealth ?? new Map(),
    ...(args.now ? { now: args.now } : {}),
    registeredTools: args.registeredTools,
  });
  const resolved = definition.requiredCapabilities.flatMap((requested, index) => {
    const tool = toolByName.get(requested.tool);
    const fieldPrefix = `requiredCapabilities.${index}`;
    return tool && !missing.some((problem) => problem.field.startsWith(fieldPrefix))
      ? [requested]
      : [];
  });
  return {
    satisfied: missing.length === 0 && allowedTools.length > 0,
    resolved,
    missing,
    allowedIntegrations,
    allowedTools,
  };
}
