import { useParams } from "@tanstack/react-router";
import { Clock, MoreHorizontal, Share2 } from "lucide-react";
import { useState } from "react";
import { AppButton, AppCard, AppPill, AppSegmented } from "~/components/ui/v2";
import { findPreviewSkill } from "~/lib/preview-skills";
import { BackLink } from "./back-link";
import { DetailShell } from "./detail-shell";
import { HistoryTab } from "./history-tab";
import { LearnTab } from "./learn-tab";

type DetailTab = "learn" | "history";

const TABS = [
  { value: "learn" as const, label: "Learn" },
  { value: "history" as const, label: "History" },
];

const SHARE_LEADING = <Share2 size={14} />;

export function PreviewSkillDetailPage() {
  const { slug } = useParams({ from: "/skills/$slug" });
  const skill = findPreviewSkill(slug);
  const [tab, setTab] = useState<DetailTab>("learn");

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

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
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
            {skill.lastRunAt ? `Last run at ${formatLastRun(skill.lastRunAt)}` : "Never run"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AppButton variant="ghost" size="md" aria-label="More skill actions">
            <MoreHorizontal size={16} />
          </AppButton>
          <AppButton variant="ghost" size="md" leading={SHARE_LEADING}>
            Share
          </AppButton>
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
                        {skill.runs.length}
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
        <LearnTab skill={skill} initialPrompt={skill.prompt} key={skill.slug} />
      ) : (
        <HistoryTab skill={skill} />
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
