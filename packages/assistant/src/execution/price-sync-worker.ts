/**
 * The daily model-price sync (ADR-0016). It runs the same sync as `pnpm db:sync-prices`, so a
 * new models.dev row reaches `model_prices` without a manual run or a deploy. It is ungated: it
 * spends no money and sends no mail, so it also runs in dev, where scheduled jobs are off.
 *
 * A failed fetch throws. BullMQ retries it under `attempts`, the worker logs each failure, and the
 * scheduler fires again the next day. The worker does not stop.
 */
import { syncModelPrices } from "@alfred/db/model-prices-sync";
import { logger } from "@alfred/logging";
import { defineQueue, signal } from "@alfred/assistant/queue-jobs";

const DAY_MS = 24 * 60 * 60 * 1000;

const priceSyncQueue = defineQueue({
  name: "price-sync",
  jobs: {
    /** Repeatable: copy changed models.dev prices into `model_prices`. */
    "metering.prices.sync": signal(),
  },
  defaults: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10 * 60_000 },
    removeOnComplete: { count: 7, age: 30 * 24 * 60 * 60 },
    removeOnFail: { count: 30, age: 90 * 24 * 60 * 60 },
  },
});

/** The `price-sync` worker and its daily schedule. */
export const priceSyncWorker = priceSyncQueue.consume({
  label: "price-sync",
  concurrency: 1,
  ungated: true,
  handlers: {
    "metering.prices.sync": async () => {
      const result = await syncModelPrices();

      logger.info(
        `[price-sync:worker] metering.prices.sync models.dev=${result.fromCatalog} ` +
          `static=${result.fromStatic} inserted=${result.inserted} unchanged=${result.unchanged}`,
      );

      return result;
    },
  },
  schedules: [{ kind: "metering.prices.sync", repeat: { every: DAY_MS } }],
});
