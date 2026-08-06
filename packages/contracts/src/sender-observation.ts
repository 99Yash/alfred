/**
 * Neutral, provider-agnostic Gmail sender *observation* shapes + parser port
 * (campaign knowledge-settings-phase4 item 04, ADR-0089).
 *
 * `knowledge` (formerly `memory`) must not import `triage`'s Gmail `From:`/SENT
 * parsers directly — that static edge is the `memory ↔ triage` cycle. Instead
 * memory depends only on these browser-safe data shapes plus a small parser
 * PORT (`GmailSenderParser`); `triage` owns the concrete adapter and the
 * composition roots inject it, so no `memory → triage` edge exists. The compiler
 * pins the SHAPE here; the characterization net pins that the values came from
 * the canonical triage parser.
 */

/** One correspondent parsed from a Gmail `From:`/`To:`/`Cc:` header token. */
export interface PersonToken {
  /** Normalized lowercase `local@domain`. */
  readonly address: string;
  /** Normalized lowercase domain, or null when unparseable. */
  readonly domain: string | null;
  /** Display-name part of a `Name <addr>` token, or null for a bare address. */
  readonly displayName: string | null;
}

/** What memory's authorship gate reads from a Gmail document's metadata. */
export interface GmailAuthorshipObservation {
  /**
   * `isSentGmailMetadata`: `metadata.isSent === true` OR a `"SENT"` labelId.
   * DELIBERATELY divergent from {@link GmailCorrespondentsObservation.isSent} —
   * this one is labelId-aware.
   */
  readonly isSent: boolean;
  /** Normalized lowercase `local@domain` from the `From:` header, or null. */
  readonly fromEmail: string | null;
}

/** What memory's team-graph accumulation reads from a Gmail document's metadata. */
export interface GmailCorrespondentsObservation {
  /**
   * True only when `metadata.isSent === true` — IGNORES labelIds, unlike
   * {@link GmailAuthorshipObservation.isSent}. This divergence is load-bearing
   * (see the campaign-04 seam test): a SENT-labelId-only received doc must stay
   * inbound in the team graph, not flip to outbound-from-self.
   */
  readonly isSent: boolean;
  readonly from: PersonToken | null;
  readonly recipients: readonly PersonToken[];
}

/**
 * The parser PORT `memory` depends on. `triage` owns the concrete adapter
 * (`gmailSenderAdapter`); composition roots inject it so no `memory → triage`
 * edge exists. Item 07's `knowledge.observe(observation)` makes the adapter the
 * sole caller-side parse seam.
 */
export interface GmailSenderParser {
  authorship(metadata: unknown): GmailAuthorshipObservation;
  correspondents(metadata: unknown): GmailCorrespondentsObservation;
}
