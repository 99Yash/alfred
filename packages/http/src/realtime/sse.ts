/**
 * The Server-Sent Events framing every SSE route in this package shares.
 *
 * Two routes push over SSE — `/api/events` and `/api/replicache/events` — and
 * both had written the same six things by hand: a `TextEncoder`, an enqueue
 * that swallows the throw from a stream the client already dropped, the
 * `": connected"` prelude, a 30 s heartbeat comment, the headers that make a
 * response a stream, and the `cancel()` -> teardown wiring. Only the frames
 * differ, so only the frames stay in the routes.
 *
 * The primitive owns the whole transport-visible surface: a route names the
 * PARTS of a frame (`id`, `event`, `data`) and never spells the wire format,
 * and there is no door for caller-supplied response headers, so no route can
 * replace `Content-Type` or diverge on the proxy-buffering posture below.
 */

import { toMessage } from "@alfred/contracts";
import type { EventKind } from "@alfred/contracts/events";

/** How often a stream writes a comment frame to keep the connection warm. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Sent by the server as soon as the stream opens, before the route writes
 * anything. A comment frame, so no `EventSource` listener sees it — it exists
 * to flush response headers through any intermediary that buffers until the
 * first byte.
 */
const CONNECTED_PRELUDE = ": connected\n\n";

/**
 * The response headers that make a body an event stream. Four fixed names, so
 * this is the closed set rather than a dictionary a caller could extend.
 *
 * `Headers` and not a record: header names are case-insensitive and the
 * platform type is the one that knows it. A record hands `new Response` a
 * shape whose keys it must fold, which is how a differently-cased entry
 * becomes a second entry and then one comma-joined value.
 *
 * A fresh instance per response, because `Headers` is mutable: one shared
 * instance would let anything that touched a response leak the edit into every
 * later one.
 *
 * `X-Accel-Buffering` is here because nginx and friends buffer a response body
 * by default, which holds every frame until the buffer fills. No SSE route can
 * ever WANT that — buffering is the thing SSE exists to defeat — so the posture
 * is stated once here rather than per route, where it could only ever be set
 * wrong. It is read by nothing in the current deployment: the API service is
 * not behind this repository's `Caddyfile`, which serves the web SPA only, and
 * Railway's own edge proxy is what fronts the API. It is defence against an
 * intermediary that does not exist yet.
 */
