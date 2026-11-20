import {
  APPROVAL_CONTROL_LABELS,
  isIntegrationSlug,
  toMessage,
  type IntegrationSlug,
  type IntegrationRules,
  type ServerToolRule,
} from "@alfred/contracts";
import { useState } from "react";
import { AppButton } from "~/components/ui/v2";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";

/** One stored rule on a server tool (ADR-0130 amendment (c)), as a list shows it. */
interface ServerToolRuleEntry {
  integration: IntegrationSlug;
  connectionId: string;
  remoteName: string;
  rule: ServerToolRule;
}

/** Every stored rule on a server tool, at any descriptor hash. */
function serverToolRuleEntries(rules: IntegrationRules): ServerToolRuleEntry[] {
  return Object.entries(rules).flatMap(([integration, rule]) =>
    isIntegrationSlug(integration)
      ? Object.entries(rule.serverToolOverrides ?? {}).flatMap(([connectionId, byTool]) =>
          Object.entries(byTool).map(([remoteName, toolRule]) => ({
            integration,
            connectionId,
            remoteName,
            rule: toolRule,
          })),
        )
      : [],
  );
}

/**
 * The rules on the tools of an MCP server, each with Reset. The integration page lists the rules
 * of its integration, and "View tools" lists the rules of one connection. So a rule on a tool that
 * left the catalog can still be removed. A rule binds to one version of the tool, and this list
 * does not know the current version, so the line says that a changed tool asks again.
 */
export function ServerToolRuleList({
  scope,
}: {
  scope: { integration: IntegrationSlug } | { connectionId: string };
}) {
  const { policy, setServerToolMode, loading } = useActionPolicy();
  const [error, setError] = useState<string | null>(null);

  if (policy === null) return null;

  const entries = serverToolRuleEntries(policy.integrationRules).filter((entry) =>
    "integration" in scope
      ? entry.integration === scope.integration
      : entry.connectionId === scope.connectionId,
  );

  if (entries.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {"connectionId" in scope ? (
        <p className="text-xs font-medium text-app-fg-3">
          {APPROVAL_CONTROL_LABELS.actionExceptions}
        </p>
      ) : null}
      <ul className="space-y-1.5">
        {entries.map(({ integration, connectionId, remoteName, rule }) => (
          <li
            key={`${connectionId}:${remoteName}`}
            className="flex items-center justify-between gap-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-app-fg-4">{remoteName}</p>
              <p className="text-xs text-app-fg-3">
                {rule.mode === "autonomy" ? "Always allowed" : "Always asks first"} · until the
                server changes this tool
              </p>
            </div>
            <AppButton
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => {
                setError(null);
                setServerToolMode(
                  integration,
                  { connectionId, remoteName, descriptorHash: rule.descriptorHash },
                  null,
                ).catch((cause: unknown) => setError(toMessage(cause)));
              }}
              className="shrink-0"
            >
              Reset
            </AppButton>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="text-xs text-app-red-4" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
