import {
  APPROVAL_CONTROL_LABELS,
  integrationFromToolName,
  isToolName,
  TOOL_NAMES,
  toMessage,
  toolTakesOverride,
  type LiveProviderSlug,
  type PolicyMode,
  type ToolName,
} from "@alfred/contracts";
import { AlertCircle, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { toolChipLabel } from "~/components/approvals/card-spec";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import {
  AppButton,
  AppCard,
  AppSegmented,
  AppSelect,
  type AppSegmentedItem,
  type AppSelectOption,
} from "~/components/ui/v2";
import { CachedSyncNotice } from "~/components/cached-sync-notice";
import { useState } from "react";
import { ServerToolRuleList } from "../server-tool-rules";
import { SectionHeading } from "./section-heading";

const MODE_ITEMS: ReadonlyArray<AppSegmentedItem<PolicyMode>> = [
  {
    value: "autonomy",
    label: APPROVAL_CONTROL_LABELS.integrationAuto,
    icon: <Zap size={13} aria-hidden />,
  },
  {
    value: "gated",
    label: APPROVAL_CONTROL_LABELS.integrationGated,
    icon: <ShieldCheck size={13} aria-hidden />,
  },
];

const RETRY_LEADING = <RefreshCw size={13} aria-hidden />;

/**
 * The mode control of one integration page. Only a live provider takes a mode (ADR-0130
 * amendment (c), `APPROVAL_MODE_SLUGS`), so the slug type carries that rule.
 */
export function ProviderPolicy({ slug, name }: { slug: LiveProviderSlug; name: string }) {
  const { policy, modeFor, setIntegrationMode, setToolMode, loading, error, retry } =
    useActionPolicy();

  // `gated` while loading, so the less-safe option never flashes.
  const mode: PolicyMode = modeFor(slug) ?? "gated";

  // Set here or from an approval card ("Always allow this action").
  const toolOverrides = Object.entries(policy?.integrationRules[slug]?.toolOverrides ?? {}).filter(
    (entry): entry is [ToolName, PolicyMode] => isToolName(entry[0]),
  );

  // An exception equal to the integration mode is dropped (`withToolOverride`), so a new one
  // always takes the other mode.
  const exceptionMode: PolicyMode = mode === "autonomy" ? "gated" : "autonomy";

  const exceptionOptions: ReadonlyArray<AppSelectOption> = TOOL_NAMES.filter(
    (toolName) =>
      integrationFromToolName(toolName) === slug &&
      toolTakesOverride(toolName) &&
      !toolOverrides.some(([excepted]) => excepted === toolName),
  ).map((toolName) => ({ value: toolName, label: toolChipLabel(toolName) }));

  // A failed write: the optimistic change rolls back, so say why.
  const [writeError, setWriteError] = useState<string | null>(null);

  const write = (pending: Promise<void>) => {
    setWriteError(null);
    pending.catch((cause: unknown) => setWriteError(toMessage(cause)));
  };

  // A failed pull keeps the cached row, so the panel shows only when there is no row.
  if (error && !policy) {
    return (
      <section className="app-card-in space-y-3" style={{ animationDelay: "150ms" }}>
        <SectionHeading>{APPROVAL_CONTROL_LABELS.approvalPolicy}</SectionHeading>
        <AppCard>
          <div
            className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
            role="alert"
          >
            <div className="flex min-w-0 gap-2.5">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-app-red-4" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium text-app-fg-4">Policy unavailable</p>
                <p className="mt-1 text-xs leading-5 text-app-fg-3">{error}</p>
              </div>
            </div>
            <AppButton
              size="sm"
              variant="ghost"
              leading={RETRY_LEADING}
              onClick={retry}
              className="shrink-0"
            >
              Retry
            </AppButton>
          </div>
        </AppCard>
      </section>
    );
  }

  return (
    <section className="app-card-in space-y-3" style={{ animationDelay: "150ms" }}>
      <SectionHeading>{APPROVAL_CONTROL_LABELS.approvalPolicy}</SectionHeading>

      {error ? <CachedSyncNotice subject="policy" error={error} retry={retry} /> : null}

      <AppCard className="space-y-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-app-fg-4">
              {mode === "autonomy"
                ? APPROVAL_CONTROL_LABELS.integrationAuto
                : APPROVAL_CONTROL_LABELS.integrationGated}
            </p>
            <p className="mt-1 text-xs leading-5 text-app-fg-3">
              {mode === "autonomy"
                ? `Alfred acts on ${name} without pausing for approval. Risky actions still ask.`
                : `Alfred asks before it changes anything on ${name}, and before a read that can show a secret, such as a key or a token.`}
            </p>
          </div>
          <AppSegmented<PolicyMode>
            label={`${name} approval policy`}
            value={mode}
            items={MODE_ITEMS}
            onValueChange={(next) => {
              if (loading || next === mode) return;
              void setIntegrationMode(slug, next);
            }}
            disabled={loading}
            className={loading ? "opacity-60" : undefined}
          />
        </div>
        <div className="space-y-2 border-t border-app-fg-a1/30 pt-3">
          <p className="text-xs font-medium text-app-fg-3">
            {APPROVAL_CONTROL_LABELS.actionExceptions}
          </p>
          {toolOverrides.length > 0 ? (
            <ul className="space-y-1.5">
              {toolOverrides.map(([toolName, toolMode]) => (
                <li key={toolName} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-app-fg-4">{toolChipLabel(toolName)}</p>
                    <p className="text-xs text-app-fg-3">
                      {toolMode === "autonomy" ? "Always allowed" : "Always asks first"}
                    </p>
                  </div>
                  <AppButton
                    size="sm"
                    variant="ghost"
                    disabled={loading}
                    onClick={() => write(setToolMode(toolName, null))}
                    className="shrink-0"
                  >
                    Reset
                  </AppButton>
                </li>
              ))}
            </ul>
          ) : null}
          {exceptionOptions.length > 0 ? (
            <AppSelect
              label={
                exceptionMode === "autonomy"
                  ? `Always allow one ${name} action`
                  : `Always ask first for one ${name} action`
              }
              placeholder="Choose an action"
              value={undefined}
              options={exceptionOptions}
              disabled={loading}
              onChange={(value) => {
                if (value !== undefined && isToolName(value)) {
                  write(setToolMode(value, exceptionMode));
                }
              }}
            />
          ) : null}
          {/* The rules on the tools of this integration's MCP server (ADR-0130 amendment (c)). */}
          <ServerToolRuleList scope={{ integration: slug }} />
          {writeError ? (
            <p className="text-xs text-app-red-4" role="alert">
              {writeError}
            </p>
          ) : null}
        </div>
      </AppCard>
    </section>
  );
}
