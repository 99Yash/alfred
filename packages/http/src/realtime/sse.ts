/**
 * Shared SSE framing for `/api/events` and `/api/replicache/events`.
 * Routes pass frame parts, never wire text or headers.
 */

import { toMessage, unrefTimer } from "@alfred/contracts";
import type { EventKind } from "@alfred/contracts/events";

const HEARTBEAT_INTERVAL_MS = 30_000;

/** A comment frame sent first, to flush headers through a proxy that waits for the first byte. */
const CONNECTED_PRELUDE = ": connected\n\n";

/**
 * A fresh `Headers` per response, because `Headers` is mutable.
 * `X-Accel-Buffering: no` stops nginx-style proxies from holding frames.
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
 * Every event name a route here may send. Keep it closed, never `string`:
 * a name with a line break would end the frame and inject a second one.
 * At run time, `isKnownEventKind` in `@alfred/assistant` realtime is the real guard.
 */
export type SseEventName = EventKind | "poke";

/** One SSE frame, as its parts rather than as wire text. */
export interface SseFrame {
  /** Advances the client's `Last-Event-ID`. */
  id?: number | undefined;
  /** Selects the client listener. Omitted frames go to `message`. */
  event?: SseEventName | undefined;
  data: string;
}

export interface SseConnection {
  /**
   * Write one frame. Never throws: `realtime/events.ts` calls it inside a bus listener,
   * where a throw aborts every other subscriber. A dropped stream is a no-op.
   * Trap: `JSON.stringify(undefined)` is typed `string` but returns `undefined`.
   */
  frame(frame: SseFrame): void;
  /** Advance `Last-Event-ID` without an event, so a reconnect skips rows the route chose not to send. */
  cursor(id: number): void;
  /**
   * Register teardown. It runs exactly once on any exit. A handler registered after
   * teardown runs now, outside the try, so a throw there reaches the caller.
   */
  defer(cleanup: () => void): void;
  /** Run teardown, then close the stream. Idempotent. */
  close(): void;
}

/**
 * Build an SSE `Response`. Teardown runs on every exit from `open`.
 * A sync throw from `open` becomes a 500. A rejection gives a 200 whose body errors:
 * awaiting `open` first would hold the headers until replay ends.
 * The heartbeat is unref'd so open tabs do not delay a graceful shutdown.
 */
export function sseResponse(open: (conn: SseConnection) => void | Promise<void>): Response {
  const encoder = new TextEncoder();
  // Declare above the stream: `new ReadableStream` runs `start` synchronously.
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

      unrefTimer(heartbeat);

      const runTeardown = () => {
        if (tornDown) return;
        tornDown = true;
        clearInterval(heartbeat);

        for (const fn of cleanups) {
          // One failing handler must not skip the rest.
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

          // Each line gets its own `data:`. SSE treats CR, LF and CRLF as line ends.
          for (const line of data.split(/\r\n|\r|\n/)) text += `data: ${line}\n`;
          write(`${text}\n`);
        },
        cursor(id) {
          write(`id: ${id}\n\n`);
        },
        defer(cleanup) {
          // Late registration: nothing iterates the list again, so run it now or the subscription leaks.
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

      // Both paths run teardown: an errored stream never calls `cancel`.
      let opened: void | Promise<void>;

      try {
        opened = open(conn);
      } catch (err) {
        runTeardown();
        throw err;
      }

      // Not `instanceof Promise`: a thenable from another realm would skip teardown.
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
