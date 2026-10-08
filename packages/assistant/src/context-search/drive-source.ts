import {
  EVIDENCE_CITATION_LABEL_MAX_CHARS,
  EVIDENCE_CITATION_URL_MAX_CHARS,
  EVIDENCE_NOTE_MAX_CHARS,
  EVIDENCE_SNIPPET_MAX_CHARS,
  GOOGLE_WORKSPACE_MIME_PREFIX,
  MIME_MEDIA_KINDS,
  mediaKindForMimeType,
  normalizeMimeType,
  sanitizeErrorMessage,
  toMessage,
  sourceAuthorityFromManifest,
  sourceRefFromManifest,
  type BuiltInExpansionKind,
  type ContextSearchRequest,
  type EvidenceCard,
  type EvidenceExpansionHandle,
  type EvidenceMediaKind,
  type RetrievalSourceManifest,
  type SourceManifest,
} from "@alfred/contracts";
import {
  GoogleCredentialSelectionError,
  GoogleReauthRequiredError,
  type DriveFile,
} from "@alfred/integrations/google";
import { integrations } from "@alfred/integrations";
import {
  defineContextSource,
  type ContextSource,
  type ContextSourceResult,
  type ReaderDeclinedReason,
} from "./registry";

/**
 * Live Drive and Docs source (#1078, ADR-0101, ADR-0104). No local copy: every
 * read calls Drive, so a revoked share stops being evidence at once.
 * One source for both, because a Doc is a Drive file. Two would double-count it.
 * Declares `keyword_search`, not `semantic_search`: `fullText contains` matches
 * literal words only.
 */

const DRIVE_CONTEXT_SOURCE_ID = "drive";

/**
 * `typicalLatencyMs` covers the search phase only.
 * `mediaKinds` is wide on purpose: a card for an image or video still proves
 * the file exists, so dropping it would report "no such file" (#429).
 */
const DRIVE_MANIFEST_BASE: Omit<RetrievalSourceManifest, "id" | "read"> = {
  kind: "native",
  integration: "drive",
  freshness: { typical: "live" },
  authority: { level: "high", label: "the user's own file, read from Drive on this request" },
  cost: { class: "remote", typicalLatencyMs: 1_500 },
  availability: "available",
  expansionKinds: ["drive_file" satisfies BuiltInExpansionKind],
  // The adapter mints from the same set, so the two cannot drift.
  mediaKinds: [...MIME_MEDIA_KINDS],
};

const DRIVE_MANIFEST: SourceManifest = { ...DRIVE_MANIFEST_BASE, id: DRIVE_CONTEXT_SOURCE_ID };

function driveManifest(): SourceManifest {
  return DRIVE_MANIFEST;
}

/** Small, because Drive returns no relevance score to rank a wide page by. */
const DRIVE_SEARCH_PAGE_SIZE = 5;

/**
 * Files whose text the search reads inline. A card with no text has no score,
 * so the rank would cut it before the expansion phase could read it.
 * Every Drive call resolves the credential again, so keep this small.
 */
const DRIVE_INLINE_TEXT_READS = 3;

/** Terms are ANDed, so each one narrows the match. */
const DRIVE_MAX_QUERY_TERMS = 4;

/** Keeps `q3`, `v2`, `ai`. Two-letter function words are in the stop list. */
const DRIVE_MIN_TERM_CHARS = 2;

