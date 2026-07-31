import {
  canonicalJson,
  getStringPath,
  humanizeSlug,
  integrationFromToolName,
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
import { getTool } from "../tools/registry";

export type WorkflowReadinessProblemCode =
  | ToolUnavailabilityCode
  | "no_tool_surface"
  | "choose_account"
  | "resource_not_granted"
  | "trigger_not_ready";

export interface WorkflowReadinessProblem {
  code: WorkflowReadinessProblemCode;
  message: string;
  field: string;
}

const GMAIL_EVENT_HEALTH_MAX_AGE_MS = 15 * 60_000;

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
): ProviderAvailability[] {
  const credential = getTool(capability.tool)?.availability?.credential;
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
}): T {
  const capabilities = args.definition.requiredCapabilities.map((capability) => {
    const rows = eligibleRows(args.availability, capability);
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
  now?: Date;
}): WorkflowReadinessProblem[] {
  const problems: WorkflowReadinessProblem[] = [];
  const allowed = new Set(args.definition.allowedIntegrations);
  const capabilityCountByTool = new Map<string, number>();

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
    const tool = getTool(capability.tool);
    if (!tool) {
      problems.push({
        code: "no_tool_surface",
        message: `Alfred cannot automate '${capability.tool}' because it has no registered tool surface.`,
        field: `${field}.tool`,
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

    if (capability.resourceScope) {
      problems.push({
        code: "resource_not_granted",
        message: `Resource-scoped access for '${capability.tool}' cannot be verified yet.`,
        field: `${field}.resourceScope`,
      });
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
      const health = row.gmailEventHealth;
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
    const readyWatch = Boolean(
      accountRef &&
      gmailRows.filter((row) => matchesAccountRef(row, accountRef)).length === 1 &&
      gmailRows.some((row) => matchesAccountRef(row, accountRef) && hasReadyWatch(row)),
    );
    if (!readyWatch) {
      problems.push({
        code: "trigger_not_ready",
        message: "Gmail event delivery is not ready; reconnect Gmail or renew its watch.",
        field: "trigger",
      });
    }
  }

  return problems;
}
