/**
 * `@alfred/integrations/google/internal` — the single privileged friend door
 * into the raw Gmail watch primitive.
 *
 * The sanctioned app-facing door is the api wrapper
 * `installGmailWatchAndSeedCursor` (`@alfred/api`
 * `modules/integrations/gmail-ingest.ts`): it installs the watch AND seeds the
 * `ingestion_state` baseline `historyId` cursor in one step. A RAW
 * `installGmailWatch` call leaves the credential cursorless — the first Pub/Sub
 * push then has no baseline to diff against and the credential is invisible to
 * the poll fallback (the item-01 round-0 bug). So the raw primitive is NOT on the
 * public `@alfred/integrations/google` barrel; it lives here, behind an explicit
 * friend door.
 *
 * This file is that surface: an EXPLICIT, curated, named re-export of exactly the
 * raw primitive its two legitimate friends need. It is `export { … }`, never
 * `export *`, so nothing else in `watch.ts` leaks through here — a future friend
 * symbol needs its own line added below. Honors ADR-0089 ("one supported
 * interface per module"): the general public door is the seeding wrapper; this is
 * the one named exception.
 *
 * The "friend only" restriction is gate-enforced: an oxlint
 * `no-restricted-imports` rule in `.oxlintrc.json` forbids importing this subpath
 * from anywhere outside the two allowlisted friend files (the api wrapper and its
 * characterization test), so a route or worker reaching for the raw primitive
 * here is a red `pnpm lint`, not a silent bypass.
 */
export { installGmailWatch } from "./watch";
