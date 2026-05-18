import {
  IDB_KEY,
  type SyncedSkill,
  type SyncedSkillRevision,
  type SyncedSkillRun,
} from "@alfred/sync";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Command, Loader2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { RunStatusPill, SkillStatusPill } from "~/lib/skills-ui";

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

function SkillDetailPage() {
  const { slug } = Route.useParams();
  const { data: session } = authClient.useSession();

  const listSkills = useCallback(
    async (tx: ReadTransaction): Promise<SyncedSkill[]> => {
      const entries = await tx.scan({ prefix: IDB_KEY.SKILL({}) }).entries().toArray();
      return entries.map(([, v]) => v as unknown as SyncedSkill);
    },
    [],
  );

  const listRevisions = useCallback(
    async (tx: ReadTransaction): Promise<SyncedSkillRevision[]> => {
      const entries = await tx
        .scan({ prefix: IDB_KEY.SKILL_REVISION({}) })
        .entries()
        .toArray();
      return entries.map(([, v]) => v as unknown as SyncedSkillRevision);
    },
    [],
  );

  const listRuns = useCallback(
    async (tx: ReadTransaction): Promise<SyncedSkillRun[]> => {
      const entries = await tx
        .scan({ prefix: IDB_KEY.SKILL_RUN({}) })
        .entries()
        .toArray();
      return entries.map(([, v]) => v as unknown as SyncedSkillRun);
    },
    [],
  );

  const allSkills = useSubscribe(listSkills);
  const allRevisions = useSubscribe(listRevisions);
  const allRuns = useSubscribe(listRuns);

  const skill = useMemo(
    () => allSkills?.find((s) => s.slug === slug) ?? null,
    [allSkills, slug],
  );
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [livePhase, setLivePhase] = useState<{ step: string; phase: string } | null>(null);

  const eventFrames = useEventStream(50);

  useEffect(() => {
    if (!activeRun) {
      setLivePhase(null);
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
      setLivePhase({ step: payload.step, phase: payload.phase });
    }
  }, [eventFrames, activeRun]);

  useEffect(() => {
    if (!activeRun) setLivePhase(null);
  }, [activeRun]);

  const onRelearn = useCallback(async () => {
    if (!skill || !prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await client.api.skills({ id: skill.id }).relearn.post({
        prompt: prompt.trim(),
      });
      if (res.error) {
        setError(edenErrorMessage(res.error, "Failed to start re-learn"));
        return;
      }
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start re-learn");
    } finally {
      setSubmitting(false);
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

  const learnDisabled = submitting || !prompt.trim() || activeRun !== null;

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

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="heading-display text-[28px] leading-[34px] font-medium tracking-tight">
            {skill.name}
          </h1>
          <p className="mt-1 font-mono text-[12.5px] text-gray-800">
            /{skill.slug}
          </p>
        </div>
        <div className="pt-1">
          <SkillStatusPill status={skill.status} />
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
        <div className="space-y-8">
          <section className="space-y-3">
            <div className="space-y-1">
              <h2 className="text-[15px] font-medium text-gray-1000">Prompt</h2>
              <p className="text-[12.5px] text-gray-800">
                Tell Alfred what to remember.{" "}
                {currentRevision
                  ? "Submitting replaces the previous body once distilled."
                  : "The first revision is generated from this prompt plus your memory."}
              </p>
            </div>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Preferences, constraints, hard rules…"
              maxLength={8_000}
              disabled={activeRun !== null}
              rows={6}
              className="font-mono text-[12.5px] min-h-[140px]"
            />
            {error ? (
              <p className="text-[12.5px] text-red-400">{error}</p>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11.5px] text-gray-800 tabular">
                {prompt.length}/8000
              </p>
              <Button
                variant="primary"
                size="lg"
                onClick={onRelearn}
                disabled={learnDisabled}
                leading={
                  submitting || activeRun ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <RotateCw size={14} />
                  )
                }
                trailing={
                  !submitting && !activeRun ? (
                    <Kbd className="!bg-white/10 !border-white/15 !text-white/85">
                      <Command size={10} />
                      <span>↵</span>
                    </Kbd>
                  ) : undefined
                }
              >
                {submitting
                  ? "Starting…"
                  : activeRun
                    ? "Learning"
                    : currentRevision
                      ? "Re-learn"
                      : "Learn"}
              </Button>
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
                  ? (STEP_LABELS[livePhase.step] ??
                    `${livePhase.step} (${livePhase.phase})`)
                  : "Starting…"}
              </span>
            </div>
          ) : null}

          <section className="space-y-3">
            <h2 className="text-[15px] font-medium text-gray-1000">Body</h2>
            {currentRevision ? (
              <Card className="px-5 py-4">
                <article className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {currentRevision.body}
                  </ReactMarkdown>
                </article>
              </Card>
            ) : (
              <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <p className="text-sm font-medium text-gray-950">
                  No body yet
                </p>
                <p className="text-[12.5px] text-gray-800">
                  {activeRun
                    ? "Alfred is distilling — check back in a moment."
                    : "Write a prompt above and click Learn to author the first revision."}
                </p>
              </Card>
            )}
          </section>
        </div>
      ) : (
        <section className="space-y-3">
          <h2 className="text-[15px] font-medium text-gray-1000">
            Runs{" "}
            <span className="ml-1 text-[11px] text-gray-800 tabular">
              {skillRuns.length}
            </span>
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
                <Card
                  key={run.id}
                  className="flex flex-col gap-1.5 px-4 py-3 text-gray-950"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium capitalize text-gray-950">
                      {run.kind}
                    </span>
                    <RunStatusPill status={run.status} />
                  </div>
                  <p className="text-[11.5px] text-gray-800 tabular">
                    Started {new Date(run.startedAt).toLocaleString()}
                    {run.endedAt
                      ? ` · ended ${new Date(run.endedAt).toLocaleString()}`
                      : ""}
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
      )}
    </DetailShell>
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
