/**
 * Every extraction limit, per format and door. Do not hard-code a limit elsewhere.
 * A new format also needs a row in `INGEST_POLICY` (contracts) and `FORMAT_REGISTRY`.
 */

import { FETCH_URL_MAX_TEXT_CHARS } from "@alfred/contracts";
import type { ContentFormat } from "@alfred/contracts";

export type ExtractionDoor = "chatUpload" | "fetchUrl" | "gmailAttachment";

export interface ExtractionLimits {
  readonly maxBytes: number;
  readonly maxCharacters: number;
  readonly maxParseMilliseconds: number;
  /** Truncate output over `maxCharacters` instead of returning `limit_exceeded`. */
  readonly truncateOnOutputExceed?: boolean | undefined;
}

const CHAT_PDF_EXTRACTION_CHARACTER_LIMIT = 100_000;

// Parse past the `fetch_url` output cap, so the tool truncates a long PDF instead of failing it.
const FETCH_URL_PDF_EXTRACTION_CHARACTER_LIMIT = FETCH_URL_MAX_TEXT_CHARS * 2;

// Keep long attachments: truncate at the limit instead of skipping them.
const GMAIL_ATTACHMENT_PDF_EXTRACTION_CHARACTER_LIMIT = 1_000_000;

/** PDF limits per door. Also the `pdf` row of `DOOR_LIMITS`. The byte limits differ on purpose. */
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
  Record<"chatUpload" | "fetchUrl" | "gmailAttachment", ExtractionLimits>
>;

/** Limits for docx and xlsx. */
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

/** Text decodes fast, so it gets a short parse budget. */
export const TEXT_LIMITS_BY_DOOR = {
  chatUpload: { ...OFFICE_LIMITS_BY_DOOR.chatUpload, maxParseMilliseconds: 5_000 },
  fetchUrl: {
    ...OFFICE_LIMITS_BY_DOOR.fetchUrl,
    maxCharacters: 100_000,
    maxParseMilliseconds: 5_000,
  },
  gmailAttachment: { ...OFFICE_LIMITS_BY_DOOR.gmailAttachment, maxParseMilliseconds: 5_000 },
} satisfies Readonly<Record<ExtractionDoor, ExtractionLimits>>;

/** Limits for every format and door. A missing format or door is a type error. */
export const DOOR_LIMITS = {
  pdf: REALTIME_PDF_EXTRACTION_LIMITS,
  document: OFFICE_LIMITS_BY_DOOR,
  spreadsheet: OFFICE_LIMITS_BY_DOOR,
  text: TEXT_LIMITS_BY_DOOR,
} as const satisfies Readonly<
  Record<ContentFormat, Readonly<Record<ExtractionDoor, ExtractionLimits>>>
>;
