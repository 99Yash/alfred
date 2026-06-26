import { defineConfig } from "evalite/config";

export default defineConfig({
  // Raise the per-case ceiling from evalite's 30s default. The triage classifier
  // bounds each cheap-model call at totalMs: 30_000, and the triage eval retries
  // a case up to a few times on transient empty-output failures (Gemini returning
  // a 200 with no parseable object — these escape getCheapModel's withFallback,
  // see `classifyWithRetry` in triage-classify.eval.ts). Stacked worst-case that
  // exceeds 30s and trips a spurious vitest test-timeout, so give it headroom.
  // A genuinely hung run still ends — it just gets a longer leash.
  testTimeout: 120_000,
});
