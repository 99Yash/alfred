import {
  EVIDENCE_CITATION_LABEL_MAX_CHARS,
  EVIDENCE_CITATION_URL_MAX_CHARS,
  EVIDENCE_NOTE_MAX_CHARS,
  EVIDENCE_SNIPPET_MAX_CHARS,
  GOOGLE_WORKSPACE_MIME_PREFIX,
  MIME_MEDIA_KINDS,
  mediaKindForMimeType,
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
 * The Drive and Docs adapter (#1078; epic #422; ADR-0101, ADR-0104).
 *
 * This is the boundary's first LIVE source: it holds no local copy and answers
 * every read by calling Drive. ADR-0104 records why Drive gets a live source
 * rather than an ingestion lane — Drive already runs the full-text index an
 * ingestion lane would rebuild, a document is edited between two reads in a way
 * a message never is, and a revoked share must stop being evidence the moment
 * it is revoked, which only a live read can promise.
 *
 * ONE source covers Drive and Docs, because a Google Doc IS a Drive file: the
 * same `files` endpoint finds it and the same `export` reads it as text. The
 * `docs` integration keeps the structural surface (headings, a document's own
 * shape) and stays an action and tool concern. Splitting this file in two would
 * put one file under two source ids and let the ranker count it twice.
 *
 * It declares `keyword_search` and not `semantic_search`, and the distinction
 * is a fact rather than modesty: `fullText contains` matches whole literal
 * words, so this source answers "the Q3 budget memo" well and "how did the
 * reorganization go" poorly. Declaring the weaker capability is what lets the
 * boundary and the reader price it correctly instead of reading an empty answer
 * as an absent document.
 *
 * The Drive ACTION tools (`packages/assistant/src/tool-runtime/internal/tools/drive.ts`)
 * are untouched and are never invoked from here. This adapter calls the same
 * read-only client those tools call, one layer below them.
 */

const DRIVE_CONTEXT_SOURCE_ID = "drive";

/**
 * What this source declares (#466).
 *
 * `authority: high` because a card carries the user's own file, exported by
 * Drive itself on this request — not a summary and not a copy. `freshness:
 * live` follows from having no local copy at all. `cost: remote` is the
 * declaration that the caller's `maxSourceCost` budget prices (#1078): this is
 * the source that made the budget necessary, and it is priced by what it
 * declares here rather than by its name. `typicalLatencyMs` budgets the
 * search phase alone — one `files.list` round trip followed by the parallel
 * text reads — not the expansion phase, which the `expand` cap and deadline
 * price separately.
 *
 * It names the ADR-0093 `drive` slug and therefore restates neither the display
 * name nor the host: `sourceRefFromManifest` reads both back out of
 * `INTEGRATIONS`, so renaming the integration renames the source.
 *
 * `mediaKinds` spreads `MIME_MEDIA_KINDS`, the return set of
 * `mediaKindForMimeType`, and the list is wide because a Drive is wide: the
 * user keeps a picture, a recording and a film beside the memo, and Drive's
 * own index matches all of them. A card for one of those is real evidence — it says the
 * file exists, under this name, changed at this instant — and the note says
 * Alfred could not read its contents. Narrowing the list to what Alfred can
 * extract would make the boundary drop those cards instead, which would report
 * "no such file" for a file the user owns (#429).
 */
const DRIVE_MANIFEST_BASE: Omit<RetrievalSourceManifest, "id" | "read"> = {
  kind: "native",
  integration: "drive",
  freshness: { typical: "live" },
  authority: { level: "high", label: "the user's own file, read from Drive on this request" },
  cost: { class: "remote", typicalLatencyMs: 1_500 },
  availability: "available",
  expansionKinds: ["drive_file" satisfies BuiltInExpansionKind],
  // The manifest cannot name a modality the adapter cannot mint, and the
  // adapter cannot mint one the manifest omits: both read MIME_MEDIA_KINDS,
  // so the two drift only by a compile error, never by a sentence.
  mediaKinds: [...MIME_MEDIA_KINDS],
};

/**
 * The manifest as cards read it: the base plus the once-stated id, built once
 * at module load rather than per card. The registry parses and freezes its own
 * copy at registration; this is the same value, and cards derive fresh
 * `source`/`authority` objects from it per card (sharing one object across
 * cards would alias them).
 */
const DRIVE_MANIFEST: SourceManifest = { ...DRIVE_MANIFEST_BASE, id: DRIVE_CONTEXT_SOURCE_ID };

function driveManifest(): SourceManifest {
  return DRIVE_MANIFEST;
}

/**
 * Files one search asks Drive for.
 *
 * Deliberately far below `CONTEXT_SEARCH_MAX_LIMIT`: this source cannot score
 * its own hits (Drive returns no relevance number), so a wide page would feed
 * the cross-source ranker a pile of undifferentiated cards that each drop the
 * `semantic` feature. A narrow page of the most recently modified matches is
 * the honest shape of what Drive can tell us.
 */
const DRIVE_SEARCH_PAGE_SIZE = 5;

/**
 * Files one search reads the TEXT of, inline.
 *
 * The search phase costs one `files.list` call plus at most this many
 * `export` or `download` calls — up to four Drive HTTP calls — and every one
 * of those calls re-resolves the credential first: the integrations root
 * memoizes client construction only and no credential is memoized below it,
 * so each Drive method re-runs `listCredentials` plus `getFreshAccessToken`
 * (about nine credential SELECTs across the search phase on the fast path).
 * The expansion phase costs more per surviving handle — one `getFile` plus
 * one text read, each with the same per-call credential resolution, on a
 * freshly built integrations root per handle — so a full read that expands
 * five cards pays up to ten more Drive calls and about twenty-five more
 * SELECTs (about fourteen HTTP calls and thirty-four SELECTs worst case).
 * `typicalLatencyMs` below budgets the search phase alone: one list round
 * trip followed by the parallel text reads.
 *
 * The inline read exists because the expansion phase cannot do this job. That
 * phase runs AFTER the rank, and a card with no text has no `score`, no
 * snippet, and nothing for the ranker to like — so a text-less Drive card is
 * exactly the card the `limit` truncates before any expansion is planned.
 * Reading the strongest few inline is what puts real evidence in front of the
 * ranker; the handle on the rest is what lets the phase reach them when they
 * survive anyway.
 */
const DRIVE_INLINE_TEXT_READS = 3;

/** Terms one Drive query carries. Each one narrows the match, so few is more. */
const DRIVE_MAX_QUERY_TERMS = 4;

/** Shortest term worth sending. Two characters keeps the identifiers that name
 * a file — `q3`, `v2`, `ai`, `h1` — while a single character still matches
 * almost every file. The two-letter function words this admits (`is`, `of`,
 * `to`, …) are stopped below instead. */
const DRIVE_MIN_TERM_CHARS = 2;

/**
 * Words dropped from a query before it becomes a Drive term.
 *
 * Every term is ANDed, so one word that appears in every document is enough to
 * match nothing useful. This is a small, deliberate list of the words a
 * question asks with rather than about; it is not a stemmer and it is not
 * language detection.
 */
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
 * The text export each Google-native type supports, keyed by full MIME type.
 *
 * Drive exports a different text MIME per type: Docs and Slides offer
 * `text/plain`, Sheets offers `text/csv`. Every other native type — Drawings
 * (images/PDF only), Forms, Scripts, Sites, video (`fileNotExportable`) —
 * has no text export, so it maps to `undefined` by absence. Sending those to
 * `export?mimeType=text/plain` fails by construction and would burn an inline
 * read on a call Drive cannot answer.
 */
const GOOGLE_NATIVE_TEXT_EXPORTS = new Map([
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}document`, "text/plain"],
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}presentation`, "text/plain"],
  [`${GOOGLE_WORKSPACE_MIME_PREFIX}spreadsheet`, "text/csv"],
]);

