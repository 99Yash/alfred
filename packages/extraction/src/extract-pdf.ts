import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  createPdfExtractionLimitResult,
  parsePdfExtractionChildReply,
  parsePdfExtractionLimits,
  pdfExtractionContentCharacterCount,
  serializePdfExtractionChildRequest,
  truncateExtractedForLimit,
} from "./extract-pdf-protocol";

export type PdfDocumentType = "text_based" | "scanned" | "image_based" | "mixed";
export type InvalidPdfCause = "not_a_pdf" | "damaged";

export interface ExtractedPdfPage {
  /** 1-indexed, always. */
  readonly pageNumber: number;
  readonly markdown: string;
  readonly needsOcr: boolean;
  readonly ocrReason?: string;
}

export type PdfExtractionLimitKind = "input_bytes" | "output_characters" | "parse_milliseconds";

export interface PdfExtractionLimits {
  readonly maxBytes: number;
  readonly maxCharacters: number;
  readonly maxParseMilliseconds: number;
  /**
   * When true, output over `maxCharacters` truncates instead of returning
   * `limit_exceeded`. Absent means `false` — the flag is optional for
   * backward compat, but canonical door presets declare it explicitly.
   */
  readonly truncateOnOutputExceed?: boolean | undefined;
}

const CHAT_PDF_EXTRACTION_CHARACTER_LIMIT = 100_000;
// `fetch_url` returns at most 100k characters, but its parser may read farther
// so the caller can truncate an otherwise valid document instead of treating
// the output limit as an extraction failure.
const FETCH_URL_PDF_EXTRACTION_CHARACTER_LIMIT = 200_000;
// Long but valuable docs: keep as much as the 10 MB input allows, truncate
// at the limit instead of skipping the attachment.
const GMAIL_ATTACHMENT_PDF_EXTRACTION_CHARACTER_LIMIT = 1_000_000;

/**
 * Required child-process limits for each realtime PDF door.
 *
 * The byte limits differ by transport on purpose. Keeping the complete table
 * here makes a new door choose all three limits next to the extraction seam
 * instead of copying a partial policy into a leaf caller. This object is also
 * the `pdf` row of `DOOR_LIMITS` (`media-extraction.ts`) — the format-generic
 * facade reads its pdf limits from here, so a change lands once.
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

export type ExtractedPdf =
  | {
      readonly kind: "extracted";
      readonly pdfType: PdfDocumentType;
      readonly pageCount: number;
      /** Citation reading. Every page number is proven by the vendor. */
      readonly pages: readonly ExtractedPdfPage[];
      readonly pagesNeedingOcr: readonly number[];
      /** Completeness reading. It overlaps `pages` and carries no page boundary. */
      readonly text: string;
    }
  | {
      readonly kind: "text_without_pages";
      readonly pdfType: PdfDocumentType;
      readonly pageCount: number;
      readonly text: string;
    }
  | {
      readonly kind: "needs_ocr";
      readonly pdfType: PdfDocumentType;
      readonly pageCount: number;
    }
  | { readonly kind: "encrypted" }
  | { readonly kind: "invalid"; readonly cause: InvalidPdfCause; readonly reason: string }
  | {
      readonly kind: "limit_exceeded";
      readonly limit: PdfExtractionLimitKind;
      readonly actual: number;
      readonly maximum: number;
      readonly message: string;
    };

export type ExtractPdf = (bytes: Uint8Array) => Promise<ExtractedPdf>;

export class PdfExtractionError extends Error {
  constructor(cause: unknown) {
    super(
      `@alfred/extraction: @firecrawl/pdf-inspector failed with an error this package does not map` +
        ` (code: ${describeErrorCode(cause)}): ${describeErrorMessage(cause)}`,
      { cause },
    );
    this.name = "PdfExtractionError";
  }
}

function describeErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) return String(error.code);
  return "none";
}

function describeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error); // drift-ok: dependency-free package
}

interface PdfExtractorChildOptions {
  readonly childEntry: URL;
  readonly env?: Readonly<Record<string, string>>;
  readonly onSpawn?: (pid: number | undefined) => void;
  readonly spawnChild?: (
    spawnDefault: () => ChildProcessWithoutNullStreams,
  ) => ChildProcessWithoutNullStreams;
  readonly killChild?: (child: ChildProcessWithoutNullStreams) => void;
}

const CHILD_HEAP_MEGABYTES = 256;
const PROTOCOL_OVERHEAD_BYTES = 1_048_576;
const STDERR_LIMIT_BYTES = 65_536;

