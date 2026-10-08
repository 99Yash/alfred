/**
 * Bound a test rendezvous so a missed signal fails fast with a name.
 * A bare `await gate.promise` hangs until the CI job timeout and hides the real failure.
 */
export function awaitGate<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  // Keep the timer referenced: an unref'd timer lets a child process exit quietly and pass.
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`test gate timed out after ${String(timeoutMs)}ms: ${label}`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
