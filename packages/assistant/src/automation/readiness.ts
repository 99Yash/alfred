import {
  GOOGLE_SCOPE,
  canonicalJson,
  holdsAnyScope,
  humanizeSlug,
  integrationFromToolName,
  isIntegrationSlug,
  isToolName,
  toolLabel,
  type CredentialProvider,
  type EventDeliveryHealth,
  type EventSourceHealth,
  type EventSourceHealthMap,
  type IntegrationAvailabilitySnapshot,
  type ProviderAvailability,
  type ToolName,
  type WorkflowAccountDisplay,
  type WorkflowCapabilityDisplay,
  type ToolUnavailabilityCode,
  type WorkflowRecoveryAction,
  type PersistedWorkflowReadinessProblem,
  type WorkflowRequestedCapability,
  type WorkflowRequiredCapability,
  type WorkflowRevisionDefinition,
} from "@alfred/contracts";
import type { WorkflowToolCatalog, WorkflowToolFacts } from "@alfred/assistant/tool-runtime";

type WorkflowReadinessProblemCode =
  | ToolUnavailabilityCode
  | "no_tool_surface"
  | "choose_account"
  | "resource_not_granted"
  /** Event delivery needs the user to act (`connect` recovery); the workflow blocks (#976). */
  | "trigger_not_ready"
  /** Event delivery is broken in a way time or an operator restores (ADR-0097); the run defers. */
  | "trigger_degraded";

export interface WorkflowReadinessProblem extends PersistedWorkflowReadinessProblem {
  code: WorkflowReadinessProblemCode;
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

/**
 * The verdict for a source the health map does not hold. `readEventSourceHealth`
 * fills every `EventSource`, so this only fires for a partial map a caller built
 * by hand; it defers rather than blocks, because no one can act on it.
 */
const NO_DELIVERY_HEALTH_SIGNAL: EventDeliveryHealth = {
  healthy: false,
  reason: "no delivery health signal",
  recovery: { kind: "none" },
};

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
  eventSourceHealth: EventSourceHealthMap;
  toolCatalog: WorkflowToolCatalog;
  resourceAccessFacts?: readonly WorkflowResourceAccessFact[];
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

  if (args.definition.trigger.kind === "event") {
    // A source with no healthy delivery is degraded, never quiet: the absence
    // of events must not read as "nothing happened" (ADR-0097 item 5). The
    // health entry names its own recovery, so readiness never guesses an
    // integration from the source slug. `connect` means the user must act, so
    // the workflow blocks; `retry` and `none` describe delivery that time or an
    // operator restores, so the run defers (#976).
    const { source, accountRef } = args.definition.trigger;
    const health = triggerDeliveryHealth(
      args.eventSourceHealth.get(source),
      args.availability,
      accountRef,
    );
    if (!health.healthy) {
      const notReady = health.recovery.kind === "connect";
      const recoveryAction: WorkflowRecoveryAction | undefined =
        health.recovery.kind === "none" ? undefined : health.recovery;
      problems.push({
        code: notReady ? "trigger_not_ready" : "trigger_degraded",
        message: `${humanizeSlug(source)} event delivery is ${notReady ? "not ready" : "degraded"}: ${health.reason}.`,
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
  eventSourceHealth: EventSourceHealthMap;
  resourceAccessFacts?: readonly WorkflowResourceAccessFact[];
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
    eventSourceHealth: args.eventSourceHealth,
    toolCatalog: args.toolCatalog,
    ...(args.resourceAccessFacts ? { resourceAccessFacts: args.resourceAccessFacts } : {}),
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

/**
 * Pick the delivery verdict one event trigger reads from its source's entry. A
 * source-grain entry is the verdict. An account-grain entry resolves the
 * trigger's `accountRef` against the provider's rows the same way capability
 * accounts resolve, and falls back to `unselected` when the ref names no
 * account or more than one.
 */
function triggerDeliveryHealth(
  entry: EventSourceHealth | undefined,
  availability: IntegrationAvailabilitySnapshot,
  accountRef: string | undefined,
): EventDeliveryHealth {
  if (!entry) return NO_DELIVERY_HEALTH_SIGNAL;
  if (entry.grain === "source") return entry.health;
  if (!accountRef) return entry.unselected;
  const rows = (availability.providers.get(entry.provider) ?? []).filter((row) =>
    matchesAccountRef(row, accountRef),
  );
  const row = rows.length === 1 ? rows[0] : undefined;
  return (row && entry.accounts.get(row.accountId)) ?? entry.unselected;
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
