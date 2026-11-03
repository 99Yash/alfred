import { TRIAGE_REMATCH_SWEEP_EVERY_MS } from "./constants";
import { rematchStandingInstructions, usersBehindRematch } from "./rematch";
import { triageRematchQueue } from "./rematch-queue";

/** The `triage-rematch` worker and its sweep schedule (ADR-0113). */
export const triageRematchWorker = triageRematchQueue.consume({
  label: "triage.rematch",
  // Two slots, so a long user job does not hold the sweep.
  concurrency: 2,
  handlers: {
    "triage.rematch.sweep": async () => {
      const behind = await usersBehindRematch();

      for (const userId of behind) await triageRematchQueue.add("triage.rematch.user", { userId });

      return { behind: behind.length };
    },

    "triage.rematch.user": async ({ userId }, job, signal) =>
      rematchStandingInstructions({
        userId,
        signal,
        // `attemptsMade` counts the failed attempts before this one.
        finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      }),
  },
  schedules: [
    {
      kind: "triage.rematch.sweep",
      repeat: { every: TRIAGE_REMATCH_SWEEP_EVERY_MS },
      opts: {
        attempts: 1,
        removeOnComplete: { count: 10, age: 60 * 60 },
        removeOnFail: { count: 50, age: 24 * 60 * 60 },
      },
    },
  ],
});
