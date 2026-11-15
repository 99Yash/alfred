/**
 * Friend door to raw ingestion entry points, for scripts that drive them synchronously. Calling
 * these bypasses the job's retry, dedup and cursor bookkeeping. Named exports only, never
 * `export *`. `.oxlintrc.json` limits importers to `apps/server/src/scripts/**` and
 * `packages/assistant/test/gmail-ingest.test.ts`.
 */
export { findCredentialsNeedingPoll, ingestRecentGmail, pollGmailHistory } from "./gmail-ingest";
