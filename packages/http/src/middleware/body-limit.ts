import { MAX_TRANSCRIBE_AUDIO_BYTES } from "@alfred/ai";
import { apiErrorResponse, Errors, MAX_ATTACHMENT_BYTES } from "@alfred/contracts";
import { Elysia } from "elysia";
import { HARD_MUTATION_LIMIT } from "../sync/constants";

/**
 * Request body caps (#1863). Elysia reads and parses a body before the `auth` macro runs, and
 * the Node adapter sets no limit, so without this an anonymous caller could send a body of any
 * size and the process would hold all of it before the 401. An `onRequest` hook runs before any
 * parse, so this is the one place that bounds every route, the Better Auth mount included.
 */

const KIB = 1024;

const MIB = 1024 * KIB;

/** Multipart boundaries, part headers and the small text fields beside the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * KIB;

/** Every JSON route without a row below. */
const DEFAULT_BODY_BYTES = 1 * MIB;

/** The schema accepts up to `HARD_MUTATION_LIMIT` mutations; this budget is per mutation. */
const REPLICACHE_MUTATION_BYTES = 8 * KIB;

/**
 * Exact paths first, then prefixes. A route not in the table gets {@link DEFAULT_BODY_BYTES},
 * so a new route is capped with no edit here.
 */
const EXACT_BODY_CAPS: ReadonlyMap<string, number> = new Map([
  ["/api/chat/attachments/upload", MAX_ATTACHMENT_BYTES + MULTIPART_OVERHEAD_BYTES],
  ["/api/chat/transcribe", MAX_TRANSCRIBE_AUDIO_BYTES + MULTIPART_OVERHEAD_BYTES],
  ["/api/replicache/push", HARD_MUTATION_LIMIT * REPLICACHE_MUTATION_BYTES],
]);

/**
 * Provider webhooks. The HMAC check needs the whole body, so the cap applies first. GitHub
 * sends push payloads of some MiB when commits carry long messages, so this is above the default.
 */
const PREFIX_BODY_CAPS: ReadonlyArray<readonly [prefix: string, bytes: number]> = [
  ["/webhooks/", 4 * MIB],
];

/** The byte cap for one request path. */
function requestBodyCap(pathname: string): number {
  const exact = EXACT_BODY_CAPS.get(pathname);

  if (exact !== undefined) return exact;

  const prefixed = PREFIX_BODY_CAPS.find(([prefix]) => pathname.startsWith(prefix));

  return prefixed ? prefixed[1] : DEFAULT_BODY_BYTES;
}

function tooLarge(cap: number) {
  return Errors.PayloadTooLargeError(`Request body is larger than ${cap} bytes.`);
}

/** Error the stream when the total passes `cap`, so a chunked body cannot grow past it. */
function countRequestBody(cap: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;

  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;

      if (total > cap) {
        controller.error(tooLarge(cap));

        return;
      }

      controller.enqueue(chunk);
    },
  });
}

/**
 * Refuse a declared oversized body with 413 before any read. A body without `Content-Length`
 * (chunked) is wrapped in a counting stream, so the parse fails when the bytes pass the cap.
 */
export function requestBodyLimit() {
  return new Elysia({ name: "request-body-limit" }).onRequest((context) => {
    const { request, set } = context;

    if (request.body === null) return undefined;

    const cap = requestBodyCap(new URL(request.url).pathname);
    const declared = request.headers.get("content-length");

    if (declared !== null) {
      const bytes = Number(declared);

      // The Node HTTP parser ends a body at its declared length, so the header is binding.
      if (Number.isFinite(bytes) && bytes <= cap) return undefined;

      const error = tooLarge(cap);
      set.status = error.statusCode;

      return apiErrorResponse(error);
    }

    // Parsers read `context.request`, so the counted request replaces it for every later step.
    // Built from the URL, not from `request`: the pipe locks the old body, and the constructor
    // refuses a `Request` input whose body is locked.
    // `duplex` is required for a stream body; the DOM `RequestInit` type does not name it.
    const init: RequestInit & { duplex: "half" } = {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      body: request.body.pipeThrough(countRequestBody(cap)),
      duplex: "half",
    };

    context.request = new Request(request.url, init);

    return undefined;
  });
}
