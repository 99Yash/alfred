import { classifyEmail, type ClassifyEmailArgs } from "@alfred/assistant/triage/classify";

/**
 * The provider-weather guards that the triage suites share. A suite never throws on these:
 * it records a skip, because a throw aborts the file and hangs the evalite reporter.
 */

/** A provider capacity error (overloaded, 429, 503). Retrying would only blow the CI time budget. */
export function isTransientOverload(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

  return /high demand|overloaded|rate.?limit|too many requests|\b429\b|\b503\b|temporarily unavailable|AI_RetryError/i.test(
    msg,
  );
}

/**
 * A 200 with no parseable object. The SDK throws above the layer `withFallback` wraps,
 * so the fallback never engages. A fresh attempt almost always parses.
 */
export function isEmptyOutput(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

  return /AI_NoOutputGeneratedError|AI_NoObjectGeneratedError|No output generated|No object generated/i.test(
    msg,
  );
}

/** Retries empty output. If every attempt is empty, it rethrows, so a real outage still shows as skips. */
const EMPTY_OUTPUT_ATTEMPTS = 3;

export async function classifyWithRetry(
  args: ClassifyEmailArgs,
): Promise<Awaited<ReturnType<typeof classifyEmail>>> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= EMPTY_OUTPUT_ATTEMPTS; attempt++) {
    try {
      return await classifyEmail(args);
    } catch (err) {
      lastErr = err;

      if (!isEmptyOutput(err) || attempt === EMPTY_OUTPUT_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  throw lastErr;
}
