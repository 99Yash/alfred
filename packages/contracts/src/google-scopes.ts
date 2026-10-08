/**
 * Google scope URLs and the features that group them. The OAuth mechanics live
 * in `@alfred/integrations/google`.
 *
 * A user connects Google once. Later features add scopes with
 * `include_granted_scopes=true`, and onboarding asks for all of them (ADR-0044).
 * `https://mail.google.com/` is left out on purpose: no tool needs it, and it
 * allows permanent delete.
 */

/** Every scope URL, by product then grant. Product keys are not integration slugs. */
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
  drive: { full: "https://www.googleapis.com/auth/drive" },
  docs: { full: "https://www.googleapis.com/auth/documents" },
  sheets: { full: "https://www.googleapis.com/auth/spreadsheets" },
  slides: { full: "https://www.googleapis.com/auth/presentations" },
} as const;

type ScopeLeaves<T> = T extends string ? T : { [K in keyof T]: ScopeLeaves<T[K]> }[keyof T];

/** Typing scopes with this turns a URL typo into a compile error. */
export type GoogleScope = ScopeLeaves<typeof GOOGLE_SCOPE>;

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
