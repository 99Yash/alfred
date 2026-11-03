import { RuleTester } from "oxlint/plugins-dev";

import { noRawBullmqQueueRule } from "./no-raw-bullmq-queue.ts";

// The spec of `no-raw-bullmq-queue`: only `packages/assistant/src/queue-jobs.ts` binds the BullMQ
// `Queue` and `Worker` classes (ADR-0119). A raw queue skips the kind's schema, its dedup and
// job-id rule, and the failed-job log.
//
// `pnpm check:oxlint-plugin` drives each `invalid` case without a `filename` through the root
// `.oxlintrc.json`. A case with a repo path is an owner case and runs here only.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const raw = (name: string) => ({ messageId: "rawQueue", data: { name } });

tester.run("alfred/no-raw-bullmq-queue", noRawBullmqQueueRule, {
  valid: [
    {
      name: "the owner builds the queue and the worker",
      filename: "packages/assistant/src/queue-jobs.ts",
      code: "import { Queue, Worker, type Job } from 'bullmq'; export const q = new Queue('x'); export const w = new Worker('x', async (job: Job) => job.data);",
    },
    {
      name: "a type-only import",
      code: "import type { Queue, Worker, Job } from 'bullmq'; export type Q = Queue; export type W = Worker; export type J = Job;",
    },
    {
      name: "an inline type specifier",
      code: "import { type Queue, type Worker } from 'bullmq'; export type Q = Queue | Worker;",
    },
    {
      name: "another BullMQ value",
      code: "import { UnrecoverableError, DelayedError, type Job } from 'bullmq'; export function fail(job: Job) { throw job.id ? new UnrecoverableError('x') : new DelayedError(); }",
    },
    {
      name: "a type-only re-export",
      code: "export type { Queue, Worker } from 'bullmq';",
    },
    {
      name: "a Queue from another module",
      code: "import { Queue } from './my-queue'; export const q = new Queue();",
    },
  ],
  invalid: [
    {
      name: "a value import of Queue",
      code: "import { Queue } from 'bullmq'; export const q = new Queue('x');",
      errors: [raw("Queue")],
    },
    {
      name: "a value import of Worker beside a type import",
      code: "import { Worker, type Job } from 'bullmq'; export const w = new Worker('x', async (job: Job) => job.data);",
      errors: [raw("Worker")],
    },
    {
      name: "a renamed import of both",
      code: "import { Queue as Q, Worker as W } from 'bullmq'; export const q = new Q('x'); export const w = new W('x', async () => undefined);",
      errors: [raw("Queue"), raw("Worker")],
    },
    {
      name: "a namespace import",
      code: "import * as bullmq from 'bullmq'; export const q = new bullmq.Queue('x');",
      errors: [raw("* as")],
    },
    {
      name: "a value re-export",
      code: "export { Queue } from 'bullmq';",
      errors: [raw("Queue")],
    },
    {
      name: "a star re-export",
      code: "export * from 'bullmq';",
      errors: [raw("*")],
    },
    {
      name: "a dynamic import",
      code: "export async function open() { const { Queue } = await import('bullmq'); return new Queue('x'); }",
      errors: [raw("import()")],
    },
    {
      name: "a former owner path is not an owner",
      filename: "packages/assistant/src/knowledge/queue.ts",
      code: "import { Queue } from 'bullmq'; export const q = new Queue('memory-cron');",
      errors: [raw("Queue")],
    },
  ],
});
