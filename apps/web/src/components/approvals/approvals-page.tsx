import { humanizeSlug, type ToolRiskTier } from "@alfred/contracts";
import type { SyncedActionStaging } from "@alfred/sync";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ClipboardCheck, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppButton, AppCard, AppPill } from "~/components/ui/v2";
import { client } from "~/lib/eden";
import { IntegrationGlyph } from "~/lib/integration-icons";
import { useActionStagings } from "~/lib/replicache/use-action-stagings";
import { cn } from "~/lib/utils";
import { ApprovalCard, type ApprovalDecision } from "./approval-card";
import { brandForIntegration } from "./tool-icon";

/** How many cards to render before "Show more" — windowing over the bounded
 * (24h-expiring) synced queue, not server pagination (ADR-0034 amendment). */
const WINDOW = 20;

const RISK_LABEL: Record<ToolRiskTier, string> = {
  high: "high",
  medium: "medium",
  low: "low",
  no_risk: "no risk",
};

const RISK_DOT: Record<ToolRiskTier, string> = {
  high: "bg-app-red-4",
  medium: "bg-app-amber-4",
  low: "bg-app-green-4",
  no_risk: "bg-app-fg-2",
};

interface Facet<T extends string> {
  value: T;
  label: string;
  count: number;
}

/** Count rows by a key, preserving first-seen order, for present-in-queue facets. */
function buildFacets<T extends string>(
  rows: SyncedActionStaging[],
  pick: (r: SyncedActionStaging) => T,
  label: (v: T) => string,
): Facet<T>[] {
  const counts = new Map<T, number>();
  for (const r of rows) {
    const v = pick(r);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, label: label(value), count }));
}

/**
 * Live `/approvals` queue. Reads pending action stagings straight from
 * Replicache (`useActionStagings`) and posts decisions back through the Eden
 * decision API. A successful decision flips the row out of `pending`
 * server-side; the resulting poke pulls the card off the list — so there is
 * no optimistic local removal here.
 *
 * Filtering (integration + risk) and "pagination" (windowing) run entirely
 * client-side over the synced, bounded set; filter state lives in URL search
 * params so a filtered view is shareable and survives reload.
 */
