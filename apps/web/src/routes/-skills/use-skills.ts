import {
  IDB_KEY,
  type SyncedSkill,
  type SyncedSkillRevision,
  type SyncedSkillRun,
  syncedSkillRevisionSchema,
  syncedSkillRunSchema,
  syncedSkillSchema,
} from "@alfred/sync";
import { useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import type { AlfredReplicache } from "~/lib/replicache/client";
import { useReplicacheStatus } from "~/lib/replicache/context";

export interface SkillsState {
  skills: SyncedSkill[];
  loading: boolean;
  error: string | null;
  initialPullPending: boolean;
  retry: () => void;
}

export function useSkills(): SkillsState {
  const { rep, loadError, pullError, initialPullPending, retry } = useReplicacheStatus();
  const [snapshot, setSnapshot] = useState<{
    rep: AlfredReplicache;
    skills: SyncedSkill[];
  } | null>(null);

  useEffect(() => {
    if (!rep) return;
    return rep.subscribe(
      async (tx: ReadTransaction) =>
        tx
          .scan({ prefix: IDB_KEY.SKILL({}) })
          .values()
          .toArray(),
      (values) => {
        const skills = values.flatMap((value) => {
          const result = syncedSkillSchema.safeParse(value);
          return result.success ? [result.data] : [];
        });
        skills.sort((a, b) =>
          (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
        );
        setSnapshot({ rep, skills });
      },
    );
  }, [rep]);

  const skills = snapshot?.rep === rep ? snapshot.skills : null;
  const error = loadError ?? pullError;
  return {
    skills: skills ?? [],
    loading: !error && (skills === null || (skills.length === 0 && initialPullPending)),
    error,
    initialPullPending,
    retry,
  };
}

interface SkillDetailSnapshot {
  rep: AlfredReplicache;
  slug: string;
  skill: SyncedSkill | null;
  revision: SyncedSkillRevision | null;
  runs: SyncedSkillRun[];
}

export interface SkillDetailState {
  skill: SyncedSkill | null;
  revision: SyncedSkillRevision | null;
  runs: SyncedSkillRun[];
  loading: boolean;
  error: string | null;
  initialPullPending: boolean;
  retry: () => void;
}

export function useSkillDetail(slug: string): SkillDetailState {
  const { rep, loadError, pullError, initialPullPending, retry } = useReplicacheStatus();
  const [snapshot, setSnapshot] = useState<SkillDetailSnapshot | null>(null);

  useEffect(() => {
    if (!rep) return;
    return rep.subscribe(
      async (tx: ReadTransaction) =>
        Promise.all([
          tx
            .scan({ prefix: IDB_KEY.SKILL({}) })
            .values()
            .toArray(),
          tx
            .scan({ prefix: IDB_KEY.SKILL_REVISION({}) })
            .values()
            .toArray(),
          tx
            .scan({ prefix: IDB_KEY.SKILL_RUN({}) })
            .values()
            .toArray(),
        ]),
      ([skillValues, revisionValues, runValues]) => {
        const skill = skillValues
          .map((value) => syncedSkillSchema.safeParse(value))
          .find((result) => result.success && result.data.slug === slug);
        const parsedSkill = skill?.success ? skill.data : null;
        const revisions = revisionValues.flatMap((value) => {
          const result = syncedSkillRevisionSchema.safeParse(value);
          return result.success ? [result.data] : [];
        });
        const runs = runValues.flatMap((value) => {
          const result = syncedSkillRunSchema.safeParse(value);
          return result.success && result.data.skillId === parsedSkill?.id ? [result.data] : [];
        });
        runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        setSnapshot({
          rep,
          slug,
          skill: parsedSkill,
          revision:
            revisions.find((revision) => revision.id === parsedSkill?.currentRevisionId) ?? null,
          runs,
        });
      },
    );
  }, [rep, slug]);

  const current = snapshot?.rep === rep && snapshot.slug === slug ? snapshot : null;
  const error = loadError ?? pullError;
  return {
    skill: current?.skill ?? null,
    revision: current?.revision ?? null,
    runs: current?.runs ?? [],
    loading: !error && (current === null || (!current.skill && initialPullPending)),
    error,
    initialPullPending,
    retry,
  };
}
