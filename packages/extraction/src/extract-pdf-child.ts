import { pathToFileURL } from "node:url";

import { PdfExtractionError } from "./extract-pdf";
import { extractPdfCore } from "./extract-pdf-core";
import {
  readPdfExtractionChildRequest,
  serializePdfExtractionChildReply,
  type PdfExtractionChildReply,
} from "./extract-pdf-protocol";

function describeError(error: unknown): {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
} {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error); // drift-ok: protocol boundary
  const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
  return { name, message, ...(code === undefined ? {} : { code }) };
}

async function writeReply(reply: PdfExtractionChildReply): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(serializePdfExtractionChildReply(reply), (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

/** Run one request, write one bounded JSON reply, and return its exit code. */
export async function runPdfExtractionChild(): Promise<number> {
  let request;
  try {
    request = await readPdfExtractionChildRequest(process.stdin);
  } catch (error) {
    process.stderr.write(`Invalid PDF extraction child request: ${describeError(error).message}\n`);
    return 2;
  }

  try {
    const result = await extractPdfCore(
      request.bytes,
      request.limits.maxCharacters,
      undefined,
      request.limits.truncateOnOutputExceed ?? false,
    );
    await writeReply({ kind: "result", result });
    return 0;
  } catch (error) {
    const pdfExtractionError = error instanceof PdfExtractionError;
    // Send the original cause so the parent can rebuild the one canonical
    // PdfExtractionError message instead of accepting arbitrary message text.
    const described = describeError(pdfExtractionError ? error.cause : error);
    await writeReply({
      kind: "dependency_error",
      error: {
        source: pdfExtractionError ? "pdf_extraction" : "native_load",
        ...described,
      },
    });
    return 0;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  process.exit(await runPdfExtractionChild());
}