/**
 * The export MIME type for one Google-native MIME type, or `undefined` when
 * Drive cannot export it as text.
 */
function nativeExportMimeType(mimeType: string): string | undefined {
  return GOOGLE_NATIVE_TEXT_EXPORTS.get(mimeType);
}

/** Google-native types that are not documents and hold no text of their own. */
const GOOGLE_NATIVE_NON_DOCUMENTS = new Set([
  `${GOOGLE_WORKSPACE_MIME_PREFIX}folder`,
  `${GOOGLE_WORKSPACE_MIME_PREFIX}shortcut`,
]);

/** Non-native types whose bytes are meaningful as text. */
const TEXTUAL_UPLOAD_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
]);

/** How a file's text can be reached, or that it cannot be. */
type TextPath = "export" | "download" | "none";

/**
 * One attempt per Drive call, and no retry.
 *
 * The manifest declares a `typicalLatencyMs`, and a caller prices this source
 * against that number. A retry envelope would multiply the worst case behind
 * the declaration, on a path a chat turn waits for. A transient provider
 * failure is reported instead: the boundary degrades to the other sources'
 * evidence, which is what it exists to do, and the next read tries again.
 */
const DRIVE_READ_RETRY = "none" as const;

/** The user's Drive client, bound once per read. */
function driveClient(userId: string) {
  return integrations({ userId, retry: DRIVE_READ_RETRY }).google.drive;
}

