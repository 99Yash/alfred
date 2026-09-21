/**
 * The MIME namespace (#429).
 *
 * One spelling for "what kind of thing is this file", so adapters derive a
 * card's `mediaKind` instead of hard-coding one per source. Pure module, no
 * Node imports: the boundary, the Drive adapter, the Drive action tools, and
 * the web evidence panel all read the same namespace.
 */

/**
 * Normalize a MIME type for lookup: strip `; charset=…` parameters, trim,
 * and lowercase. MIME types are case-insensitive in type and subtype
 * (RFC 2045 §5.1), and providers disagree on case, so every match below runs
 * on this form and never on the raw string.
 */
export function normalizeMimeType(mimeType: string | undefined | null): string {
  if (mimeType === undefined || mimeType === null) return "";

  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * The Google Workspace MIME namespace, e.g. `application/vnd.google-apps.document`.
 *
 * A native Workspace file has no bytes of its own: Drive holds it as editable
 * state and renders it to a format on export. Exported here because the MIME
 * table below, the Drive context source, the Drive action tools, and the web
 * evidence panel all read the same namespace — one spelling, not five.
 */
export const GOOGLE_WORKSPACE_MIME_PREFIX = "application/vnd.google-apps.";

/**
 * Every modality `mediaKindForMimeType` can read out of a MIME type.
 *
 * The function's return set, stated once so the Drive manifest cannot drift
 * from it: the full `EVIDENCE_MEDIA_KINDS` vocabulary. A page is granularity
 * rather than modality, so it rides the `page` anchor and no MIME type needs
 * to prove one. Spread this into a manifest whose cards derive `mediaKind`
 * from a MIME type rather than restating the members.
 */
export const MIME_MEDIA_KINDS = ["text", "document", "image", "audio", "video", "unknown"] as const;

export type MimeMediaKind = (typeof MIME_MEDIA_KINDS)[number];

/**
 * MIME type prefixes that name a modality on their own.
 *
 * The IANA top-level type IS the modality for these four, so a prefix test is
 * the whole rule and no member list can go stale: `image/avif` and an image
 * format nobody has registered yet both read as `image`. The prefixes are
 * disjoint, so the scan order carries no meaning.
 */
export const MEDIA_KIND_BY_TYPE_PREFIX = [
  ["image/", "image"],
  ["audio/", "audio"],
  ["video/", "video"],
  ["text/", "text"],
] as const satisfies readonly (readonly [string, MimeMediaKind])[];

/**
 * Full MIME types that carry text but do not say so in their top-level type.
 * `application/*` is the grab-bag of the MIME registry, so this half of the
 * table is a list rather than a prefix.
 */
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

/**
 * Structured-syntax suffixes (RFC 6838 §4.2.8). `application/ld+json` and
 * `image/svg+xml` are text at the byte level, but only the ones whose
 * top-level type did not already answer reach here.
 */
export const TEXTUAL_MIME_SUFFIXES = ["+json", "+xml", "+yaml"] as const;

/**
 * The modality one MIME type names (#429).
 *
 * The single owner of "what kind of thing is this file", so an adapter derives
 * a card's `mediaKind` instead of hard-coding one per source. It is a reading
 * of the TYPE, never a claim about what Alfred can extract from it: an `image`
 * answer says the record is a picture, not that an OCR lane exists. The
 * degraded-media note on the card carries that second fact.
 *
 * Its return set is {@link MIME_MEDIA_KINDS}: the full evidence vocabulary.
 *
 * `unknown` is the honest tail, and it covers two different silences on
 * purpose: a type this table does not name, and a record whose type the
 * provider never sent. Both mean "Alfred cannot say what this is", which is
 * exactly what `unknown` declares.
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