export function ApprovalsPage() {
  const { rows, loading, error, retry } = useActionStagings();
  const { integration: selIntegration = [], risk: selRisk = [] } = useSearch({
    from: "/approvals",
  });
  const navigate = useNavigate({ from: "/approvals" });
  const [visible, setVisible] = useState(WINDOW);

  const integrationFacets = useMemo(
    () =>
      buildFacets(
        rows,
        (r) => r.integration,
        (v) => humanizeSlug(v),
      ),
    [rows],
  );
  const riskFacets = useMemo(
    () =>
      buildFacets(
        rows,
        (r) => r.riskTier,
        (v) => RISK_LABEL[v],
      ),
    [rows],
  );

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (selIntegration.length === 0 || selIntegration.includes(r.integration)) &&
          (selRisk.length === 0 || selRisk.includes(r.riskTier)),
      ),
    [rows, selIntegration, selRisk],
  );

  const filtering = selIntegration.length > 0 || selRisk.length > 0;
  const filterKey = `${selIntegration.join(",")}|${selRisk.join(",")}`;

  useEffect(() => {
    setVisible(WINDOW);
  }, [filterKey]);

  useEffect(() => {
    if (loading) return;
    const targetId = approvalIdFromHash();
    if (!targetId) return;

    const targetIndex = filtered.findIndex((row) => row.id === targetId);
    if (targetIndex === -1) return;
    if (targetIndex >= visible) {
      setVisible(targetIndex + 1);
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      document.getElementById(approvalElementId(targetId))?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filtered, loading, visible]);

  const toggle = (facet: "integration" | "risk", value: string) => {
    const current = facet === "integration" ? selIntegration : selRisk;
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    void navigate({
      search: (prev) => ({ ...prev, [facet]: next.length > 0 ? next : undefined }),
      replace: true,
    });
  };

  const clearFilters = () => {
    void navigate({ search: { integration: undefined, risk: undefined }, replace: true });
  };

  const decide = async (stagingId: string, decision: ApprovalDecision) => {
    const { error } = await client.api.approvals({ stagingId }).decision.post(decision);
    if (error) throw new Error(decisionErrorMessage(error.value));
  };

  const windowed = filtered.slice(0, visible);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <main className="mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <header className="mb-7 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-balance text-[36px] leading-[42px] font-medium tracking-[-0.04em] text-app-fg-4">
              Approvals
            </h1>
            <p className="mt-2 text-sm text-app-fg-3">
              Gated workflow actions waiting for review.
              {filtering && rows.length > 0 ? (
                <span className="text-app-fg-2">
                  {" "}
                  Showing <span className="tabular-nums">{filtered.length}</span> of{" "}
                  <span className="tabular-nums">{rows.length}</span>.
                </span>
              ) : null}
            </p>
          </div>
          <AppPill tone={rows.length > 0 ? "amber" : undefined}>
            <span className="tabular-nums">{rows.length}</span> pending
          </AppPill>
        </header>

        {/* Facet bar — only render facets present in the queue. */}
        {rows.length > 0 && (integrationFacets.length > 1 || riskFacets.length > 1) ? (
          <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
            {integrationFacets.length > 1 ? (
              <FacetGroup>
                {integrationFacets.map((f) => {
                  const brand = brandForIntegration(f.value);
                  return (
                    <FacetChip
                      key={f.value}
                      label={f.label}
                      count={f.count}
                      icon={brand ? <IntegrationGlyph brand={brand} size={15} /> : undefined}
                      active={selIntegration.includes(f.value)}
                      onClick={() => toggle("integration", f.value)}
                    />
                  );
                })}
              </FacetGroup>
            ) : null}
            {riskFacets.length > 1 ? (
              <FacetGroup>
                {riskFacets.map((f) => (
                  <FacetChip
                    key={f.value}
                    label={f.label}
                    count={f.count}
                    active={selRisk.includes(f.value)}
                    dotClass={RISK_DOT[f.value]}
                    onClick={() => toggle("risk", f.value)}
                  />
                ))}
              </FacetGroup>
            ) : null}
            {filtering ? (
              <button
                type="button"
                onClick={clearFilters}
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-app-fg-3",
                  "transition-colors hover:text-app-fg-4 hover:bg-app-bg-a2",
                  "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
                )}
              >
                <X size={13} />
                Clear filters
              </button>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <AppCard className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-app-fg-3">
            <Loader2 size={16} className="animate-spin" />
            Loading approvals…
          </AppCard>
        ) : error ? (
          <EmptyState
            title="Approvals sync did not load"
            body={error}
            action={
              <AppButton variant="white" size="sm" onClick={retry}>
                Retry sync
              </AppButton>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No pending approvals"
            body="Alfred will pause here when a workflow reaches a gated action."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No approvals match these filters"
            body="Nothing in the queue matches the current filters."
            action={
              <AppButton variant="white" size="sm" leading={<X size={14} />} onClick={clearFilters}>
                Clear filters
              </AppButton>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {windowed.map((staging, i) => (
              <div
                id={approvalElementId(staging.id)}
                key={staging.id}
                className="app-card-in scroll-mt-6"
                style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}
              >
                <ApprovalCard
                  staging={staging}
                  onDecide={(decision) => decide(staging.id, decision)}
                />
              </div>
            ))}
            {filtered.length > windowed.length ? (
              <div className="flex justify-center pt-1">
                <AppButton variant="white" size="sm" onClick={() => setVisible((v) => v + WINDOW)}>
                  Show more ({filtered.length - windowed.length})
                </AppButton>
              </div>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}

function approvalIdFromHash(): string | null {
  const prefix = "#approval-";
  if (typeof window === "undefined" || !window.location.hash.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(window.location.hash.slice(prefix.length));
  } catch {
    return null;
  }
}

function approvalElementId(stagingId: string): string {
  return `approval-${stagingId}`;
}

function FacetGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5">{children}</div>;
}

function FacetChip({
  label,
  count,
  active,
  dotClass,
  icon,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  dotClass?: string;
  /** Brand glyph rendered in place of the text label (integration facets). */
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`${label} (${count})`}
      title={label}
      onClick={onClick}
      className={cn(
        "app-press inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium",
        "transition-[background-color,box-shadow,color]",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
        active
          ? "bg-app-fg-4 text-app-bg-1 shadow-[0_1px_2px_rgba(0,0,0,0.12)]"
          : "bg-app-bg-2/70 text-app-fg-3 hover:bg-app-bg-2 hover:text-app-fg-4",
      )}
    >
      {icon ? (
        <span className="inline-flex shrink-0 items-center">{icon}</span>
      ) : (
        <>
          {dotClass ? <span className={cn("size-1.5 rounded-full", dotClass)} aria-hidden /> : null}
          {label}
        </>
      )}
      <span className={cn("tabular-nums", active ? "opacity-80" : "text-app-fg-2")}>{count}</span>
    </button>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <AppCard className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span
        className="grid size-10 place-items-center rounded-xl bg-app-bg-2 text-app-fg-3"
        aria-hidden
      >
        <ClipboardCheck size={18} />
      </span>
      <p className="text-sm font-medium text-app-fg-4">{title}</p>
      <p className="max-w-[28rem] text-xs leading-5 text-app-fg-3">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </AppCard>
  );
}

function decisionErrorMessage(value: unknown): string {
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Failed to record decision";
}
