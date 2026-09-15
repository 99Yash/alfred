import {
  EVIDENCE_CITATION_LABEL_MAX_CHARS,
  EVIDENCE_CITATION_URL_MAX_CHARS,
  EVIDENCE_SNIPPET_MAX_CHARS,
  sanitizeErrorMessage,
  toMessage,
  sourceAuthorityFromManifest,
  sourceRefFromManifest,
  type BuiltInExpansionKind,
  type ContextSearchRequest,
  type EvidenceCard,
  type EvidenceExpansionHandle,
  type RetrievalSourceManifest,
  type SourceManifest,
} from "@alfred/contracts";
import { GoogleCredentialSelectionError, type DriveFile } from "@alfred/integrations/google";
import { integrations } from "@alfred/integrations";
import { defineContextSource, type ContextSource, type ContextSourceResult } from "./registry";

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
 * declares here rather than by its name.
 *
 * It names the ADR-0093 `drive` slug and therefore restates neither the display
 * name nor the host: `sourceRefFromManifest` reads both back out of
 * `INTEGRATIONS`, so renaming the integration renames the source.
 */
const DRIVE_MANIFEST_BASE: Omit<RetrievalSourceManifest, "id" | "read"> = {
  kind: "native",
  integration: "drive",
  freshness: { typical: "live" },
  authority: { level: "high", label: "the user's own file, read from Drive on this request" },
  cost: { class: "remote", typicalLatencyMs: 1_500 },
  availability: "available",
  expansionKinds: ["drive_file" satisfies BuiltInExpansionKind],
};

