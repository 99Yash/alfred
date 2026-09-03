/**
 * The Google OAuth scope vocabulary: nine scope URLs keyed by product, and the
 * feature names that group them. Plain strings, browser-safe, so the
 * integration registry (`./integrations`) can name the scopes that prove a
 * Google product is connected and the features its connect route asks for.
 *
 * The OAuth mechanics (identity scopes, `scopesForFeatures`, the authorize URL,
 * token exchange and refresh) stay in `@alfred/integrations/google`.
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
 */

/**
 * Every scope URL, by product then grant. Callers reference a capability by
 * path (`GOOGLE_SCOPE.gmail.modify`) instead of by position in a feature
 * tuple, so reordering a tuple cannot silently repoint a scope check at the
 * wrong grant. The product keys are not integration slugs: Gmail has three
 * grants for one slug. `full` is Google's own name for a product's complete
 * read/write scope. {@link GOOGLE_SCOPES} and {@link GoogleScope} derive from
 * the leaves, so a scope URL is spelled once, here.
 */
export const GOOGLE_SCOPE = {
  gmail: {
    readonly: "https://www.googleapis.com/auth/gmail.readonly",
    modify: "https://www.googleapis.com/auth/gmail.modify",
    send: "https://www.googleapis.com/auth/gmail.send",
  },
  calendar: {
    readonly: "https://www.googleapis.com/auth/calendar.readonly",
    events: "https://www.googleapis.com/auth/calendar.events",
  },
  /** Full read/write Drive — list/download/upload + manage any file. */
  drive: { full: "https://www.googleapis.com/auth/drive" },
  /** Full read/write Docs — read + edit structured Doc content. */
  docs: { full: "https://www.googleapis.com/auth/documents" },
  /** Full read/write Sheets — create + edit spreadsheets. */
  sheets: { full: "https://www.googleapis.com/auth/spreadsheets" },
  /** Full read/write Slides — create + edit presentations. */
  slides: { full: "https://www.googleapis.com/auth/presentations" },
} as const;

type ScopeLeaves<T> = T extends string ? T : { [K in keyof T]: ScopeLeaves<T[K]> }[keyof T];

/**
 * The closed scope vocabulary: the union of every leaf in {@link GOOGLE_SCOPE}.
 * A registry entry's `anyOfScopes` and every feature row below are checked
 * against it, so a scope URL typo is a compile error rather than a credential
 * that never reads as connected.
 */
export type GoogleScope = ScopeLeaves<typeof GOOGLE_SCOPE>;

/** The nine scope URLs in product order, for callers that need the list. */
export const GOOGLE_SCOPES: readonly GoogleScope[] = Object.values(GOOGLE_SCOPE).flatMap(
  (product): readonly GoogleScope[] => Object.values(product),
);

export const GOOGLE_FEATURE_SCOPES = {
  briefing: [GOOGLE_SCOPE.gmail.readonly, GOOGLE_SCOPE.calendar.readonly],
  triage: [GOOGLE_SCOPE.gmail.readonly, GOOGLE_SCOPE.gmail.modify],
  reply_draft: [GOOGLE_SCOPE.gmail.send],
  calendar: [GOOGLE_SCOPE.calendar.events],
  drive: [GOOGLE_SCOPE.drive.full],
  docs: [GOOGLE_SCOPE.docs.full],
  sheets: [GOOGLE_SCOPE.sheets.full],
  slides: [GOOGLE_SCOPE.slides.full],
} as const satisfies Record<string, readonly GoogleScope[]>;

export type GoogleFeature = keyof typeof GOOGLE_FEATURE_SCOPES;
