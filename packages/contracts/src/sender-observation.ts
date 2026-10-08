/**
 * Gmail sender shapes and a parser port (ADR-0089). `knowledge` depends on these,
 * and `triage` supplies the adapter, so `knowledge` never imports `triage`.
 */

/** One parsed `From:`/`To:`/`Cc:` token. `address` and `domain` are lowercase. */
export interface PersonToken {
  readonly address: string;
  readonly domain: string | null;
  readonly displayName: string | null;
}

/** What memory's authorship gate reads from a Gmail document's metadata. */
export interface GmailAuthorshipObservation {
  /** `isSent` or a `SENT` label. Differs on purpose from the correspondents `isSent`. */
  readonly isSent: boolean;
  readonly fromEmail: string | null;
}

/** What memory's team-graph accumulation reads from a Gmail document's metadata. */
export interface GmailCorrespondentsObservation {
  /** Ignores labels: a received doc with only a `SENT` label must stay inbound in the team graph. */
  readonly isSent: boolean;
  readonly from: PersonToken | null;
  readonly recipients: readonly PersonToken[];
}

/** `triage` implements this as `gmailSenderAdapter`. */
export interface GmailSenderParser {
  authorship(metadata: unknown): GmailAuthorshipObservation;
  correspondents(metadata: unknown): GmailCorrespondentsObservation;
}
