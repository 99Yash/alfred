import {
  IDB_KEY,
  type SyncedSkill,
  type SyncedSkillRevision,
  type SyncedSkillRun,
} from "@alfred/sync";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReadTransaction } from "replicache";
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

function SkillDetailPage() {
  const { slug } = Route.useParams();
  const { data: session } = authClient.useSession();

  const listSkills = useCallback(async (tx: ReadTransaction): Promise<SyncedSkill[]> => {
    const entries = await tx.scan({ prefix: IDB_KEY.SKILL({}) }).entries().toArray();
    return entries.map(([, v]) => v as unknown as SyncedSkill);
  }, []);

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

  const listRuns = useCallback(async (tx: ReadTransaction): Promise<SyncedSkillRun[]> => {
    const entries = await tx.scan({ prefix: IDB_KEY.SKILL_RUN({}) }).entries().toArray();
    return entries.map(([, v]) => v as unknown as SyncedSkillRun);
  }, []);

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

  // Pre-fill prompt with the prior revision's body-derived prompt source.
  // We don't persist the original prompt yet; surface a sane default
  // (empty) so the user types fresh — re-learn doesn't auto-replay.
  // (Plan D5 calls for "pre-filled with last prompt", which lands once
  // we persist the prompt on the run; for v1, blank is fine.)

  const eventFrames = useEventStream(50);

  // Watch the live event stream for the active run's progress.
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

  // Reset live phase when the active run finishes.
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
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-muted-foreground">Not signed in.</p>
          <a href="/login" className="underline text-sm">
            Sign in
          </a>
        </div>
      </div>
    );
  }

  if (allSkills === undefined) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }

  if (!skill) {
    return (
      <div className="max-w-3xl mx-auto p-6 space-y-4">
        <a href="/skills" className="text-sm underline">
          ← Skills
        </a>
        <p className="text-sm text-muted-foreground">
          No skill found with slug <code className="font-mono">{slug}</code>.
        </p>
      </div>
    );
  }

  const learnDisabled = submitting || !prompt.trim() || activeRun !== null;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <a href="/skills" className="text-sm underline text-muted-foreground">
            ← Skills
          </a>
          <h1 className="text-2xl font-bold">{skill.name}</h1>
          <p className="text-xs font-mono text-muted-foreground">/{skill.slug}</p>
        </div>
        <SkillStatusPill status={skill.status} />
      </div>

      <div className="border-b flex gap-1">
        <TabButton active={tab === "learn"} onClick={() => setTab("learn")}>
          Learn
        </TabButton>
        <TabButton active={tab === "history"} onClick={() => setTab("history")}>
          History{" "}
          <span className="text-xs text-muted-foreground">({skillRuns.length})</span>
        </TabButton>
      </div>

      {tab === "learn" ? (
        <div className="space-y-6">
          <section className="rounded-md border p-4 space-y-3">
            <h2 className="text-sm font-semibold">Re-learn</h2>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="New prompt for this skill…"
              className="w-full rounded-md border px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-primary min-h-[100px]"
              maxLength={8_000}
              disabled={activeRun !== null}
            />
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <div className="flex justify-end">
              <button
                onClick={onRelearn}
                disabled={learnDisabled}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {submitting
                  ? "Starting…"
                  : activeRun
                    ? "Learning…"
                    : "Learn"}
              </button>
            </div>
          </section>

          {activeRun ? (
            <div className="rounded-md border bg-amber-50 border-amber-200 px-4 py-3 text-sm">
              <span className="font-medium">Learning:</span>{" "}
              {livePhase
                ? STEP_LABELS[livePhase.step] ??
                  `${livePhase.step} (${livePhase.phase})`
                : "Starting…"}
            </div>
          ) : null}

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Body</h2>
            {currentRevision ? (
              <article className="prose prose-sm max-w-none rounded-md border p-4">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {currentRevision.body}
                </ReactMarkdown>
              </article>
            ) : (
              <p className="text-sm text-muted-foreground">
                No body yet — alfred is still distilling.
              </p>
            )}
          </section>
        </div>
      ) : (
        <section className="space-y-2">
          {skillRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="space-y-2">
              {skillRuns.map((run) => (
                <li
                  key={run.id}
                  className="rounded-md border px-4 py-3 text-sm space-y-1"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium capitalize">{run.kind}</span>
                    <RunStatusPill status={run.status} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Started {new Date(run.startedAt).toLocaleString()}
                    {run.endedAt
                      ? ` · ended ${new Date(run.endedAt).toLocaleString()}`
                      : ""}
                  </p>
                  {run.producedRevisionId ? (
                    <p className="text-xs font-mono text-muted-foreground">
                      revision {run.producedRevisionId}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
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
      className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

