import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Command,
  MoreHorizontal,
  RotateCw,
  Share2,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  VsButton,
  VsCard,
  VsPill,
  VsSegmented,
  VsTextarea,
} from "~/components/ui/visitors";
import {
  findPreviewSkill,
  type PreviewSkill,
  type PreviewSkillRun,
} from "~/lib/preview-skills";
import { cn } from "~/lib/utils";

/**
 * Visitors-now-grammar port of /skills/$slug.
 *
 * The detail surface is two tabs:
 *   • Learn   — prompt textarea + Re-learn CTA + Memory Update card
 *   • History — list of runs with VsPill statuses + revision IDs
 *
 * Fixture-driven so the page can be reviewed in isolation. Re-learn
 * is a stateful no-op that toggles a "learning…" banner for ~1.5s,
 * matching the active-run state in the dimension page without
 * actually starting a job.
 */
export const Route = createFileRoute("/preview/skills/$slug")({
  component: PreviewSkillDetailPage,
});

type DetailTab = "learn" | "history";

const TABS = [
  { value: "learn" as const, label: "Learn" },
  { value: "history" as const, label: "History" },
];

function PreviewSkillDetailPage() {
  const { slug } = Route.useParams();
  const skill = findPreviewSkill(slug);
  const [tab, setTab] = useState<DetailTab>("learn");

  if (!skill) {
    return (
      <DetailShell>
        <BackLink />
        <VsCard className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <p className="text-sm font-medium text-vs-fg-4">Skill not found</p>
          <p className="text-xs text-vs-fg-3">
            No skill with slug <code className="font-mono text-vs-fg-4">{slug}</code>.
          </p>
        </VsCard>
      </DetailShell>
    );
  }

  return (
    <DetailShell>
      <BackLink />

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-[28px] leading-[34px] font-medium tracking-tight text-vs-fg-4">
              {skill.name}
            </h1>
            {skill.status === "active" ? (
              <VsPill tone="green">Active</VsPill>
            ) : (
              <VsPill>Draft</VsPill>
            )}
          </div>
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-vs-fg-3 tabular-nums">
            <Clock size={12} className="text-vs-fg-2" />
            {skill.lastRunAt ? `Last run at ${formatLastRun(skill.lastRunAt)}` : "Never run"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <VsButton variant="ghost" size="md" aria-label="More skill actions">
            <MoreHorizontal size={16} />
          </VsButton>
          <VsButton variant="ghost" size="md" leading={<Share2 size={14} />}>
            Share
          </VsButton>
        </div>
      </header>

      <VsSegmented<DetailTab>
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
                      <span className="ml-1 text-[11px] text-vs-fg-2 tabular-nums">
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

      {tab === "learn" ? <LearnTab skill={skill} /> : <HistoryTab skill={skill} />}
    </DetailShell>
  );
}

function DetailShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto vs-scrollbar">
      <main className="mx-auto w-full max-w-3xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <div className="space-y-6">{children}</div>
      </main>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/preview/skills"
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-vs-fg-3",
        "transition-colors hover:text-vs-fg-4",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background rounded",
      )}
    >
      <ArrowLeft size={12} /> All skills
    </Link>
  );
}

