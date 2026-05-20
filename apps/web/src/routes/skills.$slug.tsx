import {
  IDB_KEY,
  type SyncedSkill,
  type SyncedSkillRevision,
  type SyncedSkillRun,
} from "@alfred/sync";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Clock, Command, Loader2, MoreHorizontal, RotateCw, Share2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReadTransaction } from "replicache";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Kbd } from "~/components/ui/kbd";
import { Tabs, type TabItem } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { authClient } from "~/lib/auth-client";
import { client, edenErrorMessage } from "~/lib/eden";
import { useEventStream } from "~/lib/events/use-event-stream";
import { useSubscribe } from "~/lib/replicache/hooks";
import { RunStatusPill } from "~/lib/skills-ui";

export const Route = createFileRoute("/skills/$slug")({
  component: SkillDetailPage,
});

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

const STEP_LABELS: Record<string, string> = {
  gather: "Gathering context",
  distill: "Distilling",
  persist: "Saving",
};

type DetailTab = "learn" | "history";

const TABS: ReadonlyArray<TabItem<DetailTab>> = [
  { value: "learn", label: "Learn" },
  { value: "history", label: "History" },
];

/**
 * Bundle the re-learn workflow state — submitting, error, and the latest
 * live phase from the event stream — into a single reducer. These three
 * pieces always move together as the agent transitions through its steps.
 */
interface RunUiState {
  submitting: boolean;
  error: string | null;
  livePhase: { step: string; phase: string } | null;
}

type RunUiAction =
  | { type: "submitting" }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "phase"; step: string; phase: string }
  | { type: "clear-phase" };

const INITIAL_RUN_UI: RunUiState = { submitting: false, error: null, livePhase: null };

function runUiReducer(state: RunUiState, action: RunUiAction): RunUiState {
  switch (action.type) {
    case "submitting":
      return { ...state, submitting: true, error: null };
    case "done":
      return { ...state, submitting: false };
    case "error":
      return { ...state, submitting: false, error: action.message };
    case "phase":
      return { ...state, livePhase: { step: action.step, phase: action.phase } };
    case "clear-phase":
      return { ...state, livePhase: null };
  }
}

