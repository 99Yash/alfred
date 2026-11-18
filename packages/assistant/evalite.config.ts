import { defineConfig } from "evalite/config";

export default defineConfig({
  // Each case calls the classifier and a judge. Stay inside the Cloudflare gateway rate budget.
  maxConcurrency: 1,
  // Each classifier call can take 30s, and `classifyWithRetry` retries empty output,
  // so evalite's 30s default times out healthy cases. A `code-mode-paired` case is a whole
  // chat turn with its approvals, and its own deadline is 9 minutes.
  testTimeout: 600_000,
});
