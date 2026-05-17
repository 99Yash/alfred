import {
  IDB_KEY,
  type SyncedSkill,
  type SyncedSkillRevision,
  type SyncedSkillRun,
} from "@alfred/sync";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Loader2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReadTransaction } from "replicache";
import { authClient } from "~/lib/auth-client";
import { client, edenErrorMessage } from "~/lib/eden";
import { useEventStream } from "~/lib/events/use-event-stream";
import { useSubscribe } from "~/lib/replicache/hooks";
import { RunStatusPill, SkillStatusPill } from "~/lib/skills-ui";
import {
  Button,
  Card,
  EmptyState,
  PageContainer,
  PageHeader,
  SectionHeader,
  Textarea,
} from "~/lib/ui";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/skills/$slug")({
  component: SkillDetailPage,
});

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

const STEP_LABELS: Record<string, string> = {
  gather: "Gathering context",
  distill: "Distilling",
  persist: "Saving",
};

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

  const [tab, setTab] = useState<"learn" | "history">("learn");
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
      <PageContainer>
        <EmptyState
          title="Not signed in"
          description="Sign in to view this skill."
          action={
            <a
              href="/login"
              className="text-sm underline text-muted-foreground hover:text-foreground"
            >
              Sign in
            </a>
          }
        />
      </PageContainer>
    );
  }

  if (allSkills === undefined) {
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </PageContainer>
    );
  }

  if (!skill) {
    return (
      <PageContainer>
        <BackLink />
        <EmptyState
          title="Skill not found"
          description={
            <>
              No skill with slug <code className="font-mono">{slug}</code>.
            </>
          }
        />
      </PageContainer>
    );
  }

  const learnDisabled = submitting || !prompt.trim() || activeRun !== null;

  return (
    <PageContainer>
      <div className="space-y-1">
        <BackLink />
        <PageHeader
          title={skill.name}
          description={
            <span className="font-mono text-[12px] text-muted-foreground">
              /{skill.slug}
            </span>
          }
          right={<SkillStatusPill status={skill.status} />}
        />
      </div>

      {/* Tabs */}
      <div className="border-b flex gap-1 -mt-3">
        <TabButton active={tab === "learn"} onClick={() => setTab("learn")}>
          Learn
        </TabButton>
        <TabButton active={tab === "history"} onClick={() => setTab("history")}>
          History
          <span className="ml-1 text-[11px] text-muted-foreground tabular">
            {skillRuns.length}
          </span>
        </TabButton>
      </div>

      {tab === "learn" ? (
        <div className="space-y-6">
          <Card className="p-5 space-y-3">
            <SectionHeader
              title="Re-learn"
              description="Refine what Alfred remembers. The new prompt replaces the previous body once distilled."
            />
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="New prompt for this skill…"
              maxLength={8_000}
              disabled={activeRun !== null}
              className="font-mono text-[12.5px] min-h-[120px]"
            />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground tabular">
                {prompt.length}/8000
              </p>
              <Button onClick={onRelearn} disabled={learnDisabled}>
                {submitting ? (
                  "Starting…"
                ) : activeRun ? (
                  <>
                    <Loader2 size={13} className="animate-spin" /> Learning
                  </>
                ) : (
                  <>
                    <RotateCw size={13} /> Re-learn
                  </>
                )}
              </Button>
            </div>
          </Card>

          {activeRun ? (
            <div className="flex items-center gap-2 rounded-md border bg-amber-500/5 border-amber-500/30 px-4 py-2.5 text-[13px]">
              <Loader2 size={14} className="animate-spin text-amber-500 shrink-0" />
              <span className="font-medium">Learning:</span>
              <span className="text-muted-foreground">
                {livePhase
                  ? (STEP_LABELS[livePhase.step] ??
                    `${livePhase.step} (${livePhase.phase})`)
                  : "Starting…"}
              </span>
            </div>
          ) : null}

          <section className="space-y-3">
            <SectionHeader title="Body" />
            {currentRevision ? (
              <Card className="px-5 py-4">
                <article className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {currentRevision.body}
                  </ReactMarkdown>
                </article>
              </Card>
            ) : (
              <EmptyState
                title="No body yet"
                description="Alfred is still distilling. Check back in a moment."
              />
            )}
          </section>
        </div>
      ) : (
        <section className="space-y-3">
          <SectionHeader title="Runs" count={skillRuns.length} />
          {skillRuns.length === 0 ? (
            <EmptyState
              title="No runs yet"
              description="A run starts every time you Learn or Re-learn this skill."
            />
          ) : (
            <ul className="space-y-2">
              {skillRuns.map((run) => (
                <li
                  key={run.id}
                  className="rounded-lg border bg-card px-4 py-3 text-sm shadow-soft space-y-1"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium capitalize">{run.kind}</span>
                    <RunStatusPill status={run.status} />
                  </div>
                  <p className="text-[11px] text-muted-foreground tabular">
                    Started {new Date(run.startedAt).toLocaleString()}
                    {run.endedAt
                      ? ` · ended ${new Date(run.endedAt).toLocaleString()}`
                      : ""}
                  </p>
                  {run.producedRevisionId ? (
                    <p className="text-[11px] font-mono text-muted-foreground">
                      revision {run.producedRevisionId}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </PageContainer>
  );
}

function BackLink() {
  return (
    <Link
      to="/skills"
      className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeft size={12} /> All skills
    </Link>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center px-3 py-2 text-[13px] border-b-2 -mb-px transition-colors",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
