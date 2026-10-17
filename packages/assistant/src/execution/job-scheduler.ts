import type { Job } from "bullmq";

/**
 * The time a job scheduler fired this job for. Do not use `job.timestamp`: BullMQ
 * stamps each next scheduled job when the previous one runs, so it lags one
 * interval. `opts.delay` holds the scheduled offset. Retries and promotion
 * overwrite `job.delay`, but they do not change `opts`.
 */
export function scheduledFireTime(job: Pick<Job, "timestamp" | "opts">): Date {
  return new Date(job.timestamp + (job.opts.delay ?? 0));
}
