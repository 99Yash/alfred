import {
  SYNC_MODEL,
  type SyncedSkill,
  type SyncedSkillRevision,
  type SyncedSkillRun,
} from "@alfred/sync";
import { useEffect, useState } from "react";
import type { ReadTransaction, Replicache } from "replicache";
import type { ClientMutators } from "@alfred/sync";
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
    rep: Replicache<ClientMutators>;
    skills: SyncedSkill[];
  } | null>(null);

  useEffect(() => {
    if (!rep) return;
    return rep.subscribe(
      (tx: ReadTransaction) => SYNC_MODEL.skill.scan(tx),
      (skills) => {
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
  rep: Replicache<ClientMutators>;
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
          SYNC_MODEL.skill.scan(tx),
          SYNC_MODEL.skillrev.scan(tx),
          SYNC_MODEL.skillrun.scan(tx),
        ]),
      ([skills, revisions, skillRuns]) => {
        const parsedSkill = skills.find((skill) => skill.slug === slug) ?? null;
        const runs = skillRuns.filter((run) => run.skillId === parsedSkill?.id);
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
