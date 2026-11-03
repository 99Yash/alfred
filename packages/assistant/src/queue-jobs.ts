/**
 * BullMQ queues, declared once (ADR-0119). Server-only.
 *
 * A queue is one {@link defineQueue} call: its name, its default job options, and a catalog that
 * gives each job kind a zod schema and the dedup or job-id rule that belongs to that kind.
 * Producers get a typed `add`; the consumer gets an exhaustive handler record and the worker
 * lifecycle record that `runtime.ts` drives. The BullMQ job name is the kind, so the data does
 * not repeat it.
 */
import {
  Queue,
  Worker,
  type Job,
  type JobsOptions,
  type RepeatOptions,
  type WorkerOptions,
} from "bullmq";
import { z } from "zod";
import { createRedisConnection } from "@alfred/db/redis";
import { logger } from "@alfred/logging";

// ---------------------------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------------------------

/** One job kind: the shape of its data, and the options every job of this kind gets. */
export interface JobSpec<S extends z.ZodType> {
  readonly schema: S;
  /** Identity, delay, and retention that belong to the kind, not to each caller (ADR-0032). */
  readonly options?: (data: z.output<S>) => JobsOptions;
}

export function job<S extends z.ZodType>(
  schema: S,
  options?: (data: z.output<S>) => JobsOptions,
): JobSpec<S> {
  return options ? { schema, options } : { schema };
}

const emptyPayload = z.object({});

/** A job with no data. Only a signal can have a schedule. */
export function signal(): JobSpec<typeof emptyPayload> {
  return job(emptyPayload);
}

type Catalog = Record<string, JobSpec<z.ZodType>>;

type Input<C extends Catalog, K extends keyof C> = z.input<C[K]["schema"]>;

type Output<C extends Catalog, K extends keyof C> = z.output<C[K]["schema"]>;

/** True when the kind accepts `{}`, so `add` needs no data and a schedule can fire it. */
type AcceptsEmpty<C extends Catalog, K extends keyof C> =
  Record<string, never> extends Input<C, K> ? true : false;

/**
 * When a job runs: the one thing a caller may choose. The kind owns who the job is (job id,
 * dedup) and how long it stays (retention); the caller owns when it runs (ADR-0119 §2).
 */
export interface Timing {
  /** Milliseconds from now. Replaces a delay the kind declares. */
  readonly delay?: number;
  /** BullMQ priority: a job with none runs before any prioritized job. */
  readonly priority?: number;
}

type AddArgs<C extends Catalog, K extends keyof C> =
  AcceptsEmpty<C, K> extends true
    ? [data?: Input<C, K>, when?: Timing]
    : [data: Input<C, K>, when?: Timing];

type SignalKind<C extends Catalog> = {
  [K in keyof C & string]: AcceptsEmpty<C, K> extends true ? K : never;
}[keyof C & string];

// ---------------------------------------------------------------------------------------------
// The producer side
// ---------------------------------------------------------------------------------------------

interface QueueSpec<C extends Catalog> {
  readonly name: string;
  readonly jobs: C;
  readonly defaults: JobsOptions;
}

/** What `add` returns. Callers only read the id. */
export interface QueuedJob {
  readonly id?: string | undefined;
}

/** A job found by id: enough to read its state and to remove it, nothing else. */
export interface JobRef extends QueuedJob {
  getState(): Promise<string>;
  remove(): Promise<void>;
}

/**
 * A read-only view of the BullMQ queue, for tests and smoke scripts. Production code adds
 * through `add` and finds through `getJob`.
 */
export type QueueInspector = Pick<
  Queue,
  "name" | "getJob" | "getJobs" | "getJobCounts" | "getWorkers"
>;

export interface QueueHandle<C extends Catalog> {
  readonly name: string;
  /** Parse `data` with the kind's schema, then add it with the kind's options. */
  add<K extends keyof C & string>(kind: K, ...args: AddArgs<C, K>): Promise<QueuedJob>;
  /** The job under `jobId`, for a kind whose rule sets a job id. Fits {@link clearFinishedJob}. */
  getJob(jobId: string): Promise<JobRef | undefined>;
  /** Tests and smoke scripts only. */
  inspect(): QueueInspector;
  readonly close: () => Promise<void>;
  /** The worker for this queue. Call it from the feature's worker file, not the contract file. */
  consume(spec: ConsumerSpec<C>): BackgroundWorker;
}

/** The data a producer passes to `add` for one kind of one queue. */
export type JobInput<Q, K extends string> =
  Q extends QueueHandle<infer C> ? (K extends keyof C ? Input<C, K> : never) : never;

// ---------------------------------------------------------------------------------------------
// The consumer side
// ---------------------------------------------------------------------------------------------

/** What a handler returns. BullMQ keeps it on the job as `returnvalue`; no code reads it. */
type JobResult = object | string | number | boolean | void;

/** One handler per kind. A missing kind does not compile; an inline literal also rejects an extra kind. */
type Handlers<C extends Catalog> = {
  readonly [K in keyof C]: (
    data: Output<C, K>,
    job: Job<unknown>,
    /** Aborts when BullMQ cancels the job or the worker closes. */
    signal: AbortSignal | undefined,
  ) => Promise<JobResult>;
};

/**
 * A loop that lives beside the worker, for example a Postgres reconciler that backs up a delayed
 * job. It starts after the worker and stops before the worker closes. `start` may await a first
 * pass. A `PeriodicTask` fits.
 */
export interface Companion {
  start(): void | Promise<void>;
  /** A `PeriodicTask` returns whether its last pass finished; the worker does not read it. */
  stop(): Promise<boolean | void>;
}

