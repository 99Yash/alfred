import { z } from "zod";
import { defineQueue, job, signal } from "@alfred/assistant/queue-jobs";

/**
 * The standing-instruction re-match queue (ADR-0113, "Re-match after a change"; plan decision
 * 20). A sweep enqueues each user whose instruction-set `revision` is ahead of
 * `rematched_revision`. A triage write that read an older set enqueues its user too. The worker
 * is `rematch-worker.ts`.
 */
export const triageRematchQueue = defineQueue({
  name: "triage-rematch",
  jobs: {
    /** Repeatable: enqueue a re-match for each user that is behind. */
    "triage.rematch.sweep": signal(),
    /**
     * Re-match one user's recent mail against the current instruction set. One job for each user
     * at a time. An add while the user's job runs is kept and runs after it, so a write during
     * the job is not lost and two jobs never write the same rows at once.
     */
    "triage.rematch.user": job(z.object({ userId: z.string().min(1) }), ({ userId }) => ({
      deduplication: { id: `triage.rematch.user.${userId}`, keepLastIfActive: true },
    })),
  },
  defaults: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 50, age: 24 * 60 * 60 },
    removeOnFail: { count: 50, age: 24 * 60 * 60 },
  },
});
