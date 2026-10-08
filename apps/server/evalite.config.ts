import { defineConfig } from "evalite/config";

export default defineConfig({
  // The composer runs a tool loop up to `dump_briefing`. evalite's 30s default kills healthy runs.
  testTimeout: 180_000,
  // A regression gate: one fabricated progress claim is a failure.
  scoreThreshold: 100,
  // Low, so provider rate spikes do not look like regressions.
  maxConcurrency: 2,
});
