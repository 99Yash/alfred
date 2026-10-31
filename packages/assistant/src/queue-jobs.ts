/**
 * BullMQ job-id steps that more than one queue owner needs. Server-only.
 */

/** The part of a BullMQ `Queue` that {@link clearFinishedJob} reads. */
interface FinishedJobQueue {
  getJob(
    jobId: string,
  ): Promise<{ getState(): Promise<string>; remove(): Promise<void> } | undefined>;
}

/**
 * Remove a `completed` or `failed` job under `jobId`, so the next `add` with that id schedules a
 * live job. `add` does nothing for an id that exists, and a finished job stays until its
 * `removeOnComplete` or `removeOnFail` age.
 *
 * A `waiting`, `delayed`, or `active` job stays, and the next `add` does nothing. The caller must
 * accept that the unfinished job covers the new request. BullMQ has no atomic replace, so a job
 * that becomes active between the read and `remove` makes `remove` throw.
 */
export async function clearFinishedJob(queue: FinishedJobQueue, jobId: string): Promise<void> {
  const existing = await queue.getJob(jobId);

  if (!existing) return;

  const state = await existing.getState();

  if (state === "completed" || state === "failed") await existing.remove();
}
