import type { BriefingSlot } from "@alfred/contracts";
import { Queue, Worker, type Job } from "bullmq";
import { createRedisConnection } from "@alfred/db/redis";
import { selectEmailableUsers } from "@alfred/assistant/delivery";
import { startRun } from "@alfred/assistant/execution";
import { resolveFeatureFlags } from "@alfred/assistant/settings";
import { inZone } from "@alfred/assistant/time";
import { resolveBriefingPreferences } from "./preferences";
import { DAILY_BRIEFING_WORKFLOW_SLUG } from "./workflow-input";
import { toMessage } from "@alfred/contracts";

/**
 * Briefing cron queue (ADR-0025 #2). It only triggers runs; the workflow runs on the agent queue.
 * Separate because the tick fans out to users whose local hour matches, which is not
 * one `next_run_at`. Same pattern as `memory-cron`.
 */
const BRIEFING_QUEUE_NAME = "briefing-cron";

export type BriefingJobData =
  /** Hourly; fans out to matching users. */
  | { kind: "briefing.tick" }
  /** From the smoke script or the "Generate briefing" button. */
  | { kind: "briefing.run"; userId: string; slot?: BriefingSlot; reason?: "manual" | "forced" };

let _queue: Queue<BriefingJobData> | undefined;

let _worker: Worker<BriefingJobData> | undefined;

export function getBriefingQueue(): Queue<BriefingJobData> {
  if (_queue) return _queue;
  _queue = new Queue<BriefingJobData>(BRIEFING_QUEUE_NAME, {
    connection: createRedisConnection("queue"),
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
    connection: createRedisConnection("queue"),
    // One is enough.
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
      return handleTick(new Date(job.timestamp));
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
 * Hourly fan-out by each user's local hour. This may be loose: the `briefings` and
 * `email_sends` unique indexes block a double send.
 */
async function handleTick(now: Date = new Date()): Promise<TickResult> {
  const users = await selectEmailableUsers();

  let enqueued = 0;
  let skipped = 0;

  for (const u of users) {
    try {
      const [prefs, flags] = await Promise.all([
        resolveBriefingPreferences(u.id),
        resolveFeatureFlags(u.id),
      ]);

      const zone = inZone(prefs.timezone);
      const localHour = zone.hour(now);
      const briefingDate = zone.day(now);

      // A disabled slot never creates a run. Unset means on (see resolveFeatureFlags).
      const allSlots: Array<{ slot: BriefingSlot; hour: number; enabled: boolean }> = [
        { slot: "morning", hour: prefs.deliveryHour, enabled: flags.morningBriefing },
        { slot: "evening", hour: prefs.eveningHour, enabled: flags.eveningRecap },
      ];

      const slots = allSlots.filter((s) => s.enabled);
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
          scheduledFor: now.toISOString(),
        });
        enqueued++;
      }
    } catch (err) {
      // One user's failure must not stop the tick.
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
  const briefingDate = inZone(prefs.timezone).day();

  return enqueueBriefingRun({ userId, slot, briefingDate, reason });
}

interface EnqueueBriefingRunArgs {
  userId: string;
  slot?: BriefingSlot;
  briefingDate: string;
  reason: "cron" | "manual" | "forced";
  scheduledFor?: string;
}

/** Create and enqueue a `daily-briefing` run. Used by the tick, the smoke script, and `POST /api/me/briefings/run`. */
export async function enqueueBriefingRun(args: EnqueueBriefingRunArgs): Promise<{ runId: string }> {
  const slot = args.slot ?? "morning";

  const trigger =
    args.reason === "cron"
      ? ({ kind: "cron", scheduledFor: args.scheduledFor ?? new Date().toISOString() } as const)
      : ({ kind: "manual" } as const);

  const occurrence =
    trigger.kind === "cron"
      ? {
          trigger,
          workflowRevisionId: null,
          occurrence: {
            kind: "cron" as const,
            workflowId: DAILY_BRIEFING_WORKFLOW_SLUG,
            revisionId: null,
            scheduledFor: trigger.scheduledFor,
          },
        }
      : {
          trigger,
          occurrence: {
            kind: "manual" as const,
            requestId: `${args.briefingDate}:${slot}:${args.reason}`,
          },
        };

  const { runId } = await startRun({
    userId: args.userId,
    workflowSlug: DAILY_BRIEFING_WORKFLOW_SLUG,
    brief: `${slot} briefing for ${args.briefingDate} (${args.reason})`,
    input: {
      slot,
      reason: args.reason,
      briefingDate: args.briefingDate,
    },
    // This queue does its own fan-out, so it stamps the trigger, not `workflows.tick`.
    ...occurrence,
  });

  return { runId };
}
