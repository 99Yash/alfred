import {
  GOOGLE_SCOPE,
  canonicalJson,
  holdsAnyScope,
  humanizeSlug,
  integrationFromToolName,
  isInboundEventSource,
  isIntegrationSlug,
  isToolName,
  toolLabel,
  type CredentialProvider,
  type IntegrationAvailabilitySnapshot,
  type ProviderAvailability,
  type ToolName,
  type WorkflowAccountDisplay,
  type WorkflowCapabilityDisplay,
  type ToolUnavailabilityCode,
  type WorkflowRecoveryAction,
  type WorkflowRequestedCapability,
  type WorkflowRequiredCapability,
  type InboundEventSource,
  type WorkflowRevisionDefinition,
} from "@alfred/contracts";
import { readGmailWatchState } from "@alfred/integrations/google";
import type { WorkflowToolCatalog, WorkflowToolFacts } from "@alfred/assistant/tool-runtime";
import type { InboundSubscriptionHealth } from "@alfred/assistant/connections/ingress";
import type { GmailEventHealth } from "./gmail-event-readiness";

type WorkflowReadinessProblemCode =
  | ToolUnavailabilityCode
  | "no_tool_surface"
  | "choose_account"
  | "resource_not_granted"
  | "trigger_not_ready"
  | "provider_unhealthy"
  /** An inbound webhook source has no healthy subscription (ADR-0097); a deferral, like `provider_unhealthy`. */
  | "trigger_degraded";

/** Per-source subscription health for the inbound sources, as `readInboundTriggerHealth` reads it. */
export type InboundTriggerHealthMap = ReadonlyMap<InboundEventSource, InboundSubscriptionHealth>;

export interface WorkflowReadinessProblem {
  code: WorkflowReadinessProblemCode;
  message: string;
  field: string;
  /** Omitted when no user action can truthfully make the capability runnable. */
  recoveryAction?: WorkflowRecoveryAction;
}

/** A caller-supplied verdict for one exact account and provider resource boundary. */
export interface WorkflowResourceAccessFact {
  tool: ToolName;
  accountRef?: string;
  resourceScope: NonNullable<WorkflowRequiredCapability["resourceScope"]>;
  granted: boolean;
  /** Supplied only when the owning provider boundary has an executable remedy. */
  recoveryAction?: WorkflowRecoveryAction;
}

export interface WorkflowCapabilityResolution<TDefinition extends WorkflowReadinessDefinition> {
  definition: TDefinition;
  missing: WorkflowReadinessProblem[];
}

type WorkflowReadinessDefinition = Pick<
  WorkflowRevisionDefinition,
  "trigger" | "allowedIntegrations" | "requiredCapabilities"
>;

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
  toolCatalog: WorkflowToolCatalog,
): ProviderAvailability[] {
  const credential = toolCatalog.get(capability.tool)?.availability?.credential;
  if (!credential) return [];
  return (availability.providers.get(credential.provider) ?? []).filter(
    (row) => row.status === "active" && holdsAnyScope(row.scopes, credential.anyOfScopes),
  );
}

