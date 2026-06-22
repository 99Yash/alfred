import type { BriefingSlot } from "@alfred/contracts";
import { db } from "@alfred/db";
import { user as userTable } from "@alfred/db/schemas";
import { Queue, Worker, type Job } from "bullmq";
import { createRedisConnection } from "../../queue/connection";
import { createRun, enqueueRun } from "../agent/index";
import { resolveFeatureFlags } from "../features/flags";
import {
  localDateInTimezone,
  localHourInTimezone,
  resolveBriefingPreferences,
} from "./preferences";
import { DAILY_BRIEFING_WORKFLOW_SLUG } from "./workflow-input";
import { toMessage } from "@alfred/contracts";

/**
 * Briefing-cron queue (ADR-0025 #2). Distinct from the agent queue (the
 * daily-briefing *workflow* runs through the agent runtime); this
 * queue's only job is to *trigger* a workflow run on the right schedule
 * for the right user.
 *
 * Why a separate queue rather than a BullMQ repeatable directly on the
 * agent queue: the cron job's responsibility is "fan out to users whose
 * local hour matches their delivery_hour right now." That's a per-tick
 * read of `user_preferences`, not a workflow run — keeping it in its
 * own lane mirrors `memory-cron` and keeps the agent queue free of
 * cron metadata.
 */
export const BRIEFING_QUEUE_NAME = "briefing-cron";

export type BriefingJobData =
  /** Repeatable: fires hourly; fans out to matching users. */
  | { kind: "briefing.tick" }
  /** Direct trigger from the smoke script / the rail "Generate briefing" button. */
  | { kind: "briefing.run"; userId: string; slot?: BriefingSlot; reason?: "manual" | "forced" };

let _queue: Queue<BriefingJobData> | undefined;
let _worker: Worker<BriefingJobData> | undefined;

export function getBriefingQueue(): Queue<BriefingJobData> {
  if (_queue) return _queue;
  _queue = new Queue<BriefingJobData>(BRIEFING_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { count: 20, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 50, age: 30 * 24 * 60 * 60 },
    },
  });
  return _queue;
}

export interface StartBriefingWorkerOpts {
  concurrency?: number;
}

export async function startBriefingWorker(opts: StartBriefingWorkerOpts = {}): Promise<void> {
  if (_worker) return;
  _worker = new Worker<BriefingJobData>(BRIEFING_QUEUE_NAME, processBriefingJob, {
    connection: createRedisConnection(),
    // Cron tick + per-user enqueue is cheap; one is enough.
    concurrency: opts.concurrency ?? 1,
  });
  _worker.on("error", (err) => {
    console.error("[briefing:worker] error:", err.message);
  });
}

export async function stopBriefingWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = undefined;
  }
}

export async function closeBriefingQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}

async function processBriefingJob(job: Job<BriefingJobData>): Promise<unknown> {
  const data = job.data;
  switch (data.kind) {
    case "briefing.tick":
      return handleTick();
    case "briefing.run":
      return handleManualRun(data.userId, data.slot ?? "morning", data.reason ?? "manual");
    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown briefing job kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

interface TickResult {
  scanned: number;
  enqueued: number;
  skipped: number;
}

/**
 * Hourly fan-out. For each user, resolve their tz + delivery hour and
 * compare to "now in their local time." The actual no-double-send
 * guard is the slot-scoped `briefings` unique index plus the
 * `email_sends` unique index in the workflow's `send` step — this tick
 * is allowed to be loose. Worst case a duplicate tick resumes or skips
 * the same terminal briefing row.
 */
async function handleTick(): Promise<TickResult> {
  const now = new Date();
  const users = await db().select({ id: userTable.id }).from(userTable);

  let enqueued = 0;
  let skipped = 0;

  for (const u of users) {
    try {
      const [prefs, flags] = await Promise.all([
        resolveBriefingPreferences(u.id),
        resolveFeatureFlags(u.id),
      ]);
      const localHour = localHourInTimezone(prefs.timezone, now);
      const briefingDate = localDateInTimezone(prefs.timezone, now);
      // Each slot is its own background-agent toggle (Settings → Features).
      // A disabled slot is dropped here, not at compose-time, so a switched-off
      // briefing never creates a run. UNSET defaults to ON (see resolveFeatureFlags).
      const allSlots: Array<{ slot: BriefingSlot; hour: number; enabled: boolean }> = [
        { slot: "morning", hour: prefs.deliveryHour, enabled: flags.morningBriefing },
        { slot: "evening", hour: prefs.eveningHour, enabled: flags.eveningRecap },
      ];
      const slots = allSlots.filter((s) => s.enabled);
      // Slots the user switched off count as skipped for the tick metric.
      skipped += allSlots.length - slots.length;
      const matchingSlots = slots.filter((s) => localHour === s.hour);
      if (matchingSlots.length === 0) {
        skipped += slots.length;
        continue;
      }
      skipped += slots.length - matchingSlots.length;
      if (matchingSlots.length > 1) {
        console.warn(
          `[briefing:worker] user=${u.id} local hour=${localHour} matches ${matchingSlots
            .map((s) => s.slot)
            .join("+")}; enqueuing ${matchingSlots.length} briefing slots`,
        );
      }

      for (const s of matchingSlots) {
        await enqueueBriefingRun({
          userId: u.id,
          slot: s.slot,
          briefingDate,
          reason: "cron",
        });
        enqueued++;
      }
    } catch (err) {
      // Per-user failure shouldn't take down the whole tick.
      skipped++;
      console.warn(`[briefing:worker] tick failed for user=${u.id}:`, toMessage(err));
    }
  }

  console.log(
    `[briefing:worker] tick scanned=${users.length} enqueued=${enqueued} skipped=${skipped}`,
  );
  return { scanned: users.length, enqueued, skipped };
}

async function handleManualRun(
  userId: string,
  slot: BriefingSlot,
  reason: "manual" | "forced",
): Promise<{ runId: string }> {
  const prefs = await resolveBriefingPreferences(userId);
  const briefingDate = localDateInTimezone(prefs.timezone);
  return enqueueBriefingRun({ userId, slot, briefingDate, reason });
}

interface EnqueueBriefingRunArgs {
  userId: string;
  slot?: BriefingSlot;
  briefingDate: string;
  reason: "cron" | "manual" | "forced";
}

/**
 * Create + enqueue a `daily-briefing` agent run for the given user.
 * Public helper — used by the hourly tick, the smoke script (m10d), and
 * the rail "Generate briefing" button (`POST /api/me/briefings/run`).
 */
export async function enqueueBriefingRun(args: EnqueueBriefingRunArgs): Promise<{ runId: string }> {
  const slot = args.slot ?? "morning";
  const { runId } = await createRun({
    userId: args.userId,
    workflowSlug: DAILY_BRIEFING_WORKFLOW_SLUG,
    brief: `${slot} briefing for ${args.briefingDate} (${args.reason})`,
    input: {
      slot,
      reason: args.reason,
      briefingDate: args.briefingDate,
    },
    // briefing-cron predates ADR-0027's generic `workflows.tick`. It
    // still owns its own per-feature fan-out (because matching local
    // hour ≠ a single `next_run_at`), so we stamp the trigger here
    // rather than at a central dispatcher.
    trigger:
      args.reason === "cron"
        ? { kind: "cron", scheduledFor: new Date().toISOString() }
        : { kind: "manual" },
  });
  await enqueueRun(runId);
  return { runId };
}
