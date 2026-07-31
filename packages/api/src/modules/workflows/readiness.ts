import {
  getStringPath,
  integrationFromToolName,
  isLoadableIntegrationSlug,
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

function matchesAccountRef(row: ProviderAvailability, accountRef: string): boolean {
  const normalizedRef = accountRef.toLocaleLowerCase();
  return (
    row.accountId.toLocaleLowerCase() === normalizedRef ||
    row.accountLabel?.toLocaleLowerCase() === normalizedRef
  );
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
  now?: Date;
}): WorkflowReadinessProblem[] {
  const problems: WorkflowReadinessProblem[] = [];
  const allowed = new Set(args.definition.allowedIntegrations);

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
      hasThread: true,
    });
    if (!availability.available) {
      problems.push({
        code: availability.code,
        message: availability.reason,
        field: `${field}.tool`,
      });
      continue;
    }

    if (capability.accountRef) {
      const accountRef = capability.accountRef;
      const credential = tool.availability?.credential;
      const selectedRows = credential
        ? (args.availability.providers.get(credential.provider) ?? []).filter((row) =>
            matchesAccountRef(row, accountRef),
          )
        : [];
      const integration = integrationFromToolName(capability.tool);
      const aggregateAccount = isLoadableIntegrationSlug(integration)
        ? args.availability.integrations.get(integration)
        : undefined;
      const aggregateMatches =
        aggregateAccount?.accountLabel?.toLocaleLowerCase() === accountRef.toLocaleLowerCase();
      const hasSelectedAccount = credential ? selectedRows.length > 0 : aggregateMatches;

      if (!hasSelectedAccount) {
        problems.push({
          code: "choose_account",
          message: `Choose the connected account for '${capability.tool}' from the available account labels.`,
          field: `${field}.accountRef`,
        });
      } else if (selectedRows.length > 0) {
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
    const requestedAccounts = args.definition.requiredCapabilities.flatMap((capability) =>
      integrationFromToolName(capability.tool) === "gmail" && capability.accountRef
        ? [capability.accountRef]
        : [],
    );
    const hasReadyWatch = (row: ProviderAvailability) => {
      if (row.status !== "active" || !row.scopes.has(GMAIL_READONLY_SCOPE)) return false;
      const expiresAt = getStringPath(row.metadata, "watch.expiresAt");
      return typeof expiresAt === "string" && new Date(expiresAt).getTime() > now.getTime();
    };
    const readyWatch =
      requestedAccounts.length === 0
        ? gmailRows.some(hasReadyWatch)
        : requestedAccounts.every((accountRef) =>
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
