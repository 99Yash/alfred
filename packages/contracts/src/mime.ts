/** MIME helpers, so adapters derive a card's `mediaKind` instead of hard-coding it. */

/** Drop parameters, trim, and lowercase. MIME types are case-insensitive (RFC 2045 §5.1). */
export function normalizeMimeType(mimeType: string | undefined | null): string {
  if (mimeType === undefined || mimeType === null) return "";

  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Native Workspace files have no bytes of their own; Drive renders them on export. */
export const GOOGLE_WORKSPACE_MIME_PREFIX = "application/vnd.google-apps.";

/** What `mediaKindForMimeType` can return. A page is an anchor, not a modality. */
export const MIME_MEDIA_KINDS = ["text", "document", "image", "audio", "video", "unknown"] as const;

export type MimeMediaKind = (typeof MIME_MEDIA_KINDS)[number];

/** The top-level type is the modality here, so new subtypes need no entry. */
export const MEDIA_KIND_BY_TYPE_PREFIX = [
  ["image/", "image"],
  ["audio/", "audio"],
  ["video/", "video"],
  ["text/", "text"],
] as const satisfies readonly (readonly [string, MimeMediaKind])[];

/** `application/*` types, which do not name their modality. */
export const MEDIA_KIND_BY_FULL_TYPE: ReadonlyMap<string, MimeMediaKind> = new Map<
  string,
  MimeMediaKind
>([
  ["application/json", "text"],
  ["application/xml", "text"],
  ["application/yaml", "text"],
  ["application/x-yaml", "text"],
  ["application/pdf", "document"],
  ["application/x-pdf", "document"],
  ["application/rtf", "document"],
  ["application/msword", "document"],
  ["application/vnd.ms-excel", "document"],
  ["application/vnd.ms-powerpoint", "document"],
  ["application/vnd.oasis.opendocument.text", "document"],
  ["application/vnd.oasis.opendocument.spreadsheet", "document"],
  ["application/vnd.oasis.opendocument.presentation", "document"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "document"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "document"],
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}document`, "document"],
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}presentation`, "document"],
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}spreadsheet`, "document"],
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}drawing`, "image"],
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}photo`, "image"],
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}audio`, "audio"],
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}video`, "video"],
]);

/** Structured-syntax suffixes (RFC 6838 §4.2.8) are text. */
export const TEXTUAL_MIME_SUFFIXES = ["+json", "+xml", "+yaml"] as const;

/**
 * The modality a MIME type names, not what Alfred can extract from it.
 * `unknown` for an unlisted type and for a missing type.
 */
export function mediaKindForMimeType(mimeType: string | undefined): MimeMediaKind {
  const normalized = normalizeMimeType(mimeType);

  if (normalized.length === 0) return "unknown";

  const byFullType = MEDIA_KIND_BY_FULL_TYPE.get(normalized);

  if (byFullType !== undefined) return byFullType;

  for (const [prefix, kind] of MEDIA_KIND_BY_TYPE_PREFIX) {
    if (normalized.startsWith(prefix)) return kind;
  }

  if (TEXTUAL_MIME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return "text";

  return "unknown";
}
