/**
 * The one recovery path for a carrier observe. A media job that ends its BullMQ budget, a Redis
 * restart (ADR-0108 keeps no AOF, so delayed jobs are lost) and a deferred `open` replay all leave
 * an answered ask `active`. Each pass re-runs the thread replay from Postgres rows.
 */
import { PeriodicTask } from "@alfred/assistant/realtime/periodic-task";
import { reconcileDocumentAskThreadsOnce } from "./reducer";

/** A media barrier closes at most one interval before its thread is re-run. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

const reconciler = new PeriodicTask({
  name: "document-ask-reconciler",
  intervalMs: RECONCILE_INTERVAL_MS,
  // Run at boot too, so a restart re-runs the threads that a lost job left.
  runOnStart: true,
  pass: async (signal) => {
    const tally = await reconcileDocumentAskThreadsOnce(new Date(), signal);

    if (tally.resolved > 0 || tally.failed > 0) {
      console.info(
        `[document-ask-reconciler] threads=${tally.threads} resolved=${tally.resolved} ` +
          `deferred=${tally.deferred} failed=${tally.failed}`,
      );
    }
  },
});

export function startDocumentAskReconciler(): void {
  if (!reconciler.stopped) return;
  reconciler.start();
  console.info("[document-ask-reconciler] started");
}

export async function stopDocumentAskReconciler(): Promise<void> {
  await reconciler.stop();
}