function LearnTab({ skill }: { skill: PreviewSkill }) {
  const [prompt, setPrompt] = useState(skill.prompt);
  const [learning, setLearning] = useState(false);

  const onRelearn = () => {
    if (learning || !prompt.trim()) return;
    setLearning(true);
    setTimeout(() => setLearning(false), 1500);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onRelearn();
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-vs-fg-4">Using Integrations</h3>
          <p className="text-xs text-vs-fg-3">
            {skill.integrations.length > 0
              ? `${skill.integrations.join(", ")}. You can mention integrations using @ in the prompt.`
              : "You can mention integrations using @ in the prompt."}
          </p>
        </div>
        <div className="space-y-2">
          <h2 className="text-[15px] font-medium text-vs-fg-4">Prompt</h2>
          <VsTextarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Preferences, constraints, hard rules…"
            maxLength={8_000}
            disabled={learning}
            rows={6}
            className="font-mono text-[12.5px] min-h-[140px]"
          />
          <div className="flex items-center justify-end gap-2 text-[11.5px] text-vs-fg-3">
            <RotateCw size={11} className="text-vs-fg-2" />
            <button
              type="button"
              onClick={onRelearn}
              disabled={learning || !prompt.trim()}
              className={cn(
                "transition-colors",
                "hover:text-vs-fg-4",
                "disabled:text-vs-fg-2 disabled:cursor-not-allowed",
              )}
            >
              {skill.memoryBody ? "Re-learn" : "Learn"}
            </button>
            <Kbd>
              <Command size={10} />
              <span>↵</span>
            </Kbd>
          </div>
        </div>
      </section>

      {learning ? (
        <div
          className={cn(
            "flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs",
            "bg-vs-amber-1 shadow-[0_0_0_1px_var(--vs-amber-2)]",
            "text-vs-amber-4",
          )}
        >
          <span className="size-2 rounded-full bg-vs-amber-4 animate-pulse" aria-hidden />
          <span className="font-medium">Learning…</span>
          <span className="opacity-80">distilling the prompt into memory.</span>
        </div>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-baseline gap-2 px-1">
          <h2 className="text-[15px] font-medium text-vs-fg-4">Memory update</h2>
          {skill.memoryBody ? (
            <span className="text-[11px] text-vs-fg-2 tabular-nums">
              Updated {formatRelative(skill.updatedAt)}
            </span>
          ) : null}
        </div>
        {skill.memoryBody ? <MemoryCard body={skill.memoryBody} /> : <EmptyMemoryCard />}
      </section>
    </div>
  );
}

function MemoryCard({ body }: { body: string }) {
  return (
    <VsCard className="px-5 py-4">
      <article
        className={cn(
          "text-sm leading-6 text-vs-fg-4",
          /* Tighter list styling — the visitors aesthetic favors low
           * vertical density. Each list item gets a tiny purple
           * sparkle accent via list-style: none + ::marker fallback,
           * which we draw inline via a custom renderer below. */
          "[&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:m-0 [&_ul]:p-0 [&_ul]:list-none",
          "[&_li]:flex [&_li]:items-start [&_li]:gap-2.5",
          "[&_strong]:text-vs-fg-4 [&_strong]:font-medium",
          "[&_em]:text-vs-fg-3 [&_em]:not-italic [&_em]:font-mono [&_em]:text-[12.5px] [&_em]:rounded [&_em]:bg-vs-bg-2 [&_em]:px-1 [&_em]:py-px",
          "[&_p]:m-0",
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            li: ({ children }) => (
              <li>
                <Sparkles
                  size={13}
                  aria-hidden
                  className="mt-[3px] shrink-0 text-vs-purple-4"
                />
                <span className="min-w-0 flex-1">{children}</span>
              </li>
            ),
          }}
        >
          {body}
        </ReactMarkdown>
      </article>
    </VsCard>
  );
}

function EmptyMemoryCard() {
  return (
    <VsCard className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span
        className="grid size-10 place-items-center rounded-xl bg-vs-bg-2 text-vs-fg-3"
        aria-hidden
      >
        <Sparkles size={18} />
      </span>
      <p className="text-sm font-medium text-vs-fg-4">No memory yet</p>
      <p className="max-w-[28rem] text-xs leading-5 text-vs-fg-3">
        Write a prompt above and press <Kbd inline>⌘↵</Kbd> to author the first revision.
      </p>
    </VsCard>
  );
}

function HistoryTab({ skill }: { skill: PreviewSkill }) {
  if (skill.runs.length === 0) {
    return (
      <VsCard className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <span
          className="grid size-10 place-items-center rounded-xl bg-vs-bg-2 text-vs-fg-3"
          aria-hidden
        >
          <Clock size={18} />
        </span>
        <p className="text-sm font-medium text-vs-fg-4">No runs yet</p>
        <p className="text-xs text-vs-fg-3">
          A run starts every time you Learn or Re-learn this skill.
        </p>
      </VsCard>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="text-[15px] font-medium text-vs-fg-4">Runs</h2>
        <span className="text-xs text-vs-fg-2 tabular-nums">{skill.runs.length}</span>
      </div>
      <ul className="flex flex-col gap-2">
        {skill.runs.map((run) => (
          <li key={run.id}>
            <RunRow run={run} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RunRow({ run }: { run: PreviewSkillRun }) {
  return (
    <VsCard className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium capitalize text-vs-fg-4">{run.kind}</span>
        <RunStatusPill status={run.status} />
      </div>
      <p className="mt-1 text-[11.5px] text-vs-fg-3 tabular-nums">
        Started {new Date(run.startedAt).toLocaleString()}
        {run.endedAt ? ` · ended ${new Date(run.endedAt).toLocaleString()}` : ""}
      </p>
      {run.revisionId ? (
        <p className="mt-0.5 text-[11px] font-mono text-vs-fg-2">revision {run.revisionId}</p>
      ) : null}
    </VsCard>
  );
}

function RunStatusPill({ status }: { status: PreviewSkillRun["status"] }) {
  if (status === "completed") {
    return (
      <VsPill tone="green">
        <CheckCircle2 size={11} aria-hidden className="mr-1" /> Completed
      </VsPill>
    );
  }
  if (status === "failed") {
    return (
      <VsPill tone="red">
        <XCircle size={11} aria-hidden className="mr-1" /> Failed
      </VsPill>
    );
  }
  return (
    <VsPill tone="amber">
      <span aria-hidden className="size-1.5 rounded-full bg-vs-amber-4 animate-pulse mr-1" />
      Running
    </VsPill>
  );
}

function Kbd({
  children,
  inline,
}: {
  children: ReactNode;
  inline?: boolean;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center gap-0.5 h-[18px] px-1 rounded-md",
        "bg-vs-bg-2 text-vs-fg-3 font-sans text-[11px]",
        "shadow-[0_0_0_1px_rgba(0,0,0,0.05)]",
        inline && "mx-0.5",
      )}
    >
      {children}
    </kbd>
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

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / (60 * 1000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
