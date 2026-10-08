/**
 * Friend door to the raw `installGmailWatch`. App code uses `installGmailWatchAndSeedCursor`,
 * which also seeds the `ingestion_state` cursor; a raw call leaves the credential cursorless.
 * `.oxlintrc.json` allows this import from one file only. Use named exports, never `export *`.
 */
export { installGmailWatch } from "./watch";
