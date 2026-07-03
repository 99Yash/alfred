import { defineConfig } from "evalite/config";

export default defineConfig({
  // The briefing composer runs a multi-step tool loop up to `dump_briefing`,
  // which is materially slower than a single generate. Give each case generous
  // headroom so a slow-but-healthy run isn't killed by evalite's 30s default
  // and misread as a failure. A genuinely hung run still ends — it just gets a
  // longer leash.
  testTimeout: 180_000,
  // These evals are regression gates, not dashboards. A single fabricated
  // progress claim on a machine-notification thread is the bug.
  scoreThreshold: 100,
  // The suite includes forced fallback-model cases; keep parallelism modest so
  // provider latency/rate spikes don't masquerade as product regressions.
  maxConcurrency: 2,
});