/** Resolve display labels and unambiguous defaults to durable provider account ids. */
export function canonicalizeWorkflowAccounts<T extends WorkflowReadinessDefinition>(args: {
  definition: T;
  availability: IntegrationAvailabilitySnapshot;
  toolCatalog: WorkflowToolCatalog;
}): T {
  const capabilities = args.definition.requiredCapabilities.map((capability) => {
    const rows = eligibleRows(args.availability, capability, args.toolCatalog);
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
      (row) => row.status === "active" && row.scopes.has(GOOGLE_SCOPE.gmail.readonly),
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
  toolCatalog: WorkflowToolCatalog,
): WorkflowApprovalDisplay {
  const resolvedAccounts = new Map<string, WorkflowAccountDisplay>();
  const displayAccount = (provider: CredentialProvider, accountRef: string) => {
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
      const tool = toolCatalog.get(capability.tool);
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
  definition: WorkflowReadinessDefinition;
  availability: IntegrationAvailabilitySnapshot;
  requestedCapabilities?: readonly WorkflowRequestedCapability[];
  gmailEventHealth: ReadonlyMap<string, GmailEventHealth>;
  inboundTriggerHealth: InboundTriggerHealthMap;
  toolCatalog: WorkflowToolCatalog;
  resourceAccessFacts?: readonly WorkflowResourceAccessFact[];
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
    const tool = args.toolCatalog.get(capability.tool);
    if (!tool) {
      problems.push({
        code: "no_tool_surface",
        message: `Alfred cannot automate '${capability.tool}' because it has no registered tool surface.`,
        field: `${field}.tool`,
      });
      continue;
    }
    const availability = tool.evaluateAvailability({
      availability: args.availability,
      allowed,
      context: { caller: "boss", interaction: "background" },
    });
    if (!availability.available) {
      problems.push({
        code: availability.code,
        message: availability.reason,
        field: `${field}.tool`,
        ...recoveryForToolProblem(availability.code, tool, capability.accountRef),
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
          recoveryAction: { kind: "choose_account", integration: tool.integration },
        });
        continue;
      } else if (selectedRows.length === 1) {
        const activeRows = selectedRows.filter((row) => row.status === "active");
        if (activeRows.length === 0) {
          problems.push({
            code: "needs_reauth",
            message: `The selected account for '${capability.tool}' needs to be reconnected.`,
            field: `${field}.accountRef`,
            recoveryAction: {
              kind: "reauthorize",
              integration: tool.integration,
              accountRef: capability.accountRef,
              ...(credential.anyOfScopes.length > 0
                ? { acceptableScopes: [...credential.anyOfScopes] }
                : {}),
            },
          });
          continue;
        } else if (
          credential &&
          !activeRows.some((row) => holdsAnyScope(row.scopes, credential.anyOfScopes))
        ) {
          problems.push({
            code: "missing_scope",
            message: `The selected account for '${capability.tool}' is missing a required permission.`,
            field: `${field}.accountRef`,
            recoveryAction: {
              kind: "reauthorize",
              integration: tool.integration,
              accountRef: capability.accountRef,
              acceptableScopes: [...credential.anyOfScopes],
            },
          });
          continue;
        }
      }
    }

    if (capability.resourceScope && args.resourceAccessFacts) {
      const resourceFact = args.resourceAccessFacts?.find(
        (fact) =>
          fact.tool === capability.tool &&
          fact.accountRef === capability.accountRef &&
          canonicalJson(fact.resourceScope) === canonicalJson(capability.resourceScope),
      );
      if (!resourceFact?.granted) {
        problems.push({
          code: "resource_not_granted",
          message: resourceFact
            ? `The selected resource is not granted for '${capability.tool}'.`
            : `Alfred cannot verify the selected resource for '${capability.tool}'.`,
          field: `${field}.resourceScope`,
          ...(resourceFact?.recoveryAction ? { recoveryAction: resourceFact.recoveryAction } : {}),
        });
      }
    }
  }

  if (args.definition.trigger.kind === "event" && args.definition.trigger.source === "gmail") {
    const now = args.now ?? new Date();
    const gmailRows = args.availability.providers.get("google") ?? [];
    const hasReadyWatch = (row: ProviderAvailability) => {
      if (row.status !== "active" || !row.scopes.has(GOOGLE_SCOPE.gmail.readonly)) return false;
      const watch = readGmailWatchState(row.metadata);
      if (!watch) return false;
      const health = args.gmailEventHealth.get(row.credentialId);
      return Boolean(
        new Date(watch.expiresAt).getTime() > now.getTime() &&
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
      accountRef && selectedRows.length === 1 && selectedRows.some((row) => hasReadyWatch(row)),
    );
    if (!readyWatch) {
      const selectedRow = selectedRows[0];
      const selectedHealth = selectedRow
        ? args.gmailEventHealth.get(selectedRow.credentialId)
        : undefined;
      const selectedWatch = selectedRow ? readGmailWatchState(selectedRow.metadata) : null;
      const watchInstalled = Boolean(
        selectedRow?.status === "active" &&
        selectedRow.scopes.has(GOOGLE_SCOPE.gmail.readonly) &&
        selectedWatch &&
        new Date(selectedWatch.expiresAt).getTime() > now.getTime(),
      );
      const serverConfigurationBroken = Boolean(
        watchInstalled &&
        selectedHealth &&
        (!selectedHealth.receiverConfigured || !selectedHealth.topicMatches),
      );
      const providerUnhealthy = Boolean(
        serverConfigurationBroken ||
        (watchInstalled &&
          selectedHealth &&
          (selectedHealth.coverageGap ||
            !selectedHealth.cursorReady ||
            !selectedHealth.lastSyncAt ||
            (selectedHealth.lastSyncAt &&
              now.getTime() - selectedHealth.lastSyncAt.getTime() >
                GMAIL_EVENT_HEALTH_MAX_AGE_MS))),
      );
      const recoveryAction: WorkflowRecoveryAction | undefined = serverConfigurationBroken
        ? undefined
        : providerUnhealthy
          ? { kind: "retry" }
          : { kind: "connect", integration: "gmail" };
      problems.push({
        code: providerUnhealthy ? "provider_unhealthy" : "trigger_not_ready",
        message: providerUnhealthy
          ? "Gmail event delivery is unhealthy; retry after delivery coverage recovers."
          : "Gmail event delivery is not ready; reconnect Gmail or renew its watch.",
        field: "trigger",
        ...(recoveryAction ? { recoveryAction } : {}),
      });
    }
  }

  if (
    args.definition.trigger.kind === "event" &&
    isInboundEventSource(args.definition.trigger.source)
  ) {
    // An inbound source with no healthy subscription is degraded, never quiet:
    // the absence of deliveries must not read as "nothing happened" (ADR-0097).
    const source = args.definition.trigger.source;
    const health = args.inboundTriggerHealth.get(source) ?? {
      healthy: false,
      reason: "no subscription health signal",
      recovery: "none",
    };
    if (!health.healthy) {
      const recoveryAction: WorkflowRecoveryAction | undefined =
        health.recovery === "connect" && isIntegrationSlug(source)
          ? { kind: "connect", integration: source }
          : health.recovery === "retry"
            ? { kind: "retry" }
            : undefined;
      problems.push({
        code: "trigger_degraded",
        message: `${humanizeSlug(source)} event delivery is degraded: ${health.reason}.`,
        field: "trigger",
        ...(recoveryAction ? { recoveryAction } : {}),
      });
    }
  }

  return problems;
}

/**
 * Pure #557 capability resolver over a caller-supplied tool and availability
 * snapshot. It derives the exact execution envelope and delegates the final
 * runnable verdict to the same availability evaluator used by dispatch.
 */
export function resolveWorkflowCapabilities<TDefinition extends WorkflowRevisionDefinition>(args: {
  definition: TDefinition;
  requested: readonly WorkflowRequestedCapability[];
  availability: IntegrationAvailabilitySnapshot;
  toolCatalog: WorkflowToolCatalog;
  gmailEventHealth: ReadonlyMap<string, GmailEventHealth>;
  inboundTriggerHealth: InboundTriggerHealthMap;
  resourceAccessFacts?: readonly WorkflowResourceAccessFact[];
  now?: Date;
}): WorkflowCapabilityResolution<TDefinition> {
  const requiredCapabilities = args.requested.flatMap((requested) =>
    isToolName(requested.tool) ? [{ ...requested, tool: requested.tool }] : [],
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
  if (
    args.definition.trigger.kind === "event" &&
    isIntegrationSlug(args.definition.trigger.source)
  ) {
    integrationSet.add(args.definition.trigger.source);
  }
  const allowedIntegrations = [...integrationSet].sort();
  const definition = canonicalizeWorkflowAccounts({
    definition: {
      ...args.definition,
      allowedIntegrations,
      allowedTools,
      requiredCapabilities,
    },
    availability: args.availability,
    toolCatalog: args.toolCatalog,
  });
  const missing = resolveWorkflowReadiness({
    definition,
    availability: args.availability,
    requestedCapabilities: args.requested,
    gmailEventHealth: args.gmailEventHealth,
    inboundTriggerHealth: args.inboundTriggerHealth,
    toolCatalog: args.toolCatalog,
    ...(args.resourceAccessFacts ? { resourceAccessFacts: args.resourceAccessFacts } : {}),
    ...(args.now ? { now: args.now } : {}),
  });
  return {
    definition,
    missing,
  };
}

interface WorkflowApprovalDisplay {
  resolvedAccounts: WorkflowAccountDisplay[];
  resolvedCapabilities: WorkflowCapabilityDisplay[];
}

interface WorkflowRecovery {
  recoveryAction?: WorkflowRecoveryAction;
}

function recoveryForToolProblem(
  code: ToolUnavailabilityCode,
  tool: WorkflowToolFacts,
  accountRef: string | undefined,
): WorkflowRecovery {
  if (code === "not_connected") {
    return { recoveryAction: { kind: "connect", integration: tool.integration } };
  }
  if (code === "needs_reauth" || code === "missing_scope") {
    const acceptableScopes = tool.availability?.credential?.anyOfScopes;
    return {
      recoveryAction: {
        kind: "reauthorize",
        integration: tool.integration,
        ...(accountRef ? { accountRef } : {}),
        ...(acceptableScopes && acceptableScopes.length > 0
          ? { acceptableScopes: [...acceptableScopes] }
          : {}),
      },
    };
  }
  if (code === "feature_disabled") {
    return { recoveryAction: { kind: "enable_feature", integration: tool.integration } };
  }
  return {};
}
