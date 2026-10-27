import {
  SYNC_MODEL,
  type SyncedSkill,
  type SyncedSkillRevision,
  type SyncedSkillRun,
} from "@alfred/sync";
import { useCallback } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheSubscription } from "~/lib/replicache/use-replicache-subscription";

export interface SkillsState {
  skills: SyncedSkill[];
  loading: boolean;
  error: string | null;
  initialPullPending: boolean;
  retry: () => void;
}

const scanSkills = (tx: ReadTransaction) => SYNC_MODEL.skill.scan(tx);

const recentlyUpdatedFirst = (skills: SyncedSkill[]) =>
  skills.toSorted((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));

export function useSkills(): SkillsState {
  const { data, loading, error, initialPullPending, retry } = useReplicacheSubscription(
    scanSkills,
    recentlyUpdatedFirst,
  );

  return { skills: data ?? [], loading, error, initialPullPending, retry };
}

interface SkillDetail {
  skill: SyncedSkill | null;
  revision: SyncedSkillRevision | null;
  runs: SyncedSkillRun[];
}

export interface SkillDetailState extends SkillDetail {
  loading: boolean;
  error: string | null;
  initialPullPending: boolean;
  retry: () => void;
}

const scanSkillTables = async (tx: ReadTransaction) =>
  Promise.all([
    SYNC_MODEL.skill.scan(tx),
    SYNC_MODEL.skillrev.scan(tx),
    SYNC_MODEL.skillrun.scan(tx),
  ]);

const skillMissing = (detail: SkillDetail) => detail.skill === null;

export function useSkillDetail(slug: string): SkillDetailState {
  const selectSkill = useCallback(
    ([skills, revisions, skillRuns]: [SyncedSkill[], SyncedSkillRevision[], SyncedSkillRun[]]) => {
      const skill = skills.find((s) => s.slug === slug) ?? null;

      return {
        skill,
        revision: revisions.find((revision) => revision.id === skill?.currentRevisionId) ?? null,
        runs: skillRuns
          .filter((run) => run.skillId === skill?.id)
          .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt)),
      } satisfies SkillDetail;
    },
    [slug],
  );

  const { data, loading, error, initialPullPending, retry } = useReplicacheSubscription(
    scanSkillTables,
    selectSkill,
    { isEmpty: skillMissing },
  );

  return {
    skill: data?.skill ?? null,
    revision: data?.revision ?? null,
    runs: data?.runs ?? [],
    loading,
    error,
    initialPullPending,
    retry,
  };
}