interface Schedule<K extends string> {
  /** Also the scheduler id, so a reboot updates the scheduler and does not add one. */
  readonly kind: K;
  readonly repeat: Omit<RepeatOptions, "key">;
  readonly opts?: JobsOptions;
}

interface ConsumerSpec<C extends Catalog> {
  /** Log prefix `[<label>:worker]`. */
  readonly label: string;
  readonly concurrency?: number;
  /** Read at `start`. False leaves the worker and its companions off. */
  readonly enabled?: () => boolean;
  /** Stall detection, for a worker whose jobs hold a lease. */
  readonly stall?: Pick<WorkerOptions, "stalledInterval" | "maxStalledCount">;
  readonly handlers: Handlers<C>;
  readonly schedules?: ReadonlyArray<Schedule<SignalKind<C>>>;
  readonly alongside?: readonly Companion[];
}

/** A BullMQ module as `runtime.ts` drives it: one worker, its queue, and its schedules. */
export interface BackgroundWorker {
  readonly kind: "worker";
  /** Shutdown logs read `<label> worker` and `<label> queue`. */
  readonly label: string;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly repeatable?: {
    /** Write this queue's schedulers. Idempotent. */
    readonly schedule: () => Promise<void>;
    /** Remove every scheduler on this queue, so a boot with scheduled jobs off fires none. */
    readonly clear: () => Promise<number>;
  };
}

/** The part of a BullMQ `Queue` that {@link clearJobSchedulers} reads. */
interface SchedulerQueue {
  getJobSchedulers(): Promise<ReadonlyArray<{ key: string }>>;
  removeJobScheduler(key: string): Promise<boolean>;
}

/**
 * Remove every repeatable job scheduler on `queue` and return the count. BullMQ keeps schedulers
 * in Redis across restarts, so a boot that skips `schedule` still fires a prior run's crons.
 */
export async function clearJobSchedulers(queue: SchedulerQueue): Promise<number> {
  const schedulers = await queue.getJobSchedulers();

  for (const scheduler of schedulers) await queue.removeJobScheduler(scheduler.key);

  return schedulers.length;
}

export function defineQueue<const C extends Catalog>(spec: QueueSpec<C>): QueueHandle<C> {
  let queue: Queue | undefined;

  const open = (): Queue =>
    (queue ??= new Queue(spec.name, {
      connection: createRedisConnection("queue"),
      defaultJobOptions: spec.defaults,
    }));

  const isKind = (name: string): name is keyof C & string => Object.hasOwn(spec.jobs, name);

  // A generic index skips `noUncheckedIndexedAccess`; `K` is a key of `C`, so the entry exists.
  const entry = <K extends keyof C>(kind: K): C[K] => spec.jobs[kind];

  const close = async (): Promise<void> => {
    if (!queue) return;
    await queue.close();
    queue = undefined;
  };

  return {
    name: spec.name,
    close,

    async add(kind, ...[data, when]) {
      const { schema, options } = entry(kind);
      const parsed = z.parse(schema, data ?? {});

      return open().add(kind, parsed, { ...options?.(parsed), ...when });
    },

    async getJob(jobId) {
      return open().getJob(jobId);
    },

    inspect: open,

    consume(consumer) {
      let worker: Worker | undefined;
      const prefix = `[${consumer.label}:worker]`;

      // One generic step per kind keeps the schema and its handler correlated without a cast.
      const run = <K extends keyof C & string>(
        kind: K,
        job: Job<unknown>,
        signal: AbortSignal | undefined,
      ) => {
        const schema: C[K]["schema"] = entry(kind).schema;

        return consumer.handlers[kind](z.parse(schema, job.data), job, signal);
      };

      const schedules = consumer.schedules;
      const companions = consumer.alongside ?? [];

      return {
        kind: "worker",
        label: consumer.label,
        close,

        async start() {
          if (worker) return;

          if (consumer.enabled && !consumer.enabled()) return;
          worker = new Worker(
            spec.name,
            async (job: Job<unknown>, _token?: string, signal?: AbortSignal) => {
              const kind = job.name;

              // A kind this build does not know retries under `attempts`, then stays failed.
              if (!isKind(kind)) throw new Error(`${prefix} unknown job kind ${job.name}`);

              return run(kind, job, signal);
            },
            {
              ...consumer.stall,
              connection: createRedisConnection("queue"),
              concurrency: consumer.concurrency ?? 1,
            },
          );
          worker.on("error", (err) => {
            logger.error({ err }, `${prefix} error`);
          });
          // BullMQ retries a failed job silently. Without this log, an `invalid_grant` once left
          // Gmail ingestion dark for 36h with no signal.
          worker.on("failed", (failed, err) => {
            logger.error(
              { err },
              `${prefix} job failed kind=${failed?.name ?? "?"} id=${failed?.id ?? "?"} ` +
                `attempt=${failed?.attemptsMade ?? "?"}`,
            );
          });

          for (const companion of companions) await companion.start();
        },

        async stop() {
          if (!worker) return;

          for (const companion of companions) await companion.stop();
          await worker.close();
          worker = undefined;
        },

        ...(schedules && {
          repeatable: {
            async schedule() {
              for (const s of schedules) {
                await open().upsertJobScheduler(s.kind, s.repeat, {
                  name: s.kind,
                  data: z.parse(entry(s.kind).schema, {}),
                  ...(s.opts && { opts: s.opts }),
                });
              }
            },
            clear: async () => clearJobSchedulers(open()),
          },
        }),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Job-id steps
// ---------------------------------------------------------------------------------------------

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