/** What the Drive half of a user-bound integrations client looks like. */
type DriveClient = ReturnType<typeof driveClient>;

/** Build the Drive context source over the read-only Google Drive client. */
export function createDriveContextSource(): ContextSource {
  return defineContextSource({
    id: DRIVE_CONTEXT_SOURCE_ID,
    manifest: DRIVE_MANIFEST_BASE,
    reads: { keyword_search: readDrive, expand: expandDriveFile },
  });
}

/**
 * Search Drive, then read the text of the strongest few matches.
 *
 * An unusable account returns a `skipped` result rather than an error: it is a
 * fact about the user's account, not a failure of this read. The mapping keeps
 * the three facts apart because the recovery differs — no credential means
 * connect, a credential without the Drive grant means widen the grant, and a
 * dead refresh grant means reconnect — and every other failure is still a real
 * `error` report, never disguised as a routine skip.
 *
 * The catch covers the whole read, not just the credential probe: the
 * per-call token resolver revalidates ownership on every Drive call, so the
 * same selection error (and a mid-read token death) can surface from
 * `listFiles` or an export long after the probe succeeded. Catching only the
 * probe would report one fact as `skipped` on one path and `error` on another.
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

  // Every term was a stop word or too short to narrow anything. Asking Drive
  // for `trashed = false` alone would return the user's most recent files
  // regardless of the question, which is evidence about nothing — so the
  // source answers empty rather than spending a provider call. This is NOT a
  // `skipped` report: the selection-owned reasons belong to the manifest
  // reader, and a reader cannot mint them.
  if (q === undefined) return { evidence: [] };

  try {
    const { files } = await drive.listFiles({
      credentialId,
      q,
      pageSize: DRIVE_SEARCH_PAGE_SIZE,
      signal,
    });

    // A folder or shortcut matches a full-text query and holds no text; each is
    // a container, not evidence. The query already excludes both `mimeType`s
    // so they never consume page slots; this filter is the backstop for a
    // grammar the provider stops honoring.
    const candidates = files.filter(
      (file) => file.id.length > 0 && !GOOGLE_NATIVE_NON_DOCUMENTS.has(file.mimeType ?? ""),
    );

    // Parallel on purpose, and bounded by the count above: the reads are the
    // read's latency, and running them in series would make one search cost the
    // SUM of three exports. A per-file failure never rejects the batch — the
    // try/catch inside `readFileText` converts it to a note on that card — so
    // one unreadable file cannot cost the others their text. Only an abort or
    // a mid-read credential death rethrows, which fails the read by design.
    // The collect signal travels with every read, so a deadline cancels the
    // Drive fetches rather than abandoning them.
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
    // The caller's deadline is not a skip: rethrow so the collect race reports
    // the timeout instead of a routine account line.
    if (signal.aborted) throw error;

    const declined = readerDeclinedReason(error);

    if (declined !== undefined) return { evidence: [], skipped: declined };

    throw error;
  }
}

/**
 * Map a credential/reauth throw to the reader-owned skip it is, or `undefined`
 * when the throw is a real failure.
 */