function createSseHeaders(): Headers {
  return new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/**
 * Every event name a route in this package may send. Closed on purpose.
 *
 * An SSE frame ends at a blank line, so a name holding a line break would
 * terminate the frame early and let the payload write a second frame of its own.
 * A closed union of literals cannot express such a name, so the compiler rejects
 * it at the call site and `frame()` needs no run-time check — which is what lets
 * `frame()` throw for no input at all. `SseConnection.frame` is called from
 * inside a bus listener (`realtime/events.ts`), where a throw would abort the
 * dispatch and take the other subscribers with it.
 *
 * The two names come from the two live producers: `EventKind` covers every
 * `EventFrame.kind` that `realtime/events.ts` forwards, and `"poke"` is the
 * literal `sync/replicache.ts` sends. A future route that wants a name outside
 * this set must ADD its literal here, or re-open sanitisation deliberately. It
 * must not widen the field back to `string`, which is the door this union exists
 * to close.
 *
 * Package-internal: `src/index.ts` re-exports nothing from this module.
 */
export type SseEventName = EventKind | "poke";

/** One SSE frame, as its parts rather than as wire text. */
export interface SseFrame {
  /**
   * Advances the client's `Last-Event-ID`. Omitted frames leave it alone.
   *
   * `| undefined` and not the narrow optional: `frame()` branches on
   * `!== undefined`, so an absent field and a present `undefined` mean the same
   * thing here. The narrow form is for a field whose ABSENCE is load-bearing,
   * and it would push the first route holding an `id: number | undefined` into
   * a conditional spread that buys nothing.
   */
  id?: number | undefined;
  /**
   * Selects the client listener. Omitted frames go to the `message` listener.
   * A closed union rather than `string`, so no frame can carry a name that ends
   * the frame early — see `SseEventName`.
   */
  event?: SseEventName | undefined;
  /** The payload. Newlines are re-emitted as SSE continuation lines. */
  data: string;
}

/** The stream, as the route that opened it sees it. */
export interface SseConnection {
  /**
   * Write one frame. The wire format is not the caller's problem: this emits
   * `id:` and `event:` only when they are present, splits `data` across
   * continuation lines when it contains a line break, and always terminates
   * the frame with the blank line that makes a client dispatch it.
   *
   * A write never throws. A stream the client has already dropped is a no-op,
   * because a poke or a heartbeat that races the disconnect is normal and must
   * not become an unhandled rejection; and a name that would end the frame
   * early cannot arrive, because `event` admits only the closed set of literals
   * in `SseEventName`. Both halves matter to the same caller: `realtime/events.ts`
   * writes frames from inside a bus listener, where any throw would abort the
   * dispatch for every other subscriber on that emit.
   */
  frame(frame: SseFrame): void;
  /**
   * Write an id-only frame. This advances the client's `Last-Event-ID` and
   * dispatches NO event, which is what a route wants after skipping rows it
   * chose not to send: the reconnect asks for the next page instead of the
   * same one forever.
   */
  cursor(id: number): void;
  /**
   * Register teardown — unsubscribing a bus listener, typically. A function
   * registered while the stream is still open runs exactly once, whether the
   * client cancelled, the route called `close()`, or `open` threw or rejected,
   * and never twice. One registered after teardown has already run — an `open`
   * that awaits a subscribe, and a client that disconnects inside that await —
   * runs immediately instead, so a late registration cannot strand its
   * subscription. A handler that throws is logged and does not stop the
   * others.
   */
  defer(cleanup: () => void): void;
  /** Run teardown, then close the stream. Idempotent. */
  close(): void;
}

/**
 * Build an SSE `Response`. `open` receives the connection and writes frames to
 * it; it may be async, and the heartbeat is already armed before it runs, so a
 * slow open does not stall the keep-alive.
 *
 * Teardown runs on every exit from `open`, including both throw shapes. The
 * two shapes differ in what the CLIENT sees, and only in that:
 *
 *   - `open` throws synchronously: the throw leaves `new ReadableStream` and
 *     this function, reaching the route handler and so the error middleware.
 *     The client gets 500 and no stream.
 *   - `open` REJECTS: the response headers are already committed by then, so
 *     the client gets 200 with a body that errors immediately. Awaiting `open`
 *     before returning would restore the 500 and is deliberately not done — it
 *     would hold the headers until the route finished its replay, which is
 *     exactly what `CONNECTED_PRELUDE` exists to prevent.
 *
 * The heartbeat timer is `unref`'d: a per-connection ref'd interval holds the
 * Node event loop open for as long as a browser tab is open, which delays
 * every graceful shutdown by up to one heartbeat per live client.
 */
export function sseResponse(open: (conn: SseConnection) => void | Promise<void>): Response {
  const encoder = new TextEncoder();
  // Assigned by `start`, read by `cancel`. It must be declared above the
  // stream: `new ReadableStream(...)` runs `start` synchronously, so a
  // declaration below the constructor is read inside its own temporal dead
  // zone and throws.
  let teardown: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const cleanups: Array<() => void> = [];
      let tornDown = false;

      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // stream already closed
        }
      };

      const heartbeat = setInterval(() => {
        write(": heartbeat\n\n");
      }, HEARTBEAT_INTERVAL_MS);
      if (typeof heartbeat === "object" && "unref" in heartbeat) {
        heartbeat.unref();
      }

      const runTeardown = () => {
        if (tornDown) return;
        tornDown = true;
        clearInterval(heartbeat);
        for (const fn of cleanups) {
          // One route's failing unsubscribe must not strand the next route's.
          // The whole reason teardown is a LIST is that a later adopter
          // registers a second handler beside the first.
          try {
            fn();
          } catch (err) {
            console.warn("[sse] teardown handler threw", toMessage(err));
          }
        }
      };

      teardown = runTeardown;

      const conn: SseConnection = {
        frame({ id, event, data }) {
          let text = "";
          if (id !== undefined) text += `id: ${id}\n`;
          if (event !== undefined) text += `event: ${event}\n`;
          // A raw line break inside `data` would end the field, so each line
          // gets its own `data:`. The client rejoins them with `\n`. CR, LF and
          // CRLF are all line terminators to an SSE reader.
          for (const line of data.split(/\r\n|\r|\n/)) text += `data: ${line}\n`;
          write(`${text}\n`);
        },
        cursor(id) {
          write(`id: ${id}\n\n`);
        },
        defer(cleanup) {
          // Registering after teardown has run would put the handler on a list
          // nothing iterates again: the bus listener would never be removed and
          // the per-user refcount behind it would never decrement, so the
          // subscription leaks for the life of the process. Run it now instead.
          if (tornDown) {
            cleanup();
            return;
          }
          cleanups.push(cleanup);
        },
        close() {
          runTeardown();
          try {
            controller.close();
          } catch {
            // stream already closed
          }
        },
      };

      write(CONNECTED_PRELUDE);

      // The two throw windows, which answer differently. A synchronous throw is
      // still inside `new ReadableStream`, so re-throwing it here propagates
      // out of `sseResponse` to the error middleware; a rejection is not, and
      // can only error the body. Both run teardown, which is the half that
      // matters: a rejected `start` moves the stream to `errored`, and that
      // transition never invokes the underlying source's `cancel`.
      let opened: void | Promise<void>;
      try {
        opened = open(conn);
      } catch (err) {
        runTeardown();
        throw err;
      }
      // `Promise.resolve` and not `opened instanceof Promise`: `Promise<T>` is
      // a structural type and `instanceof` is a prototype-chain test, so the
      // two disagree on a promise from another realm or from a library class
      // that only implements the interface. Such a value type-checks here, and
      // the prototype test would route it down the synchronous path, where the
      // rejection handler is never attached: no teardown, and an orphaned
      // heartbeat. Neither shipped adopter can produce one, but the guarantee
      // this seam exists to give must not depend on that. The uniform form
      // costs one microtask on the synchronous path, which nothing reads.
      return Promise.resolve(opened).then(
        () => undefined,
        (err: unknown) => {
          runTeardown();
          throw err;
        },
      );
    },
    cancel() {
      teardown?.();
    },
  });

  return new Response(stream, { headers: createSseHeaders() });
}
