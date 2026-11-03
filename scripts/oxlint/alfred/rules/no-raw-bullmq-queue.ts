import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * `no-raw-bullmq-queue`: only `packages/assistant/src/queue-jobs.ts` reaches the BullMQ `Queue`
 * and `Worker` classes (ADR-0119).
 *
 * `defineQueue` is the one place that builds a queue and its worker. It parses each job with the
 * kind's schema, applies the kind's dedup and job-id rule, logs each failed job, and returns the
 * worker record that `runtime.ts` drives. A raw `new Queue` or `new Worker` skips all of it, and
 * it compiles, boots, and passes every other gate. So this rule closes the domain: no other module
 * can bind the two classes.
 *
 * What it flags, in a file that is not in OWNERS:
 * - a value import of `Queue` or `Worker` from `bullmq`, also renamed
 *   (`import { Queue as Q } from "bullmq"`);
 * - a value namespace import (`import * as bullmq from "bullmq"`), which reaches both;
 * - a value re-export of either class, or `export * from "bullmq"`, which opens a second door;
 * - a dynamic `import("bullmq")`.
 *
 * What it skips. A type import (`import type { Queue }`, `import { type Worker }`), which
 * TypeScript erases and which builds nothing. A value import of another BullMQ export, for
 * example `UnrecoverableError`, `DelayedError`, or `Job`.
 *
 * File scope. Every linted file, tests and scripts included, minus OWNERS. A test or a smoke
 * script reads a queue through the handle's `inspect()`.
 */

/** The module that owns `Queue` and `Worker`. */
const OWNERS: ReadonlySet<string> = new Set(["packages/assistant/src/queue-jobs.ts"]);

const RESTRICTED: ReadonlySet<string> = new Set(["Queue", "Worker"]);

const SOURCE = "bullmq";

/** The `/`-separated repo path of the linted file, the form OWNERS names. */
function repoPath(filename: string, cwd: string): string {
  const normalized = filename.split("\\").join("/");
  const root = `${cwd.split("\\").join("/")}/`;

  return normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
}

function nameOf(node: ESTree.IdentifierName | ESTree.IdentifierReference | ESTree.StringLiteral) {
  return node.type === "Literal" ? node.value : node.name;
}

function isBullmq(source: ESTree.StringLiteral | null | undefined): boolean {
  return source?.value === SOURCE;
}

export const noRawBullmqQueueRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Allow the BullMQ `Queue` and `Worker` classes only in `@alfred/assistant/queue-jobs`.",
    },
    messages: {
      rawQueue:
        "`{{name}}` from bullmq builds a queue or a worker outside `defineQueue`, so its jobs skip the kind's schema, its dedup and job-id rule, and the failed-job log (ADR-0119). Declare the queue with `defineQueue` from `@alfred/assistant/queue-jobs` in the feature's `queue.ts`, and build its worker with `handle.consume(...)` in `worker.ts`. A test or a script reads a queue through `handle.inspect()`. A type import (`import type { Job }`) is allowed.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return !OWNERS.has(repoPath(context.filename, context.cwd));
      },
      ImportDeclaration(node) {
        if (!isBullmq(node.source) || node.importKind === "type") return;

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            context.report({ node: specifier, messageId: "rawQueue", data: { name: "* as" } });
            continue;
          }

          if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
          const name = nameOf(specifier.imported);

          if (RESTRICTED.has(name)) {
            context.report({ node: specifier, messageId: "rawQueue", data: { name } });
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (!isBullmq(node.source) || node.exportKind === "type") return;

        for (const specifier of node.specifiers) {
          if (specifier.exportKind === "type") continue;
          const name = nameOf(specifier.local);

          if (RESTRICTED.has(name)) {
            context.report({ node: specifier, messageId: "rawQueue", data: { name } });
          }
        }
      },
      ExportAllDeclaration(node) {
        if (!isBullmq(node.source) || node.exportKind === "type") return;
        context.report({ node, messageId: "rawQueue", data: { name: "*" } });
      },
      ImportExpression(node) {
        const { source } = node;

        if (source.type === "Literal" && source.value === SOURCE) {
          context.report({ node, messageId: "rawQueue", data: { name: "import()" } });
        }
      },
    };
  },
});
