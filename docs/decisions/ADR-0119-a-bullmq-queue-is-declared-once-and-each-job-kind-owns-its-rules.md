# ADR-0119 — A BullMQ queue is declared once, and each job kind owns its schema and its dedup rule

**Status.** Accepted; slice 1 built: the `ingestion-runs` queue and the `briefing-cron` queue. The other 9 queues move in later slices. Amends ADR-0032: the dedup rule belongs to the job kind, not to the call site.

**Decision.** Each BullMQ queue is one `defineQueue({ name, defaults, jobs })` call in the `queue.ts` file of the feature that owns it. The call gives a **queue handle**. The `jobs` field is the **catalog**: it gives each **job kind** a zod schema and the job options that belong to that kind (dedup, job id, delay, retention). A producer calls `handle.add(kind, data)` and passes only the data. The consumer calls `handle.consume({ label, concurrency, handlers, schedules })` in the `worker.ts` file of the same feature. It gives one handler for each kind and gets the worker record that `runtime.ts` starts and stops. The module is `@alfred/assistant/queue-jobs`.

---

## Why

Before this change, each of the 11 queues stated the same facts in 3 to 5 places, and no check made them agree:

- **The kind was in three places.** The job data had a `kind` field that repeated the BullMQ job name. A schedule repeated it a third time.
- **A one-kind queue needed a hand-written throw.** The worker did a `switch` on `data.kind`. A union with one member, for example `{ kind: "briefing.tick" }`, does not narrow to `never`, so the code had an oxlint-disable and a throw.
- **The worker trusted Redis.** `Worker<XJobData>` is a cast of Redis JSON. Some queues parsed the data with zod. Ingestion, briefing, memory, workflows, and triage did not.
- **Other packages built payloads by hand.** `packages/http` used the raw `Queue` and wrote the ingestion payload and its dedup options itself.
- **Each caller wrote the dedup rule again.** The ADR-0032 dedup id and TTL, and the job-id rules, were options at each `add` call. Two producers of one kind could disagree, and nothing would show it.
- **Each queue had its own lifecycle.** Every queue had its own `_queue`, `_worker`, `get`, `start`, `stop`, and `close`, and `runtime.ts` put the record together again.

## Decisions

### 1. The BullMQ job name is the discriminator

`add(kind, data)` uses the kind as the BullMQ job name. The data does not carry `kind`. The worker reads `job.name` and finds the kind in the catalog. A job name that this build does not know throws a plain `Error`. The job retries under its `attempts`, then stays failed. No code retries it after that. The old `switch` did the same.

Jobs and schedulers that are already in Redis still carry `kind` in their data. The zod object schemas strip unknown keys, so the worker ignores it. `upsertJobScheduler` writes the scheduler template again at each boot.

### 2. Each job kind owns its options (amends ADR-0032)

`job(schema, options?)` declares a kind. `options` is a function of the parsed data, so a dedup id or a job id can use a field of the data. `add` takes no options argument. This is deliberate: a caller cannot change the dedup rule of a kind, and two producers of one kind always use the same rule.

ADR-0032 still decides **what** the rule is: a TTL dedup, never a static `jobId`, for a burst of pushes. This ADR decides **where** the rule is: on the catalog entry of the kind. The `gmail.poll_recent` entry holds the webhook burst dedup, and the webhook route passes only `{ credentialId, pushHistoryId }`.

`signal()` declares a kind with no data. Its schema is `z.object({})`.

### 3. Producers and the worker both parse

`add` parses the data with the schema of the kind before it adds the job. A bad payload throws at the `add` call, in the producer, and not later in the worker.

The worker parses `job.data` with the same schema before it calls the handler. A parse failure throws a `ZodError`, so the job retries under its `attempts` and then stays failed. No handler gets data that its schema did not accept.

Job types come from the schemas with `z.infer`. They stay in the feature. They are not in `@alfred/contracts`, because BullMQ is server-only and no browser code reads a job.

### 4. The handler record is exhaustive

`handlers` is a mapped type over the catalog: one handler for each kind. A missing kind does not compile. An extra kind does not compile when `handlers` is an inline object literal, as in both workers. A record passed through a variable can carry an extra key. The worker has no `switch` and no `assertNever`. A generic step keeps each schema and its handler correlated with no cast.

A handler returns `object | string | number | boolean | void`. BullMQ keeps the value as `returnvalue`. No code reads it.

### 5. The contract and the consumer are in separate files

`queue.ts` holds the handle and the catalog. `worker.ts` holds `consume(...)` and the handlers. A handler imports the code that does the work, and that code often imports the handle to add the next job. If one file held both, the imports would make a cycle. A producer in the feature imports only `queue.ts`. A producer in `packages/http` imports the feature door, which also exports the worker. That makes no cycle.

A helper that starts other work and is not a queue job stays out of `queue.ts`. For example, `enqueueBriefingRun` calls `startRun`, so it is in `briefings/run.ts`.

### 6. A schedule fires only a kind with no data

`schedules` is a list of `{ kind, repeat, opts }`. Its type accepts only a kind whose schema accepts `{}`, because a scheduler fires the same data each time. The scheduler id is the kind, so a reboot updates the scheduler and does not add a second one. The ids are the same as before this change.

`consume` returns a `BackgroundWorker` with `repeatable.schedule` and `repeatable.clear` when the queue has schedules. `runtime.ts` calls `clear` on a boot with scheduled jobs off, as before.

### 7. The worker logs every failed job

`consume` attaches an `error` log and a `failed` log to every worker: `[<label>:worker] job failed kind=… id=… attempt=…`. Before this change, only the ingestion worker logged failed jobs. Now the briefing worker logs them too.

### 8. What stays in the features

- The `isQueueEnabled()` checks. A feature decides what to do when Redis is not configured.
- The never-throw wrappers, for example `bestEffort` in the Google OAuth callback. A feature decides which failures are fatal.
- The producer helpers that other modules use as ports, for example `enqueueInboundDelivery` and `enqueueTriageRelabel`. Each one is now one `add` call.
- `clearFinishedJob`, for a kind that must revive a finished job under a static id. The handle has no `getJob` yet. The two queues that call `clearFinishedJob` (approval expiry and sub-agent join wake) need it before they move.

## Residual risk

- Nothing proves the dedup TTL of `gmail.poll_recent` with a test. The webhook test asserts the kind and the data only.
- Slice 1 did not run against Redis. A local boot with `ALFRED_RUN_SCHEDULED_JOBS=true` must show the same scheduler ids, a `briefing.tick` run, and a `gmail.poll_sweep` run.
- Until the other 9 queues move, two patterns exist. `runtime.ts` builds the record of the old queues by hand with `clearJobSchedulers`.

## Alternatives

- **Nested handles, for example `ingestion.gmail.watch.queue`.** Rejected by the owner. A flat `ingestionQueue.add("gmail.watch_install", …)` names the kind as it is in Redis and in the logs.
- **Keep `kind` in the data and parse it with a discriminated union.** Rejected. It keeps the kind in two places, and a one-kind queue still needs a hand-written throw.
- **Let a caller pass options to `add`.** Rejected. It lets two producers of one kind use different dedup rules, which is the problem of ADR-0032.
- **Put the job schemas in `@alfred/contracts`.** Rejected. No browser code reads a job, and the schemas belong to the feature that consumes them.
