import type { BriefingSlot } from "@alfred/contracts";
import { selectEmailableUsers } from "@alfred/assistant/delivery";
import { scheduledFireTime } from "@alfred/assistant/execution";
import { settings } from "@alfred/assistant/settings";
import { inZone } from "@alfred/assistant/time";
import { logger } from "@alfred/logging";
import { resolveBriefingPreferences } from "./preferences";
import { briefingQueue } from "./queue";
import { enqueueBriefingRun } from "./run";

/**
 * The `briefing-cron` worker. The hourly `briefing.tick` schedule is written at boot; hourly is
 * enough for a daily email (ADR-0025).
 */
export const briefingWorker = briefingQueue.consume({
  label: "briefing",
  // One is enough.
  concurrency: 1,
  handlers: {
    "briefing.tick": async (_data, job) => handleTick(scheduledFireTime(job)),
  },
  schedules: [
    {
      kind: "briefing.tick",
      repeat: { every: 60 * 60 * 1000 },
      opts: {
        attempts: 2,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 24, age: 7 * 24 * 60 * 60 },
        removeOnFail: { count: 50, age: 30 * 24 * 60 * 60 },
      },
    },
  ],
});

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
      // A new bind per user per tick: the hours, the zone, and the slot flags share one load.
      const userSettings = settings({ userId: u.id });

      const [prefs, flags] = await Promise.all([
        resolveBriefingPreferences(userSettings),
        userSettings.flags(),
      ]);

      const zone = inZone(prefs.timezone);
      const localHour = zone.hour(now);
      const briefingDate = zone.day(now);

      // A disabled slot never creates a run. Unset means on (see `FeatureFlags`).
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
        logger.warn(
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
      logger.warn({ err }, `[briefing:worker] tick failed for user=${u.id}`);
    }
  }

  logger.info(
    `[briefing:worker] tick scanned=${users.length} enqueued=${enqueued} skipped=${skipped}`,
  );

  return { scanned: users.length, enqueued, skipped };
}
