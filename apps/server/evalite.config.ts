import { defineConfig } from "evalite/config";

export default defineConfig({
  // The briefing composer runs the boss model (gemini-2.5-pro) through a
  // multi-step tool loop up to `dump_briefing`, which is materially slower than
  // a single generate. Give each case generous headroom so a slow-but-healthy
  // run isn't killed by evalite's 30s default and misread as a failure. A
  // genuinely hung run still ends — it just gets a longer leash.
  testTimeout: 180_000,
});