function readerDeclinedReason(error: unknown): ReaderDeclinedReason | undefined {
  if (error instanceof GoogleCredentialSelectionError) {
    return error.reason === "connection_required" ? "not-connected" : "missing-scope";
  }

  if (error instanceof GoogleReauthRequiredError) return "needs-reauth";

  return undefined;
}

/**
 * Dereference one `drive_file` handle into the file's text (#1077).
 *
 * This is the second half of the inline-read budget: a card the search found
 * but could not afford to read carries a handle, and a card that survives the
 * rank is worth the round trip the search declined. The returned card declares
 * itself `live` and echoes the requested handle, as the phase requires.
 *
 * It returns `undefined` — the honest empty answer, which leaves the original
 * card in place — for a disconnected account and for a file whose text cannot
 * be reached, rather than throwing. Neither is a failure of this expansion.
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

/** What one text read produced: the text, whether it was cut short, or why not. */
interface FileText {
  readonly text: string | undefined;
  /** True when the provider cut the text at its byte cap. */
  readonly truncated: boolean;
  /** Sanitized provider text, when the read was attempted and failed. */
  readonly failure: string | undefined;
}

/**
 * Read one file's text by the path its MIME type allows.
 *
 * A failure is local and becomes a note on the card. This source's job is to
 * report what it found; one file Drive could not export must not cost the read
 * the three files it could.
 */
async function readFileText(
  drive: DriveClient,
  credentialId: string,
  file: DriveFile,
  signal: AbortSignal,
): Promise<FileText> {
  const path = textPath(file.mimeType);

  if (path === "none") return { text: undefined, truncated: false, failure: undefined };

  // The export MIME is per type: Sheets cannot export `text/plain` and every
  // non-document native type cannot export text at all (those never reach
  // here — `textPath` already returned `none` for them).
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
    // A deadline abort is the caller's, not the provider's: rethrow so the
    // collect race reports the timeout instead of minting a per-file failure
    // note about a call that was cancelled, not refused.
    if (signal.aborted) throw error;

    // A credential that died mid-read is the source declining, not one file
    // failing: rethrow so the caller reports the skip instead of minting a
    // per-file note about an account fact.
    if (readerDeclinedReason(error) !== undefined) throw error;

    return { text: undefined, truncated: false, failure: sanitizeErrorMessage(toMessage(error)) };
  }
}

/**
 * One Drive file as a canonical card, without any expansion handle.
 *
 * Shared base for both phases: everything except the handle is identical, so
 * the search and the expansion cannot drift on name, time, citation, or the
 * snippet/note distinction. The callers own the handle because the two phases
 * mean different things by it.
 *
 * The snippet is provider text, so it is stripped of poison before it is
 * minted — the packer cleans again at render time, but the card itself must
 * already be clean. A provider-truncated read carries a note ALONGSIDE the
 * snippet (the contract admits both): without it a 150,000-character document
 * and a 1,900-character one mint cards the model cannot tell apart.
 */