function driveManifest(): SourceManifest {
  return { ...DRIVE_MANIFEST_BASE, id: DRIVE_CONTEXT_SOURCE_ID };
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
 * The read cost of this source is stated exactly: one `files.list` call, plus
 * at most this many `export` or `download` calls, per Context Search read.
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

/** Shortest term worth sending. Below this a token matches almost every file. */
const DRIVE_MIN_TERM_CHARS = 3;

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
  "and",
  "any",
  "are",
  "but",
  "can",
  "did",
  "does",
  "file",
  "find",
  "for",
  "from",
  "has",
  "have",
  "how",
  "into",
  "its",
  "not",
  "our",
  "out",
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
  "was",
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

/** Google-editable types Drive can export as text. */
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";

/** Google-native types that are not documents and hold no text of their own. */
const GOOGLE_NATIVE_NON_DOCUMENTS = new Set([
  `${GOOGLE_NATIVE_PREFIX}folder`,
  `${GOOGLE_NATIVE_PREFIX}shortcut`,
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
 * A disconnected or under-scoped account returns a `skipped` result rather than
 * an error: the user has not connected Drive, which is a fact about their
 * account and not a failure of this read. `GoogleCredentialSelectionError` is
 * the typed statement of it, so the catch is narrow — every other failure is
 * still a real `error` report and is never disguised as a routine skip.
 */
async function readDrive(request: ContextSearchRequest): Promise<ContextSourceResult> {
  const drive = driveClient(request.userId);

  let credentialId: string;

  try {
    credentialId = (await drive.credential()).id;
  } catch (error) {
    if (error instanceof GoogleCredentialSelectionError) {
      return { evidence: [], skipped: "not-connected" };
    }

    throw error;
  }

  const q = driveQuery(request.query);

  // Every term was a stop word or too short to narrow anything. Asking Drive
  // for `trashed = false` alone would return the user's most recent files
  // regardless of the question, which is evidence about nothing.
  if (q === undefined) return { evidence: [] };

  const { files } = await drive.listFiles({ credentialId, q, pageSize: DRIVE_SEARCH_PAGE_SIZE });

  // A folder matches a full-text query and holds no text; it is a container,
  // not evidence. Dropping it here keeps it out of the inline-read budget too.
  const candidates = files.filter(
    (file) => file.id.length > 0 && !GOOGLE_NATIVE_NON_DOCUMENTS.has(file.mimeType ?? ""),
  );

  // Parallel on purpose, and bounded by the count above: the reads are the
  // read's latency, and running them in series would make one search cost the
  // SUM of three exports. Each settles on its own, so one unreadable file
  // cannot cost the others their text.
  const texts = await Promise.all(
    candidates
      .slice(0, DRIVE_INLINE_TEXT_READS)
      .map((file) => readFileText(drive, credentialId, file)),
  );

  const evidence = candidates.map((file, index) =>
    driveFileToEvidenceCard(file, texts[index] ?? { text: undefined, failure: undefined }),
  );

  return { evidence };
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
    if (error instanceof GoogleCredentialSelectionError) return undefined;

    throw error;
  }

  if (args.signal.aborted) return undefined;

  const file = await drive.getFile({ credentialId, fileId: args.handle.ref });

  if (args.signal.aborted || textPath(file.mimeType) === "none") return undefined;

  const read = await readFileText(drive, credentialId, file);

  if (read.text === undefined) return undefined;

  return driveFileToEvidenceCard(file, read);
}

/** What one text read produced: the text, or the reason there is none. */
interface FileText {
  readonly text: string | undefined;
  /** Sanitized provider text, when the read was attempted and failed. */
  readonly failure: string | undefined;
}

/**
 * Read one file's text by the path its MIME type allows.
 *
 * A failure is local and becomes a note on the card. This source's job is to
 * report what it found; one file Drive could not export must not cost the read
 * the four files it could.
 */
async function readFileText(
  drive: DriveClient,
  credentialId: string,
  file: DriveFile,
): Promise<FileText> {
  const path = textPath(file.mimeType);

  if (path === "none") return { text: undefined, failure: undefined };

  try {
    const result =
      path === "export"
        ? await drive.exportFile({ credentialId, fileId: file.id, mimeType: "text/plain" })
        : await drive.downloadFile({ credentialId, fileId: file.id });

    const text = result.text.trim();

    return { text: text.length > 0 ? text : undefined, failure: undefined };
  } catch (error) {
    return { text: undefined, failure: sanitizeErrorMessage(toMessage(error)) };
  }
}

/**
 * One Drive file as a canonical card.
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
  const manifest = driveManifest();
  const authority = sourceAuthorityFromManifest(manifest);
  const name = fileLabel(file);
  const path = textPath(file.mimeType);

  const snippet = read.text !== undefined ? read.text.slice(0, EVIDENCE_SNIPPET_MAX_CHARS) : "";

  return {
    id: `${DRIVE_CONTEXT_SOURCE_ID}:${file.id}`,
    source: sourceRefFromManifest(manifest),
    mediaKind: "document",
    ...(snippet.length > 0 ? { snippet } : {}),
    ...(snippet.length > 0 ? {} : { note: unreadNote(file, read, path) }),
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
    // A handle only where a later read could actually add something: the file
    // has a text path and this card does not already carry the text. A file
    // Drive can never return as text would otherwise buy a provider call on
    // every read to learn the same thing again.
    ...(path !== "none" && snippet.length === 0
      ? {
          expansion: {
            sourceId: DRIVE_CONTEXT_SOURCE_ID,
            kind: "drive_file" satisfies BuiltInExpansionKind,
            ref: file.id,
            hint: name,
          },
        }
      : {}),
  };
}

/**
 * Why this card carries no text. Three different facts, and the model has to
 * tell them apart before it concludes anything from the absence: the file has
 * no text to read, the read failed, or this read did not pay for it.
 */
function unreadNote(file: DriveFile, read: FileText, path: TextPath): string {
  const name = fileLabel(file);

  if (path === "none") {
    const kind = file.mimeType !== undefined ? ` (${file.mimeType})` : "";

    return `"${name}"${kind} matched the search. Drive cannot return its contents as text.`;
  }

  if (read.failure !== undefined) {
    return `"${name}" matched the search. Reading its contents failed: ${read.failure}`;
  }

  return `"${name}" matched the search. Its contents were not read on this request.`;
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

  if (mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) return "export";

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
 * Drive includes the trash unless it is told not to.
 */
function driveQuery(query: string): string | undefined {
  const terms = queryTerms(query);

  if (terms.length === 0) return undefined;

  const clauses = terms.map((term) => `fullText contains ${driveLiteral(term)}`);

  return `${clauses.join(" and ")} and trashed = false`;
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
