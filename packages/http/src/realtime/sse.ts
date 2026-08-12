/**
 * The Server-Sent Events framing every SSE route in this package shares.
 *
 * Two routes push over SSE — `/api/events` and `/api/replicache/events` — and
 * both had written the same six things by hand: a `TextEncoder`, an enqueue
 * that swallows the throw from a stream the client already dropped, the
 * `": connected"` prelude, a 30 s heartbeat comment, the three headers that
 * make a response a stream, and the `cancel()` -> teardown wiring. Only the
 * frames differ, so only the frames stay in the routes.
 *
 * What the primitive does NOT own is the transport-visible part a route may
 * legitimately vary: extra response headers go in through `options.headers`,
 * which merges OVER the three base headers, so a route keeps whatever it sent
 * before.
 */

import { withDefaults } from "@alfred/contracts";

/** How often a stream writes a comment frame to keep the connection warm. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Sent by the server as soon as the stream opens, before the route writes
 * anything. A comment frame, so no `EventSource` listener sees it — it exists
 * to flush response headers through any intermediary that buffers until the
 * first byte.
 */
const CONNECTED_PRELUDE = ": connected\n\n";

const BASE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

/** The stream, as the route that opened it sees it. */
export interface SseConnection {
  /**
   * Enqueue raw SSE text. Writing to a stream the client has already dropped
   * is a no-op rather than a throw, because a poke or a heartbeat that races
   * the disconnect is normal and must not become an unhandled rejection.
   */
  write(text: string): void;
  /**
   * Register teardown — unsubscribing a bus listener, typically. Every
   * registered function runs exactly once, whether the client cancelled or the
   * route called `close()`, and never twice.
   */
  onCancel(fn: () => void): void;
  /** Run teardown, then close the stream. Idempotent. */
  close(): void;
}

/**
 * Build an SSE `Response`. `open` receives the connection and writes frames to
 * it; it may be async, and the heartbeat is already armed before it runs, so a
 * slow open does not stall the keep-alive.
 *
 * The heartbeat timer is `unref`'d: a per-connection ref'd interval holds the
 * Node event loop open for as long as a browser tab is open, which delays
 * every graceful shutdown by up to one heartbeat per live client.
 */
export function sseResponse(
  open: (conn: SseConnection) => void | Promise<void>,
  options?: { headers?: Record<string, string> },
): Response {
  const encoder = new TextEncoder();
  // Assigned by `start`, read by `cancel`. It must be declared above the
  // stream: `new ReadableStream(...)` runs `start` synchronously, so a
  // declaration below the constructor is read inside its own temporal dead
  // zone and throws.
  let teardown: (() => void) | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const cancelHandlers: Array<() => void> = [];
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
        for (const fn of cancelHandlers) fn();
      };

      teardown = runTeardown;

      const conn: SseConnection = {
        write,
        onCancel(fn) {
          cancelHandlers.push(fn);
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

      await open(conn);
    },
    cancel() {
      teardown?.();
    },
  });

  return new Response(stream, {
    // `withDefaults` rather than a spread: a caller that passes a header key
    // with an explicit `undefined` value must not be able to zero a base
    // header, only to replace one with a real value.
    headers: withDefaults(BASE_HEADERS, options?.headers),
  }) as Response;
}