function driveFileBaseCard(file: DriveFile, read: FileText): EvidenceCard {
  const manifest = driveManifest();
  const authority = sourceAuthorityFromManifest(manifest);
  const name = fileLabel(file);

  // Read the modality off the file's own MIME type rather than declaring every
  // Drive card a `document` (#429). A picture, a recording and a film each
  // reach this function today, and calling all three a document told the model
  // a text it could not read was missing rather than a modality Alfred cannot
  // read at all. `mediaKindForMimeType` owns the derivation, so the vocabulary
  // is the same one every other source answers in.
  const mediaKind = mediaKindForMimeType(file.mimeType);

  // Slice before sanitizing so the poison strip scans the snippet, not the
  // whole export; the bound re-applies after the strip, which can only shorten.
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
      // Drive's own `modifiedTime` is when the file last changed, which is when
      // the underlying event happened — `occurredAt`, never `observedAt`. It is
      // Drive's clock rather than a sender's header, so it needs no skew guard.
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
 * Search-phase card.
 *
 * The card always declares `live`, because everything on it — the name, the
 * owner, the modified instant, and the text when there is any — was read from
 * Drive on this request. The `snippet` is what says whether the RECORD was
 * read: a card with text holds the file, a card with only a note holds the
 * fact that the file exists. The expansion phase reads exactly that
 * distinction, which is why the handle rides only on a card whose text can
 * still be reached.
 *
 * It carries no `score`. Drive returns no relevance number, and inventing one
 * would be the self-reported score ADR-0101 spends a registration rule closing.
 * The ranker drops the feature rather than defaulting it.
 */
function driveFileToEvidenceCard(file: DriveFile, read: FileText): EvidenceCard {
  const base = driveFileBaseCard(file, read);
  const name = fileLabel(file);
  const path = textPath(file.mimeType);

  // A handle only where a later read could actually add something: the file
  // has a text path and this card does not already carry the text. A file
  // Drive can never return as text would otherwise buy a provider call on
  // every read to learn the same thing again.
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

/**
 * Expansion-phase card.
 *
 * The handle is a required input — not a condition on the snippet — so the
 * refreshed card always echoes the requested `(kind, ref)` the phase validates
 * against. A refreshed card carries the text by construction (the caller
 * returns early when there is none), so deriving the handle from
 * `snippet.length === 0` here would drop it on every success. Echoing
 * `handle.kind`/`handle.ref` rather than re-minting from the file keeps the
 * echo exact even if the file's id and the requested ref ever differ in case.
 */
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
 * Why this card carries no text.
 *
 * Several different facts, and the model has to tell them apart before it
 * concludes anything from the absence: the read failed, this read did not pay
 * for it, or the file has no text path at all — which {@link noTextPathReason}
 * then splits again, because "no text path" covered three unrelated causes
 * under one sentence (#429).
 *
 * Every branch opens on the same clause. A Drive card with no snippet is still
 * evidence — Drive's own full-text index matched this file on this query — and
 * a note that only said what was missing invited the model to read the card as
 * a near miss rather than as a named file it can ask about or open.
 *
 * The final string is bounded to `EVIDENCE_NOTE_MAX_CHARS`: the failure half
 * is unbounded provider text (an `HttpError` message carries a 500-char body
 * summary plus the URL), and an over-cap note fails the card schema — which
 * deletes the card AND the real provider reason it was built to carry.
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
 * The noun for a modality whose bytes Alfred can name but cannot yet read.
 *
 * Exhaustive over `EvidenceMediaKind` rather than a partial map, so a new
 * modality in the enum fails the typecheck here instead of degrading in
 * silence to the generic tail sentence. `undefined` is the deliberate answer
 * for the three that cannot reach this branch:
 *
 * - `text`: a file of this kind has a `download` or `export`
 *   path, so a card with no snippet failed or went unread and took an earlier
 *   branch.
 * - `unknown`: there is no noun for a thing Alfred cannot name, which is what
 *   the generic tail sentence says instead.
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
 * Why a file has no text path, as the fact a reader can act on (#429).
 *
 * The old note said one thing — "Drive cannot return its contents as text" —
 * for three causes that differ in who would have to change for the answer to
 * change, which is exactly what a reader needs:
 *
 * - **Drive itself cannot export it.** A Form, a Site, a Script or a Drawing
 *   is Google-native with no text export; the limit is the provider's and no
 *   work on Alfred's side removes it.
 * - **Alfred has no extraction lane.** A PDF, a picture, a recording, a film.
 *   Drive would hand over the bytes; Alfred has nothing that turns those bytes
 *   into text yet. This is the one that a later slice makes false, and #429
 *   deliberately ships the honest placeholder rather than the extraction.
 * - **Drive did not say what the file is.** No MIME type came back, so neither
 *   of the two facts above is established.
 *
 * A folder and a shortcut get no branch, because neither reaches a card: the
 * query excludes both `mimeType`s, `readDrive` filters them again, and the
 * expansion returns early on a `none` text path. Were one to arrive anyway it
 * would take the Google-native branch, which states a true thing about a
 * folder.
 *
 * It states the modality rather than an OCR or a transcription promise: the
 * card says what the record IS, and says plainly that Alfred did not read it.
 */
function noTextPathReason(mimeType: string | undefined, mediaKind: EvidenceMediaKind): string {
  if (mimeType === undefined) {
    return "Drive did not report its type, so Alfred could not choose a way to read it.";
  }

  // Order matters here, and only for one type: a Drawing is an `image` AND a
  // Google-native type with no text export. The provider limit is the stronger
  // fact — it holds whatever Alfred builds later — so the native branch runs
  // first.
  if (mimeType.startsWith(GOOGLE_WORKSPACE_MIME_PREFIX)) {
    return `Drive cannot export a file of this type (${mimeType}) as text.`;
  }

  const noun = UNREADABLE_MEDIA_NOUNS[mediaKind];

  if (noun !== undefined) {
    return `It is ${noun} (${mimeType}). Alfred cannot extract text from it yet, so this card carries the file itself and not its contents.`;
  }

  return `Alfred has no way to read a file of this type (${mimeType}) as text.`;
}

/**
 * The provider cut the text at its byte cap, so the snippet is the file's
 * opening, not its whole. It rides ALONGSIDE the snippet — the one card shape
 * the contract admits both on — so the model can tell a partial read from a
 * short file. Bounded for the same schema reason as {@link unreadNote}.
 */
function truncatedNote(file: DriveFile): string {
  const name = fileLabel(file);

  return sanitizeErrorMessage(
    `"${name}" matched the search. Only the first part of its contents was read; the provider truncated the export.`,
    EVIDENCE_NOTE_MAX_CHARS,
  );
}

/** The file's display name, bounded to what a citation label may carry. */
function fileLabel(file: DriveFile): string {
  const name = file.name !== undefined ? file.name.trim() : "";

  if (name.length === 0) return "Untitled file";

  return sanitizeErrorMessage(name, EVIDENCE_CITATION_LABEL_MAX_CHARS) || "Untitled file";
}

/** How this MIME type's text can be reached, if at all. */
function textPath(mimeType: string | undefined): TextPath {
  if (mimeType === undefined) return "none";

  if (GOOGLE_NATIVE_NON_DOCUMENTS.has(mimeType)) return "none";

  if (mimeType.startsWith(GOOGLE_WORKSPACE_MIME_PREFIX)) {
    return nativeExportMimeType(mimeType) !== undefined ? "export" : "none";
  }

  if (mimeType.startsWith("text/") || TEXTUAL_UPLOAD_TYPES.has(mimeType)) return "download";

  return "none";
}

/**
 * Turn the request's free text into a Drive query, or `undefined` when nothing
 * usable survives.
 *
 * Deterministic and offline: the same question always produces the same query,
 * so two traces of one read compare. The terms are ANDed because an OR over
 * four common words matches most of a drive; the cost is that a conversational
 * question narrows to nothing, which is the `keyword_search` declaration being
 * honest rather than a defect to paper over with a model call.
 *
 * `trashed = false` is always joined on. A deleted file is not evidence, and
 * Drive includes the trash unless it is told not to. Folders and shortcuts are
 * excluded the same way: neither holds text, and filtering them in the query
 * keeps them from consuming page slots that text-bearing files would take. The
 * client-side filter in the read stays as the backstop.
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

/**
 * The search terms, longest first, capped.
 *
 * Longest first because a long word is the specific one: in "what did the
 * reorganization memo say", `reorganization` is the term that finds the file
 * and `memo` is the term that finds a hundred. The cap then keeps the AND from
 * narrowing to nothing.
 */
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

/**
 * One Drive query string literal.
 *
 * Drive's query grammar quotes a value in single quotes and escapes with a
 * backslash, so a term carrying either character must be escaped or it closes
 * the literal early and the rest of the term is parsed as grammar. The terms
 * here are already stripped to letters and digits, so this cannot fire today —
 * it stands because the stripping is one edit away from being relaxed, and a
 * query builder that trusts its own upstream is how an injection ships.
 */
function driveLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
