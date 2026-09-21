import {
  INTEGRATIONS,
  canonicalJson,
  eventDeliveryAccounts,
  holdsAnyScope,
  humanizeSlug,
  integrationFromToolName,
  isIntegrationSlug,
  isToolName,
  toolLabel,
  type CredentialProvider,
  type EventSource,
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
import type { EventDeliveryHealth } from "@alfred/assistant/connections/ingress";
import { eventDeliveryRows, type EventSourceHealthMap } from "@alfred/assistant/connections";

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
 * The mutable half of one readiness decision, read as one snapshot by
 * `readWorkflowReadinessContext`. The resolver takes the pair as one value so
 * the rows a trigger's account resolves against are the rows its health was
 * read for; two separately gathered halves could name different accounts.
 */
export interface WorkflowReadinessContext {
  availability: IntegrationAvailabilitySnapshot;
  eventSourceHealth: EventSourceHealthMap;
}

function matchesAccountRef(row: ProviderAvailability, accountRef: string): boolean {
  const normalizedRef = accountRef.toLocaleLowerCase();

  return (
    row.accountId.toLocaleLowerCase() === normalizedRef ||
    row.accountLabel?.toLocaleLowerCase() === normalizedRef
  );
}

/**
 * The one row `accountRef` names among `rows` (by durable id or by label), or
 * the one row there is when no ref is given. `undefined` when the ref names no
 * row or more than one: an ambiguous ref is never resolved by position.
 */
function selectAccountRow(
  rows: readonly ProviderAvailability[],
  accountRef: string | undefined,
): ProviderAvailability | undefined {
  const candidates = accountRef ? rows.filter((row) => matchesAccountRef(row, accountRef)) : rows;

  return candidates.length === 1 ? candidates[0] : undefined;
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
    const selected = selectAccountRow(rows, capability.accountRef);

    return selected ? { ...capability, accountRef: selected.accountId } : capability;
  });

  let trigger = args.definition.trigger;
  const accounts = trigger.kind === "event" ? eventDeliveryAccounts(trigger.source) : null;

  if (trigger.kind === "event" && accounts) {
    const selected = selectAccountRow(
      eventDeliveryRows(args.availability.providers, accounts),
      trigger.accountRef,
    );

    const capabilityAccounts = new Set(
      capabilities.flatMap((capability) =>
        integrationFromToolName(capability.tool) === accounts.integration && capability.accountRef
          ? [capability.accountRef]
          : [],
      ),
    );

    const accountRef =
      selected?.accountId ??
      (capabilityAccounts.size === 1 ? [...capabilityAccounts][0] : undefined);

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

  if (definition.trigger.kind === "event" && definition.trigger.accountRef) {
    const accounts = eventDeliveryAccounts(definition.trigger.source);

    if (accounts) displayAccount(accounts.provider, definition.trigger.accountRef);
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
 * readiness context. The context is gathered at the caller boundary so
 * authoring and approval can use the same pure verdict while approval chooses
 * a fresh read.
 */
export function resolveWorkflowReadiness(args: {
  definition: WorkflowReadinessDefinition;
  context: WorkflowReadinessContext;
  requestedCapabilities?: readonly WorkflowRequestedCapability[];
  toolCatalog: WorkflowToolCatalog;
  resourceAccessFacts?: readonly WorkflowResourceAccessFact[];
}): WorkflowReadinessProblem[] {
  const problems: WorkflowReadinessProblem[] = [];
  const { availability: snapshot } = args.context;
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
      availability: snapshot,
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
      // A capability with no ref is never resolved to the sole row here: that
      // is canonicalization's job, and a definition that reaches this point
      // without one has an account the user still has to choose.
      const selected = capability.accountRef
        ? selectAccountRow(snapshot.providers.get(credential.provider) ?? [], capability.accountRef)
        : undefined;

      if (!selected) {
        problems.push({
          code: "choose_account",
          message: `Choose the connected account for '${capability.tool}' from the available account labels.`,
          field: `${field}.accountRef`,
          recoveryAction: { kind: "choose_account", integration: tool.integration },
        });
        continue;
      }

      if (selected.status !== "active") {
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
      }

      if (!holdsAnyScope(selected.scopes, credential.anyOfScopes)) {
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
    const problem = triggerProblem(args.definition.trigger, args.context);

    if (problem) problems.push(problem);
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
  context: WorkflowReadinessContext;
  toolCatalog: WorkflowToolCatalog;
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
    availability: args.context.availability,
    toolCatalog: args.toolCatalog,
  });

  const missing = resolveWorkflowReadiness({
    definition,
    context: args.context,
    requestedCapabilities: args.requested,
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
 * The readiness problem one event trigger has, or `null` when its events will
 * arrive. A source-grain entry is the verdict. An account-grain entry first
 * settles which account the trigger delivers from, with the same rules the
 * capabilities use: no row that proves the integration connected is a
 * `connect` problem; a ref that names no row or more than one, or no ref at
 * all, is `choose_account`, not a delivery verdict. Only a selected row is
 * asked for its delivery health (#976).
 */
function triggerProblem(
  trigger: Extract<WorkflowReadinessDefinition["trigger"], { kind: "event" }>,
  context: WorkflowReadinessContext,
): WorkflowReadinessProblem | null {
  const entry = context.eventSourceHealth[trigger.source];

  if (entry.grain === "source") return deliveryProblem(trigger.source, entry.health);
  const { integration } = entry.accounts;
  const rows = eventDeliveryRows(context.availability.providers, entry.accounts);

  if (rows.length === 0) {
    return deliveryProblem(trigger.source, {
      healthy: false,
      // No row satisfies the connected rule, so this trigger has no account to
      // deliver from. The cause is not a claim about history — a revoked row
      // reaches here too — it is the claim an alert surface reads: readiness
      // must refuse the trigger either way, and the repair for the revoked row
      // is the integration's own reconnect nag, not a second card (ADR-0100).
      cause: "never_connected",
      reason: `no connected ${INTEGRATIONS[integration].displayName} account`,
      recovery: { kind: "connect", integration },
    });
  }

  const selected = trigger.accountRef ? selectAccountRow(rows, trigger.accountRef) : undefined;

  if (!selected) {
    return {
      code: "choose_account",
      message: `Choose the connected ${INTEGRATIONS[integration].displayName} account for the ${humanizeSlug(trigger.source)} trigger from the available account labels.`,
      field: "trigger",
      recoveryAction: { kind: "choose_account", integration },
    };
  }

  return deliveryProblem(trigger.source, entry.healthOf(selected));
}

/**
 * A source with no healthy delivery is degraded, never quiet: the absence of
 * events must not read as "nothing happened" (ADR-0097 item 5). The health
 * verdict names its own recovery, so readiness never guesses an integration
 * from the source slug. `connect` means the user must act, so the workflow
 * blocks; `retry` and `none` describe delivery that time or an operator
 * restores, so the run defers (#976).
 */
function deliveryProblem(
  source: EventSource,
  health: EventDeliveryHealth,
): WorkflowReadinessProblem | null {
  if (health.healthy) return null;
  const notReady = health.recovery.kind === "connect";

  const recoveryAction: WorkflowRecoveryAction | undefined =
    health.recovery.kind === "none" ? undefined : health.recovery;

  return {
    code: notReady ? "trigger_not_ready" : "trigger_degraded",
    message: `${humanizeSlug(source)} event delivery is ${notReady ? "not ready" : "degraded"}: ${health.reason}.`,
    field: "trigger",
    ...(recoveryAction ? { recoveryAction } : {}),
  };
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
