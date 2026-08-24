/**
 * Extraction module constants — door × format limits.
 *
 * This file is the single owner for hard coded extraction limits. Logic files
 * import from here; never hard code a door or character cap inline.
 *
 * `contracts/attachments.ts` owns MIME → format (`INGEST_POLICY`). This file
 * owns format × door limits (`DOOR_LIMITS`) and the per-format factories'
 * shared preset tables. A new door adds one row here; a new format adds one
 * row in `INGEST_POLICY`, one entry in `FORMAT_REGISTRY` (`media-extraction.ts`),
 * and one row in `DOOR_LIMITS`.
 */

import { FETCH_URL_MAX_TEXT_CHARS } from "@alfred/contracts";
import type { ContentFormat } from "@alfred/contracts";

export type ExtractionDoor = "chatUpload" | "fetchUrl" | "gmailAttachment";

export interface PdfExtractionLimits {
  readonly maxBytes: number;
  readonly maxCharacters: number;
  readonly maxParseMilliseconds: number;
  /**
   * When true, output over `maxCharacters` truncates instead of returning
   * `limit_exceeded`. Absent means `false`.
   */
  readonly truncateOnOutputExceed?: boolean | undefined;
}

export type ExtractionLimits = PdfExtractionLimits;

const CHAT_PDF_EXTRACTION_CHARACTER_LIMIT = 100_000;
// `fetch_url` returns at most FETCH_URL_MAX_TEXT_CHARS characters, but
// its PDF parser may read farther so the caller can truncate an otherwise valid
// document instead of treating the output limit as an extraction failure.
// Derived from the shared tool cap so the two sides cannot drift.
const FETCH_URL_PDF_EXTRACTION_CHARACTER_LIMIT = FETCH_URL_MAX_TEXT_CHARS * 2;
// Long but valuable docs: keep as much as the 10 MB input allows, truncate
// at the limit instead of skipping the attachment.
const GMAIL_ATTACHMENT_PDF_EXTRACTION_CHARACTER_LIMIT = 1_000_000;

/**
 * Required child-process limits for each realtime PDF door.
 *
 * The byte limits differ by transport on purpose. Keeping the complete table
 * here makes a new door choose all three limits next to the extraction seam
 * instead of copying a partial policy into a leaf caller. This object is also
 * the `pdf` row of `DOOR_LIMITS` — the format-generic facade reads its pdf
 * limits from here, so a change lands once.
 */
export const REALTIME_PDF_EXTRACTION_LIMITS = {
  chatUpload: {
    maxBytes: 10 * 1024 * 1024,
    maxCharacters: CHAT_PDF_EXTRACTION_CHARACTER_LIMIT,
    maxParseMilliseconds: 30_000,
    truncateOnOutputExceed: false,
  },
  fetchUrl: {
    maxBytes: 8_000_000,
    maxCharacters: FETCH_URL_PDF_EXTRACTION_CHARACTER_LIMIT,
    maxParseMilliseconds: 30_000,
    truncateOnOutputExceed: false,
  },
  gmailAttachment: {
    maxBytes: 10 * 1024 * 1024,
    maxCharacters: GMAIL_ATTACHMENT_PDF_EXTRACTION_CHARACTER_LIMIT,
    maxParseMilliseconds: 30_000,
    truncateOnOutputExceed: true,
  },
} as const satisfies Readonly<
  Record<"chatUpload" | "fetchUrl" | "gmailAttachment", PdfExtractionLimits>
>;

/**
 * Shared office preset (docx/xlsx). Deltas other formats take are visible
 * against these three literals.
 */
export const OFFICE_LIMITS_BY_DOOR = {
  chatUpload: {
    maxBytes: 10 * 1024 * 1024,
    maxCharacters: 1_000_000,
    maxParseMilliseconds: 30_000,
    truncateOnOutputExceed: false,
  },
  fetchUrl: {
    maxBytes: 8_000_000,
    maxCharacters: 200_000,
    maxParseMilliseconds: 30_000,
    truncateOnOutputExceed: false,
  },
  gmailAttachment: {
    maxBytes: 10 * 1024 * 1024,
    maxCharacters: 1_000_000,
    maxParseMilliseconds: 30_000,
    truncateOnOutputExceed: true,
  },
} satisfies Readonly<Record<ExtractionDoor, ExtractionLimits>>;

/** Text decodes cheaply — short parse budget, smaller fetchUrl output budget. */
export const TEXT_LIMITS_BY_DOOR = {
  chatUpload: { ...OFFICE_LIMITS_BY_DOOR.chatUpload, maxParseMilliseconds: 5_000 },
  fetchUrl: {
    ...OFFICE_LIMITS_BY_DOOR.fetchUrl,
    maxCharacters: 100_000,
    maxParseMilliseconds: 5_000,
  },
  gmailAttachment: { ...OFFICE_LIMITS_BY_DOOR.gmailAttachment, maxParseMilliseconds: 5_000 },
} satisfies Readonly<Record<ExtractionDoor, ExtractionLimits>>;

/**
 * The one door-policy table. Every format × door extraction limit lives here,
 * so "what does the fetchUrl door allow?" is one read. The pdf row IS
 * `REALTIME_PDF_EXTRACTION_LIMITS` — the PDF child-process presets stay the
 * single source for their direct consumers (`fetch-url`, chat enrichment).
 * Office formats share one preset; text states only its deltas from it
 * (cheap 5s parse, smaller fetchUrl output). The `satisfies` pin makes a
 * format or door missing here a type error.
 */
export const DOOR_LIMITS = {
  pdf: REALTIME_PDF_EXTRACTION_LIMITS,
  document: OFFICE_LIMITS_BY_DOOR,
  spreadsheet: OFFICE_LIMITS_BY_DOOR,
  text: TEXT_LIMITS_BY_DOOR,
} as const satisfies Readonly<
  Record<ContentFormat, Readonly<Record<ExtractionDoor, ExtractionLimits>>>
>;
