/**
 * `@alfred/assistant/connections/ingestion/internal` — the privileged friend door
 * into the raw Gmail ingestion entry points.
 *
 * The sanctioned app-facing door is the `@alfred/assistant/connections/ingestion`
 * barrel: it exposes the queue, the worker lifecycle and the watch-seeding wrapper,
 * which is how product code drives ingestion. It deliberately withholds the raw
 * per-credential entry points below, because calling one directly bypasses the
 * BullMQ job that owns retry, burst dedup and the `ingestion_state` cursor
 * bookkeeping.
 *
 * Operational scripts are the one legitimate exception: a backfill or a smoke test
 * has to drive a single credential synchronously and read the result. This file is
 * that surface — an EXPLICIT, curated, named re-export of exactly what those
 * scripts need. It is `export { … }`, never `export *`, so nothing else in
 * `gmail-ingest.ts` leaks through here; a future script symbol needs its own line
 * added below. Per ADR-0089 the barrel is the module's public interface, and this
 * file is a privileged friend door beside it, not a second public one.
 *
 * The privileged callers are operational scripts under `apps/server/src/scripts/**`
 * and the ingestion-cursor test that has to stay under the `api-tests` job
 * (`packages/api/test/gmail-ingest.test.ts`). That restriction is NOT yet
 * gate-enforced — campaign item 52 adds this subpath to the `.oxlintrc.json`
 * `no-restricted-imports` group that already fences
 * `@alfred/assistant/knowledge/internal`, and its allowlist must cover the test
 * path as well as the scripts glob, the same shape that file already uses for
 * `gmail-watch-gate.test.ts`. Until then this comment is the only guard.
 */
export {
  findCredentialsNeedingPoll,
  ingestRecentGmail,
  pollGmailHistory,
  pollGmailRecent,
  seedGmailHistoryCursorIfAbsent,
} from "./gmail-ingest";
