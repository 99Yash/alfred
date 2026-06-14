export interface TaskGroupScope {
  signal: AbortSignal;
}

export type TaskFactory<T> = (scope: TaskGroupScope) => Promise<T>;

export type TaskGroupSettledResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

/**
 * Run sibling tasks under one abort scope. If any task rejects, the group
 * aborts the shared signal immediately, then waits for every task to settle
 * before returning/throwing so no child work escapes its caller's lifetime.
 */
export async function runTaskGroup<T>(
  tasks: ReadonlyArray<TaskFactory<T>>,
  opts: { signal?: AbortSignal } = {},
): Promise<T[]> {
  const settled = await settleTaskGroup(tasks, opts);
  const firstRejected = settled.find((result) => result.status === "rejected");
  if (firstRejected?.status === "rejected") throw firstRejected.reason;
  return settled.map((result) => (result as { status: "fulfilled"; value: T }).value);
}

export async function settleTaskGroup<T>(
  tasks: ReadonlyArray<TaskFactory<T>>,
  opts: { signal?: AbortSignal } = {},
): Promise<TaskGroupSettledResult<T>[]> {
  if (tasks.length === 0) return [];

  const controller = new AbortController();
  const unlink = linkAbortSignal(opts.signal, controller);
  let firstRejection: unknown;

  const running = tasks.map(async (task): Promise<T> => {
    throwIfAborted(controller.signal);
    try {
      return await task({ signal: controller.signal });
    } catch (err) {
      firstRejection ??= err;
      abortController(controller, err);
      throw err;
    }
  });

  const settled = await Promise.allSettled(running);
  unlink();

  return settled.map((result): TaskGroupSettledResult<T> => {
    if (result.status === "fulfilled") return result;
    return { status: "rejected", reason: result.reason ?? firstRejection };
  });
}

/**
 * Bounded-concurrency map with the same structured lifetime as runTaskGroup:
 * one unhandled item failure aborts the shared signal and the workers drain
 * before the error is rethrown. Callers that want best-effort processing should
 * catch per item inside `fn`.
 */
export async function mapConcurrent<T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T, scope: TaskGroupScope) => Promise<void>,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  if (items.length === 0) return;

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  let index = 0;
  await runTaskGroup(
    Array.from({ length: workerCount }, () => async (scope) => {
      while (true) {
        throwIfAborted(scope.signal);
        const current = index++;
        if (current >= items.length) return;
        await fn(items[current] as T, scope);
      }
    }),
    opts,
  );
}

function linkAbortSignal(parent: AbortSignal | undefined, controller: AbortController): () => void {
  if (!parent) return () => {};
  if (parent.aborted) {
    abortController(controller, parent.reason);
    return () => {};
  }
  const onAbort = () => abortController(controller, parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

function abortController(controller: AbortController, reason: unknown): void {
  if (!controller.signal.aborted) controller.abort(reason);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("Operation aborted");
}