function defaultChildEntry(): URL {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./extract-pdf-child.${extension}`, import.meta.url);
}

function sourceLoaderArguments(childEntry: URL): readonly string[] {
  if (!childEntry.pathname.endsWith(".ts")) return [];

  const arguments_: string[] = [];
  for (let index = 0; index < process.execArgv.length - 1; index += 1) {
    const flag = process.execArgv[index];
    const value = process.execArgv[index + 1];
    if ((flag === "--require" || flag === "--import") && value?.includes("/tsx/")) {
      arguments_.push(flag, value);
      index += 1;
    }
  }
  return arguments_;
}

function maximumReplyBytes(maxCharacters: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, maxCharacters * 6 + PROTOCOL_OVERHEAD_BYTES);
}

function remoteNativeError(name: string, message: string, code?: string): Error {
  const error = new Error(message);
  error.name = name;
  if (code !== undefined) {
    Object.defineProperty(error, "code", { configurable: true, enumerable: true, value: code });
  }
  return error;
}

async function runPdfExtractionChild(
  bytes: Uint8Array,
  limits: PdfExtractionLimits,
  options: PdfExtractorChildOptions,
): Promise<ExtractedPdf> {
  const startedAt = performance.now();
  const spawnDefault = () =>
    spawn(
      process.execPath,
      [
        `--max-old-space-size=${CHILD_HEAP_MEGABYTES}`,
        ...sourceLoaderArguments(options.childEntry),
        fileURLToPath(options.childEntry),
      ],
      {
        env: { ...process.env, ...options.env }, // drift-ok: child environment inheritance, not configuration reading
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  let child: ChildProcessWithoutNullStreams;
  try {
    child = options.spawnChild?.(spawnDefault) ?? spawnDefault();
  } catch (error) {
    throw new PdfExtractionError(error);
  }
  options.onSpawn?.(child.pid);

  return new Promise<ExtractedPdf>((resolve, reject) => {
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let childExitedSuccessfullyBeforeDeadline = false;
    let terminalCause:
      | { readonly kind: "deadline"; readonly actual: number }
      | { readonly kind: "process_failure"; readonly error: Error }
      | undefined;

    const killChild = () => {
      if (options.killChild === undefined) {
        child.kill("SIGKILL");
      } else {
        options.killChild(child);
      }
    };

    const stopForFailure = (error: Error) => {
      if (terminalCause !== undefined) return;
      terminalCause = { kind: "process_failure", error };
      killChild();
    };

    const childExitError = (code: number | null, signal: NodeJS.Signals | null) =>
      new Error(
        `PDF extraction child exited with code ${String(code)} and signal ${signal ?? "none"}`,
      );

    const recordExitedChildFailure = (code: number | null, signal: NodeJS.Signals | null) => {
      if (terminalCause === undefined && code === 0) {
        childExitedSuccessfullyBeforeDeadline = true;
        return;
      }
      if (terminalCause !== undefined) return;
      terminalCause = {
        kind: "process_failure",
        error: childExitError(code, signal),
      };
    };

    const stopForDeadline = () => {
      if (terminalCause === undefined) {
        terminalCause = {
          kind: "deadline",
          actual: Math.max(limits.maxParseMilliseconds, Math.ceil(performance.now() - startedAt)),
        };
      }
      killChild();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maximumReplyBytes(limits.maxCharacters)) {
        stopForFailure(new Error("PDF extraction child exceeded the bounded stdout protocol"));
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > STDERR_LIMIT_BYTES) {
        stopForFailure(new Error("PDF extraction child exceeded the bounded stderr protocol"));
      }
    });

    child.once("error", (error) => {
      stopForFailure(error);
    });

    child.once("exit", recordExitedChildFailure);

    child.stdin.once("error", (error) => {
      stopForFailure(error);
    });

    child.once("close", (code, signal) => {
      if (deadline !== undefined) clearTimeout(deadline);

      if (terminalCause?.kind === "deadline" && !childExitedSuccessfullyBeforeDeadline) {
        resolve(
          createPdfExtractionLimitResult(
            "parse_milliseconds",
            terminalCause.actual,
            limits.maxParseMilliseconds,
          ),
        );
        return;
      }

      if (terminalCause?.kind === "process_failure") {
        reject(new PdfExtractionError(terminalCause.error));
        return;
      }

      if (code !== 0) {
        reject(new PdfExtractionError(childExitError(code, signal)));
        return;
      }

      try {
        const reply = parsePdfExtractionChildReply(Buffer.concat(stdout));
        if (reply.kind === "dependency_error") {
          const cause = remoteNativeError(reply.error.name, reply.error.message, reply.error.code);
          if (reply.error.source === "native_load") {
            reject(cause);
          } else {
            reject(new PdfExtractionError(cause));
          }
          return;
        }

        const { result } = reply;
        if (
          result.kind === "limit_exceeded" &&
          (result.limit !== "output_characters" || result.maximum !== limits.maxCharacters)
        ) {
          throw new Error("PDF extraction child returned an invalid limit result");
        }

        if (terminalCause?.kind === "deadline") {
          resolve(
            createPdfExtractionLimitResult(
              "parse_milliseconds",
              terminalCause.actual,
              limits.maxParseMilliseconds,
            ),
          );
          return;
        }

        const characterCount = pdfExtractionContentCharacterCount(result);
        if (characterCount > limits.maxCharacters) {
          if (limits.truncateOnOutputExceed) {
            resolve(truncateExtractedForLimit(result, limits.maxCharacters));
          } else {
            resolve(
              createPdfExtractionLimitResult(
                "output_characters",
                characterCount,
                limits.maxCharacters,
              ),
            );
          }
        } else {
          resolve(result);
        }
      } catch (error) {
        reject(new PdfExtractionError(error));
      }
    });

    const remainingMilliseconds = limits.maxParseMilliseconds - (performance.now() - startedAt);
    if (remainingMilliseconds <= 0) {
      stopForDeadline();
      return;
    }

    deadline = setTimeout(stopForDeadline, remainingMilliseconds);
    child.stdin.end(serializePdfExtractionChildRequest(limits, bytes));
  });
}

/** Configure one door's extraction policy once. The hot call accepts only bytes. */
export function createPdfExtractor(limits: PdfExtractionLimits): ExtractPdf {
  return createPdfExtractorWithChild(limits, { childEntry: defaultChildEntry() });
}

/** @internal Deterministic child seam for process-boundary tests. */
export function createPdfExtractorWithChild(
  limits: PdfExtractionLimits,
  options: PdfExtractorChildOptions,
): ExtractPdf {
  const configuredLimits = parsePdfExtractionLimits(limits);

  return async (bytes) => {
    if (bytes.byteLength > configuredLimits.maxBytes) {
      return createPdfExtractionLimitResult(
        "input_bytes",
        bytes.byteLength,
        configuredLimits.maxBytes,
      );
    }
    return runPdfExtractionChild(bytes, configuredLimits, options);
  };
}