/** Question words, dropped because ANDing them matches nothing useful. Not a stemmer. */
const DRIVE_STOP_WORDS = new Set([
  "about",
  "after",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "file",
  "find",
  "for",
  "from",
  "has",
  "have",
  "he",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "out",
  "so",
  "some",
  "than",
  "that",
  "the",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "to",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/**
 * Text export per Google-native type. Sheets offers only `text/csv`. Absent
 * types (Drawings, Forms, Sites, ...) have no text export.
 */
const GOOGLE_NATIVE_TEXT_EXPORTS = new Map([
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}document`, "text/plain"],
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}presentation`, "text/plain"],
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}spreadsheet`, "text/csv"],
]);

/** Looks up the normalized form, because providers vary case and parameters. */
function nativeExportMimeType(mimeType: string): string | undefined {
  return GOOGLE_NATIVE_TEXT_EXPORTS.get(normalizeMimeType(mimeType));
}

/** Google-native containers with no text. */
const GOOGLE_NATIVE_NON_DOCUMENTS = new Set([
  `${GOOGLE_WORKSPACE_MIME_PREFIX}folder`,
  `${GOOGLE_WORKSPACE_MIME_PREFIX}shortcut`,
]);

function isGoogleNativeNonDocument(mimeType: string | undefined): boolean {
  if (mimeType === undefined) return false;

  return GOOGLE_NATIVE_NON_DOCUMENTS.has(normalizeMimeType(mimeType));
}

type TextPath = "export" | "download" | "none";

/**
 * No retry: a retry would multiply the declared latency on a path a chat turn
 * waits for. A failure degrades to the other sources.
 */
const DRIVE_READ_RETRY = "none" as const;

function driveClient(userId: string) {
  return integrations({ userId, retry: DRIVE_READ_RETRY }).google.drive;
}

type DriveClient = ReturnType<typeof driveClient>;

export function createDriveContextSource(): ContextSource {
  return defineContextSource({
    id: DRIVE_CONTEXT_SOURCE_ID,
    manifest: DRIVE_MANIFEST_BASE,
    reads: { keyword_search: readDrive, expand: expandDriveFile },
  });
}

/**
 * Search Drive, then read the text of the first few matches.
 * An account problem returns `skipped`, not an error. The catch covers the
 * whole read, because every Drive call checks the credential again.
 */
async function readDrive(
  request: ContextSearchRequest,
  signal: AbortSignal,
): Promise<ContextSourceResult> {
  const drive = driveClient(request.userId);

  let credentialId: string;

  try {
    credentialId = (await drive.credential()).id;
  } catch (error) {
    const declined = readerDeclinedReason(error);

    if (declined !== undefined) return { evidence: [], skipped: declined };

    throw error;
  }

  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");

  const q = driveQuery(request.query);

  // No usable terms. `trashed = false` alone would return recent files on any topic.
  // Not `skipped`: only the manifest reader may set those reasons.
  if (q === undefined) return { evidence: [] };

  try {
    const { files } = await drive.listFiles({
      credentialId,
      q,
      pageSize: DRIVE_SEARCH_PAGE_SIZE,
      signal,
    });

    // Backstop: the query already excludes folders and shortcuts.
    const candidates = files.filter(
      (file) => file.id.length > 0 && !isGoogleNativeNonDocument(file.mimeType),
    );

    // Parallel and bounded. `readFileText` turns a per-file failure into a note,
    // so only an abort or a dead credential rejects the batch.
    const texts = await Promise.all(
      candidates
        .slice(0, DRIVE_INLINE_TEXT_READS)
        .map((file) => readFileText(drive, credentialId, file, signal)),
    );

    const evidence = candidates.map((file, index) =>
      driveFileToEvidenceCard(
        file,
        texts[index] ?? { text: undefined, truncated: false, failure: undefined },
      ),
    );

    return { evidence };
  } catch (error) {
    // A deadline is not a skip. Rethrow so the caller reports the timeout.
    if (signal.aborted) throw error;

    const declined = readerDeclinedReason(error);

    if (declined !== undefined) return { evidence: [], skipped: declined };

    throw error;
  }
}

/** The reader-owned skip for a credential error, or `undefined` for a real failure. */
function readerDeclinedReason(error: unknown): ReaderDeclinedReason | undefined {
  if (error instanceof GoogleCredentialSelectionError) {
    return error.reason === "connection_required" ? "not-connected" : "missing-scope";
  }

  if (error instanceof GoogleReauthRequiredError) return "needs-reauth";

  return undefined;
}

/**
 * Read the text for one `drive_file` handle (#1077).
 * Returns `undefined`, which keeps the original card, for a disconnected
 * account or a file with no reachable text.
 */
async function expandDriveFile(args: {
  readonly request: ContextSearchRequest;
  readonly handle: EvidenceExpansionHandle;
  readonly signal: AbortSignal;
}): Promise<EvidenceCard | undefined> {
  const drive = driveClient(args.request.userId);

  let credentialId: string;

  try {
    credentialId = (await drive.credential()).id;
  } catch (error) {
    if (readerDeclinedReason(error) !== undefined) return undefined;

    throw error;
  }

  if (args.signal.aborted) return undefined;

  try {
    const file = await drive.getFile({
      credentialId,
      fileId: args.handle.ref,
      signal: args.signal,
    });

    if (args.signal.aborted || textPath(file.mimeType) === "none") return undefined;

    const read = await readFileText(drive, credentialId, file, args.signal);

    if (read.text === undefined) return undefined;

    return driveExpandedCard(file, read, args.handle);
  } catch (error) {
    if (readerDeclinedReason(error) !== undefined) return undefined;

    throw error;
  }
}

interface FileText {
  readonly text: string | undefined;
  readonly truncated: boolean;
  /** Sanitized provider text, when the read was attempted and failed. */
  readonly failure: string | undefined;
}

/** Read one file's text. A failure becomes a note on that card only. */
async function readFileText(
  drive: DriveClient,
  credentialId: string,
  file: DriveFile,
  signal: AbortSignal,
): Promise<FileText> {
  const path = textPath(file.mimeType);

  if (path === "none") return { text: undefined, truncated: false, failure: undefined };

  // Sheets cannot export `text/plain`.
  const exportMimeType =
    file.mimeType !== undefined ? nativeExportMimeType(file.mimeType) : undefined;

  try {
    const result =
      path === "export"
        ? await drive.exportFile({
            credentialId,
            fileId: file.id,
            mimeType: exportMimeType ?? "text/plain",
            signal,
          })
        : await drive.downloadFile({ credentialId, fileId: file.id, signal });

    const text = result.text.trim();

    if (text.length === 0) return { text: undefined, truncated: false, failure: undefined };

    return { text, truncated: result.truncated, failure: undefined };
  } catch (error) {
    // An abort is the caller's timeout, not a file failure.
    if (signal.aborted) throw error;

    // A dead credential is the source declining, not one file failing.
    if (readerDeclinedReason(error) !== undefined) throw error;

    return { text: undefined, truncated: false, failure: sanitizeErrorMessage(toMessage(error)) };
  }
}

/**
 * The card both phases share, without the handle.
 * A truncated read gets a note beside the snippet, so the model can tell a
 * partial read from a short file.
 */
function driveFileBaseCard(file: DriveFile, read: FileText): EvidenceCard {
  const manifest = driveManifest();
  const authority = sourceAuthorityFromManifest(manifest);
  const name = fileLabel(file);

  // Not always `document`: Drive also holds images, audio, and video (#429).
  const mediaKind = mediaKindForMimeType(file.mimeType);

  // Slice first so the sanitizer scans only the snippet, not the whole export.
  const snippet =
    read.text !== undefined
      ? sanitizeErrorMessage(
          read.text.slice(0, EVIDENCE_SNIPPET_MAX_CHARS),
          EVIDENCE_SNIPPET_MAX_CHARS,
        )
      : "";

  return {
    id: `${DRIVE_CONTEXT_SOURCE_ID}:${file.id}`,
    source: sourceRefFromManifest(manifest),
    mediaKind,
    ...(snippet.length > 0 ? { snippet } : {}),
    ...(snippet.length > 0
      ? read.truncated
        ? { note: truncatedNote(file) }
        : {}
      : { note: unreadNote(file, read, mediaKind) }),
    ...(authority !== undefined ? { authority } : {}),
    time: {
      // `modifiedTime` is Drive's own clock, so it needs no skew guard.
      ...(file.modifiedTime !== undefined ? { occurredAt: file.modifiedTime } : {}),
      freshness: "live",
    },
    citations: [
      {
        label: name,
        ...(file.webViewLink !== undefined &&
        file.webViewLink.length <= EVIDENCE_CITATION_URL_MAX_CHARS
          ? { url: file.webViewLink }
          : {}),
      },
    ],
  };
}

/**
 * Search-phase card. Always `live`. No `score`: Drive returns none, and the
 * ranker reads the gap as low relevance.
 */
function driveFileToEvidenceCard(file: DriveFile, read: FileText): EvidenceCard {
  const base = driveFileBaseCard(file, read);
  const name = fileLabel(file);
  const path = textPath(file.mimeType);

  // A handle only when a later read can add text.
  if (path !== "none" && base.snippet === undefined) {
    return {
      ...base,
      expansion: {
        sourceId: DRIVE_CONTEXT_SOURCE_ID,
        kind: "drive_file" satisfies BuiltInExpansionKind,
        ref: file.id,
        hint: name,
      },
    };
  }

  return base;
}

/** Expansion-phase card. It echoes the requested handle exactly, as the phase checks. */
function driveExpandedCard(
  file: DriveFile,
  read: FileText,
  handle: EvidenceExpansionHandle,
): EvidenceCard {
  const base = driveFileBaseCard(file, read);

  return {
    ...base,
    expansion: {
      sourceId: DRIVE_CONTEXT_SOURCE_ID,
      kind: handle.kind,
      ref: handle.ref,
      ...(handle.hint !== undefined ? { hint: handle.hint } : { hint: fileLabel(file) }),
    },
  };
}

/**
 * Why the card has no text: the read failed, was not paid for, or has no path.
 * Bounded, because provider error text can be long and an over-cap note fails
 * the card schema.
 */
function unreadNote(file: DriveFile, read: FileText, mediaKind: EvidenceMediaKind): string {
  const name = fileLabel(file);
  const matched = `"${name}" matched the search.`;

  let raw: string;

  if (read.failure !== undefined) {
    raw = `${matched} Reading its contents failed: ${read.failure}`;
  } else if (textPath(file.mimeType) !== "none") {
    raw = `${matched} Its contents were not read on this request.`;
  } else {
    raw = `${matched} ${noTextPathReason(file.mimeType, mediaKind)}`;
  }

  return sanitizeErrorMessage(raw, EVIDENCE_NOTE_MAX_CHARS);
}

/**
 * Exhaustive, so a new media kind fails the typecheck here.
 * `text` never reaches this branch: every text MIME type has a text path.
 */
const UNREADABLE_MEDIA_NOUNS = {
  text: undefined,
  document: "a document Drive stores as bytes rather than as editable text",
  image: "an image",
  audio: "an audio recording",
  video: "a video",
  unknown: undefined,
} satisfies Record<EvidenceMediaKind, string | undefined>;

/**
 * Why a file has no text path (#429): Drive cannot export it, Alfred has no
 * extractor yet, or Drive gave no MIME type.
 */
function noTextPathReason(mimeType: string | undefined, mediaKind: EvidenceMediaKind): string {
  if (mimeType === undefined) {
    return "Drive did not report its type, so Alfred could not choose a way to read it.";
  }

  const normalized = normalizeMimeType(mimeType);

  // Native first: a Drawing is also an `image`, but the provider limit is the stronger fact.
  if (normalized.startsWith(GOOGLE_WORKSPACE_MIME_PREFIX)) {
    return `Drive cannot export a file of this type (${mimeType}) as text.`;
  }

  const noun = UNREADABLE_MEDIA_NOUNS[mediaKind];

  if (noun !== undefined) {
    return `It is ${noun} (${mimeType}). Alfred cannot extract text from it yet, so this card carries the file itself and not its contents.`;
  }

  return `Alfred has no way to read a file of this type (${mimeType}) as text.`;
}

/** The provider cut the export at its byte cap. */
function truncatedNote(file: DriveFile): string {
  const name = fileLabel(file);

  return sanitizeErrorMessage(
    `"${name}" matched the search. Only the first part of its contents was read; the provider truncated the export.`,
    EVIDENCE_NOTE_MAX_CHARS,
  );
}

/** Bounded to the citation label limit. */
function fileLabel(file: DriveFile): string {
  const name = file.name !== undefined ? file.name.trim() : "";

  if (name.length === 0) return "Untitled file";

  return sanitizeErrorMessage(name, EVIDENCE_CITATION_LABEL_MAX_CHARS) || "Untitled file";
}

function textPath(mimeType: string | undefined): TextPath {
  const normalized = normalizeMimeType(mimeType);

  if (normalized.length === 0) return "none";

  if (GOOGLE_NATIVE_NON_DOCUMENTS.has(normalized)) return "none";

  if (normalized.startsWith(GOOGLE_WORKSPACE_MIME_PREFIX)) {
    return nativeExportMimeType(normalized) !== undefined ? "export" : "none";
  }

  // `mediaKindForMimeType` owns the text MIME rules.
  if (mediaKindForMimeType(normalized) === "text") return "download";

  return "none";
}

/**
 * Build a Drive query, or `undefined` when no term survives.
 * Terms are ANDed. Trash, folders, and shortcuts are excluded in the query.
 */
function driveQuery(query: string): string | undefined {
  const terms = queryTerms(query);

  if (terms.length === 0) return undefined;

  const clauses = terms.map((term) => `fullText contains ${driveLiteral(term)}`);

  const exclusions = [...GOOGLE_NATIVE_NON_DOCUMENTS].map(
    (mimeType) => `mimeType != ${driveLiteral(mimeType)}`,
  );

  return [...clauses, ...exclusions, "trashed = false"].join(" and ");
}

/** Longest first, because a long word is usually the specific one. */
function queryTerms(query: string): readonly string[] {
  const seen = new Set<string>();

  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < DRIVE_MIN_TERM_CHARS) continue;

    if (DRIVE_STOP_WORDS.has(raw)) continue;

    seen.add(raw);
  }

  return [...seen]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .slice(0, DRIVE_MAX_QUERY_TERMS);
}

/** Escape for Drive's quoted literal. Terms are alphanumeric today; this guards a later change. */
function driveLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
