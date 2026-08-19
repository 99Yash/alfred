import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createPdfExtractionLimitResult,
  parsePdfExtractionChildReply,
  parsePdfExtractionLimits,
  serializePdfExtractionChildRequest,
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
}

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
  constructor(cause: unknown, message?: string) {
    super(
      message ??
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

function returnedCharacterCount(result: ExtractedPdf): number {
  if (result.kind === "text_without_pages") return result.text.length;
  if (result.kind !== "extracted") return 0;
  return result.pages.reduce((total, page) => total + page.markdown.length, result.text.length);
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
  const startedAt = Date.now();
  const child = spawn(
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
  options.onSpawn?.(child.pid);

  return new Promise<ExtractedPdf>((resolve, reject) => {
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let deadlineActual: number | undefined;
    let processFailure: Error | undefined;

    const stopForFailure = (message: string) => {
      processFailure ??= new Error(message);
      child.kill("SIGKILL");
    };

    const deadline = setTimeout(() => {
      deadlineActual = Math.max(limits.maxParseMilliseconds, Date.now() - startedAt);
      child.kill("SIGKILL");
    }, limits.maxParseMilliseconds);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maximumReplyBytes(limits.maxCharacters)) {
        stopForFailure("PDF extraction child exceeded the bounded stdout protocol");
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > STDERR_LIMIT_BYTES) {
        stopForFailure("PDF extraction child exceeded the bounded stderr protocol");
      }
    });

    child.once("error", (error) => {
      processFailure = error;
    });

    child.stdin.once("error", (error) => {
      processFailure ??= error;
    });

    child.once("close", (code, signal) => {
      clearTimeout(deadline);

      if (deadlineActual !== undefined) {
        resolve(
          createPdfExtractionLimitResult(
            "parse_milliseconds",
            deadlineActual,
            limits.maxParseMilliseconds,
          ),
        );
        return;
      }

      if (processFailure !== undefined) {
        reject(new PdfExtractionError(processFailure));
        return;
      }

      if (code !== 0) {
        reject(
          new PdfExtractionError(
            new Error(
              `PDF extraction child exited with code ${String(code)} and signal ${signal ?? "none"}`,
            ),
          ),
        );
        return;
      }

      try {
        const reply = parsePdfExtractionChildReply(Buffer.concat(stdout));
        if (reply.kind === "dependency_error") {
          const cause = remoteNativeError(reply.error.name, reply.error.message, reply.error.code);
          if (reply.error.source === "native_load") {
            reject(cause);
          } else {
            reject(new PdfExtractionError(cause, reply.error.message));
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

        const characterCount = returnedCharacterCount(result);
        resolve(
          characterCount > limits.maxCharacters
            ? createPdfExtractionLimitResult(
                "output_characters",
                characterCount,
                limits.maxCharacters,
              )
            : result,
        );
      } catch (error) {
        reject(new PdfExtractionError(error));
      }
    });

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
