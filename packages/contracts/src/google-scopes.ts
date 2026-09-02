/**
 * The Google OAuth scope vocabulary: nine scope URLs and the feature names that
 * group them. Plain strings, browser-safe, so the integration registry
 * (`./integrations`) can name the scopes that prove a Google product is
 * connected and the web can build a `?features=` query from a typed list.
 *
 * The OAuth mechanics (identity scopes, `scopesForFeatures`, the authorize URL,
 * token exchange and refresh) stay in `@alfred/integrations/google`, which
 * re-exports every name here so no consumer changes an import.
 *
 * Per-feature Google scopes. A feature's full required set is the identity
 * scopes plus its entry in {@link GOOGLE_FEATURE_SCOPES}.
 *
 *   briefing     — gmail.readonly + calendar.readonly: open-loop orientation with calendar anchoring
 *   triage       — gmail.modify: write Alfred/<Cat> labels onto messages
 *   reply_draft  — gmail.send: outbound mail when alfred drafts on behalf
 *   calendar     — calendar.events: read events and create/update events
 *   drive        — drive: full read/write across the user's Drive
 *   docs         — documents: read + write structured Doc content (headings, tables)
 *   sheets       — spreadsheets: read + write cell ranges, create spreadsheets
 *   slides       — presentations: read + write decks, create presentations
 *
 * Triage's `gmail.modify` already implies read access, but listing
 * `gmail.readonly` separately keeps each feature's scope row honest:
 * Google's consent screen will dedupe overlapping scopes for the user.
 *
 * The Calendar and Workspace (Drive/Docs/Sheets/Slides) features live
 * alongside Gmail features because a user connects "Google" once and we
 * layer capability grants on top via `include_granted_scopes=true`.
 * Asking for `?features=docs` from the connect endpoint requests only
 * identity + docs, and Google merges it into the existing grant rather
 * than re-prompting for Gmail. The onboarding connect (no `?features`)
 * requests every feature in one consent — Alfred operates as a single
 * Production-unverified tenant (ADR-0044, amended 2026-06-08), so there is
 * no verification surface to minimize and no scope tier to dodge: the one
 * owner clicks through the unverified-app warning once and grants the lot.
 *
 * The scopes are full read/write across Gmail (`gmail.modify` + `gmail.send`),
 * Calendar (`calendar.events`), Drive (`drive`), and the Workspace editors
 * (`documents` / `spreadsheets` / `presentations`). Full `drive` already
 * covers list/download/upload of any file; the per-app editor scopes add
 * structured read/write of Docs/Sheets/Slides content. The full mailbox
 * scope (`https://mail.google.com/`, IMAP + permanent delete) is the one
 * deliberate omission — no tool needs it and it maximizes breach radius.
 *
 * Individual scope URLs are named so callers can reference a capability by
 * intent (`GMAIL_MODIFY_SCOPE`) instead of by position in a feature tuple —
 * reordering a tuple then can't silently repoint a scope check at the wrong
 * grant.
 */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
/** Full read/write Drive — list/download/upload + manage any file. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
/** Full read/write Docs — read + edit structured Doc content. */
export const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
/** Full read/write Sheets — create + edit spreadsheets. */
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
/** Full read/write Slides — create + edit presentations. */
export const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";

/**
 * The closed scope vocabulary. A registry entry's `anyOfScopes` and every
 * feature row below are checked against this tuple, so a scope URL typo is a
 * compile error rather than a credential that never reads as connected.
 */
export const GOOGLE_SCOPES = [
  GMAIL_READONLY_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_SEND_SCOPE,
  CALENDAR_READONLY_SCOPE,
  CALENDAR_EVENTS_SCOPE,
  DRIVE_SCOPE,
  DOCS_SCOPE,
  SHEETS_SCOPE,
  SLIDES_SCOPE,
] as const;
export type GoogleScope = (typeof GOOGLE_SCOPES)[number];

export const GOOGLE_FEATURE_SCOPES = {
  briefing: [GMAIL_READONLY_SCOPE, CALENDAR_READONLY_SCOPE],
  triage: [GMAIL_READONLY_SCOPE, GMAIL_MODIFY_SCOPE],
  reply_draft: [GMAIL_SEND_SCOPE],
  calendar: [CALENDAR_EVENTS_SCOPE],
  drive: [DRIVE_SCOPE],
  docs: [DOCS_SCOPE],
  sheets: [SHEETS_SCOPE],
  slides: [SLIDES_SCOPE],
} as const satisfies Record<string, readonly GoogleScope[]>;

export type GoogleFeature = keyof typeof GOOGLE_FEATURE_SCOPES;