function SkillDetailPage() {
  const { slug } = Route.useParams();
  const { data: session } = authClient.useSession();

  const listSkills = useCallback(async (tx: ReadTransaction): Promise<SyncedSkill[]> => {
    const entries = await tx
      .scan({ prefix: IDB_KEY.SKILL({}) })
      .entries()
      .toArray();
    return entries.map(([, v]) => v as unknown as SyncedSkill);
  }, []);

  const listRevisions = useCallback(async (tx: ReadTransaction): Promise<SyncedSkillRevision[]> => {
    const entries = await tx
      .scan({ prefix: IDB_KEY.SKILL_REVISION({}) })
      .entries()
      .toArray();
    return entries.map(([, v]) => v as unknown as SyncedSkillRevision);
  }, []);

  const listRuns = useCallback(async (tx: ReadTransaction): Promise<SyncedSkillRun[]> => {
    const entries = await tx
      .scan({ prefix: IDB_KEY.SKILL_RUN({}) })
      .entries()
      .toArray();
    return entries.map(([, v]) => v as unknown as SyncedSkillRun);
  }, []);

  const allSkills = useSubscribe(listSkills);
  const allRevisions = useSubscribe(listRevisions);
  const allRuns = useSubscribe(listRuns);

  const skill = useMemo(() => allSkills?.find((s) => s.slug === slug) ?? null, [allSkills, slug]);
  const currentRevision = useMemo(() => {
    if (!skill?.currentRevisionId) return null;
    return allRevisions?.find((r) => r.id === skill.currentRevisionId) ?? null;
  }, [allRevisions, skill?.currentRevisionId]);
  const skillRuns = useMemo(() => {
    if (!skill) return [] as SyncedSkillRun[];
    return (allRuns ?? [])
      .filter((r) => r.skillId === skill.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }, [allRuns, skill]);
  const activeRun = useMemo(
    () => skillRuns.find((r) => !TERMINAL_RUN_STATUSES.has(r.status)) ?? null,
    [skillRuns],
  );

  const [tab, setTab] = useState<DetailTab>("learn");
  const [prompt, setPrompt] = useState("");
  const [runUi, dispatchRunUi] = useReducer(runUiReducer, INITIAL_RUN_UI);

  const eventFrames = useEventStream(50);

  useEffect(() => {
    if (!activeRun) {
      dispatchRunUi({ type: "clear-phase" });
      return;
    }
    const head = eventFrames.find(
      (f) =>
        f.kind === "agent.run" &&
        typeof f.payload === "object" &&
        f.payload !== null &&
        (f.payload as { runId?: string }).runId === activeRun.agentRunId,
    );
    if (!head) return;
    const payload = head.payload as { step?: string; phase?: string };
    if (payload.step && payload.phase) {
      dispatchRunUi({ type: "phase", step: payload.step, phase: payload.phase });
    }
  }, [eventFrames, activeRun]);

  const onRelearn = useCallback(async () => {
    if (!skill || !prompt.trim()) return;
    dispatchRunUi({ type: "submitting" });
    try {
      const res = await client.api.skills({ id: skill.id }).relearn.post({
        prompt: prompt.trim(),
      });
      if (res.error) {
        dispatchRunUi({
          type: "error",
          message: edenErrorMessage(res.error, "Failed to start re-learn"),
        });
        return;
      }
      setPrompt("");
      dispatchRunUi({ type: "done" });
    } catch (err) {
      dispatchRunUi({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to start re-learn",
      });
    }
  }, [skill, prompt]);

  if (!session?.user) {
    return (
      <DetailShell>
        <BackLink />
        <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-950">Not signed in</p>
          <a
            href="/login"
            className="text-[12.5px] text-gray-900 underline underline-offset-4 hover:text-gray-1000"
          >
            Sign in
          </a>
        </Card>
      </DetailShell>
    );
  }

  if (allSkills === undefined) {
    return (
      <DetailShell>
        <p className="text-sm text-gray-800">Loading…</p>
      </DetailShell>
    );
  }

  if (!skill) {
    return (
      <DetailShell>
        <BackLink />
        <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-950">Skill not found</p>
          <p className="text-[12.5px] text-gray-800">
            No skill with slug <code className="font-mono">{slug}</code>.
          </p>
        </Card>
      </DetailShell>
    );
  }

  const learnDisabled = runUi.submitting || !prompt.trim() || activeRun !== null;
  const lastRun = skillRuns[0] ?? null;
  const lastRunLabel = lastRun ? formatLastRun(lastRun.startedAt) : null;

  /* ⌘↵ submits — matches Dimension's keycap hint on the Learn button. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!learnDisabled) onRelearn();
    }
  };

  return (
    <DetailShell>
      <BackLink />

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="heading-display text-[28px] leading-[34px] font-medium tracking-tight">
            {skill.name}
          </h1>
          <p className="mt-1 inline-flex items-center gap-1.5 text-[12.5px] text-gray-800">
            <Clock size={12} className="text-gray-700" />
            {lastRunLabel ?? "Never run"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="md" aria-label="More skill actions">
            <MoreHorizontal size={16} />
          </Button>
          <Button variant="ghost" size="md" leading={<Share2 size={14} />}>
            Share
          </Button>
        </div>
      </header>

      <div>
        <Tabs<DetailTab>
          variant="underline"
          value={tab}
          onValueChange={setTab}
          items={
            tab === "history"
              ? ([
                  { value: "learn", label: "Learn" },
                  {
                    value: "history",
                    label: (
                      <>
                        History
                        <span className="ml-1 text-[11px] text-gray-800 tabular">
                          {skillRuns.length}
                        </span>
                      </>
                    ),
                  },
                ] satisfies ReadonlyArray<TabItem<DetailTab>>)
              : TABS
          }
        />
      </div>

      {tab === "learn" ? (
        <SkillLearnTab
          prompt={prompt}
          onPromptChange={setPrompt}
          onKeyDown={onKeyDown}
          onRelearn={onRelearn}
          learnDisabled={learnDisabled}
          submitting={runUi.submitting}
          activeRun={activeRun}
          error={runUi.error}
          currentRevision={currentRevision}
          livePhase={runUi.livePhase}
        />
      ) : (
        <SkillHistoryTab skillRuns={skillRuns} />
      )}
    </DetailShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Tab content                                                                */
/* -------------------------------------------------------------------------- */

function SkillLearnTab({
  prompt,
  onPromptChange,
  onKeyDown,
  onRelearn,
  learnDisabled,
  submitting,
  activeRun,
  error,
  currentRevision,
  livePhase,
}: {
  prompt: string;
  onPromptChange: (next: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onRelearn: () => void;
  learnDisabled: boolean;
  submitting: boolean;
  activeRun: SyncedSkillRun | null;
  error: string | null;
  currentRevision: SyncedSkillRevision | null;
  livePhase: { step: string; phase: string } | null;
}) {
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-[12.5px] font-medium text-gray-1000">Using Integrations</h3>
          <p className="text-[12.5px] text-gray-800">
            You can mention integrations using @ in the prompt
          </p>
        </div>
        <div className="space-y-2">
          <h2 className="text-[15px] font-medium text-gray-1000">Prompt</h2>
          <Textarea
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Preferences, constraints, hard rules…"
            maxLength={8_000}
            disabled={activeRun !== null}
            rows={6}
            className="font-mono text-[12.5px] min-h-[140px]"
          />
          {error ? <p className="text-[12.5px] text-red-400">{error}</p> : null}
          <div className="flex items-center justify-end gap-2 text-[11.5px] text-gray-800">
            {submitting || activeRun ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                <span>{submitting ? "Starting…" : "Learning…"}</span>
              </>
            ) : (
              <>
                <RotateCw size={11} className="text-gray-700" />
                <button
                  type="button"
                  onClick={onRelearn}
                  disabled={learnDisabled}
                  className="text-gray-900 hover:text-gray-1000 disabled:text-gray-700 disabled:cursor-not-allowed transition-colors"
                >
                  {currentRevision ? "Re-learn" : "Learn"}
                </button>
                <Kbd>
                  <Command size={10} />
                  <span>↵</span>
                </Kbd>
              </>
            )}
          </div>
        </div>
      </section>

      {activeRun ? (
        <div
          className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12.5px]"
          style={{
            background: "rgb(245 158 11 / 0.06)",
            boxShadow: "inset 0 0 0 1px rgb(245 158 11 / 0.22)",
          }}
        >
          <Loader2 size={14} className="animate-spin text-amber-400 shrink-0" />
          <span className="font-medium text-gray-950">Learning:</span>
          <span className="text-gray-800">
            {livePhase
              ? (STEP_LABELS[livePhase.step] ?? `${livePhase.step} (${livePhase.phase})`)
              : "Starting…"}
          </span>
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-[15px] font-medium text-gray-1000">Memory Update</h2>
        {currentRevision ? (
          <article className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentRevision.body}</ReactMarkdown>
          </article>
        ) : (
          <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <p className="text-sm font-medium text-gray-950">No memory yet</p>
            <p className="text-[12.5px] text-gray-800">
              {activeRun
                ? "Alfred is distilling — check back in a moment."
                : "Write a prompt above and press ⌘↵ to author the first revision."}
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}

function SkillHistoryTab({ skillRuns }: { skillRuns: SyncedSkillRun[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[15px] font-medium text-gray-1000">
        Runs <span className="ml-1 text-[11px] text-gray-800 tabular">{skillRuns.length}</span>
      </h2>
      {skillRuns.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-950">No runs yet</p>
          <p className="text-[12.5px] text-gray-800">
            A run starts every time you Learn or Re-learn this skill.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-1">
          {skillRuns.map((run) => (
            <Card key={run.id} className="flex flex-col gap-1.5 px-4 py-3 text-gray-950">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium capitalize text-gray-950">{run.kind}</span>
                <RunStatusPill status={run.status} />
              </div>
              <p className="text-[11.5px] text-gray-800 tabular">
                Started {new Date(run.startedAt).toLocaleString()}
                {run.endedAt ? ` · ended ${new Date(run.endedAt).toLocaleString()}` : ""}
              </p>
              {run.producedRevisionId ? (
                <p className="text-[11px] font-mono text-gray-800">
                  revision {run.producedRevisionId}
                </p>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Shell + back link                                                          */
/* -------------------------------------------------------------------------- */

function DetailShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14 space-y-6">
      <div className="md:hidden h-6" />
      {children}
    </div>
  );
}

function formatLastRun(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Never run";
  const month = date.toLocaleString(undefined, { month: "short" });
  const day = date.toLocaleString(undefined, { day: "2-digit" });
  const time = date.toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Last run at ${month} ${day} at ${time}`;
}

function BackLink() {
  return (
    <Link
      to="/skills"
      className="inline-flex items-center gap-1 text-[12px] text-gray-800 hover:text-gray-1000 transition-colors"
    >
      <ArrowLeft size={12} /> All skills
    </Link>
  );
}
