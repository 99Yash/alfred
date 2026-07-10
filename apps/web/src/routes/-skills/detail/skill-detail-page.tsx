import { useParams } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import { useState } from "react";
import { AppButton, AppCard, AppPill, AppSegmented } from "~/components/ui/v2";
import { useSkillDetail } from "../use-skills";
import { BackLink } from "./back-link";
import { DetailShell } from "./detail-shell";
import { HistoryTab } from "./history-tab";
import { LearnTab } from "./learn-tab";

type DetailTab = "learn" | "history";

const TABS = [
  { value: "learn" as const, label: "Learn" },
  { value: "history" as const, label: "History" },
];

export function SkillDetailPage() {
  const { slug } = useParams({ from: "/skills/$slug" });
  const { skill, revision, runs, loading, error, retry } = useSkillDetail(slug);
  const [tab, setTab] = useState<DetailTab>("learn");

  if (loading) {
    return (
      <DetailShell>
        <BackLink />
        <div className="h-24 animate-pulse rounded-2xl bg-app-bg-2" aria-label="Loading skill" />
        <div className="h-64 animate-pulse rounded-2xl bg-app-bg-2" />
      </DetailShell>
    );
  }

  if (error && !skill) {
    return (
      <DetailShell>
        <BackLink />
        <AppCard className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <div>
            <p className="text-sm font-medium text-app-fg-4">Couldn’t load skill</p>
            <p className="mt-1 text-xs text-app-fg-3">{error}</p>
          </div>
          <AppButton size="sm" onClick={retry}>
            Retry
          </AppButton>
        </AppCard>
      </DetailShell>
    );
  }

  if (!skill) {
    return (
      <DetailShell>
        <BackLink />
        <AppCard className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <p className="text-sm font-medium text-app-fg-4">Skill not found</p>
          <p className="text-xs text-app-fg-3">
            No skill with slug <code className="font-mono text-app-fg-4">{slug}</code>.
          </p>
        </AppCard>
      </DetailShell>
    );
  }

  return (
    <DetailShell>
      <BackLink />

      {error ? (
        <AppCard className="flex items-center justify-between gap-4 px-4 py-3">
          <p className="text-xs text-app-fg-3">
            Showing the cached skill. <span className="text-app-red-4">{error}</span>
          </p>
          <AppButton size="sm" onClick={retry}>
            Retry
          </AppButton>
        </AppCard>
      ) : null}

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[28px] leading-[34px] font-medium tracking-tight text-app-fg-4">
              {skill.name}
            </h1>
            {skill.status === "active" ? (
              <AppPill tone="green">Active</AppPill>
            ) : (
              <AppPill>Draft</AppPill>
            )}
          </div>
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-app-fg-3 tabular-nums">
            <Clock size={12} className="text-app-fg-2" />
            {skill.lastInvokedAt
              ? `Last run at ${formatLastRun(skill.lastInvokedAt)}`
              : "Never run"}
          </p>
        </div>
      </header>

      <AppSegmented<DetailTab>
        value={tab}
        onValueChange={setTab}
        items={
          tab === "history"
            ? [
                { value: "learn" as const, label: "Learn" },
                {
                  value: "history" as const,
                  label: (
                    <>
                      History
                      <span className="ml-1 text-[11px] text-app-fg-2 tabular-nums">
                        {runs.length}
                      </span>
                    </>
                  ),
                },
              ]
            : TABS
        }
        label="Skill detail sections"
      />

      {tab === "learn" ? (
        <LearnTab skill={skill} revision={revision} runs={runs} key={skill.id} />
      ) : (
        <HistoryTab runs={runs} />
      )}
    </DetailShell>
  );
}

function formatLastRun(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = d.toLocaleString(undefined, { month: "short" });
  const day = d.toLocaleString(undefined, { day: "2-digit" });
  const time = d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${month} ${day} at ${time}`;
}
