import { Elysia, t } from "elysia";
import { serverEnv } from "@alfred/env/server";
import { authMacro } from "../../middleware/auth";
import { publishEvent } from "../../events/publish";
import { subscribeUserEvents } from "../../events/user-events-bus";
import type { EventFrame } from "../../events/types";
import { getEventsSince, getReplayHighWatermark } from "./replay";

/**
 * Generic SSE endpoint for durable user-scoped events.
 *
 * Reconnect protocol: EventSource auto-sends `Last-Event-ID` on reconnect.
 * If absent, callers MAY pass `?since=<id>` (an outbox row id) to trigger a
 * replay. With neither, the client gets only events emitted after the
 * connection establishes.
 *
 * Replay-vs-live race handling:
 *   1. Subscribe to live tail FIRST (frames go into a buffer).
 *   2. Snapshot a high watermark = MAX(id) currently published for this user.
 *   3. Replay rows in (since, watermark].
 *   4. Flush buffered live frames with id > watermark — anything <= watermark
 *      was already covered by replay.
 *   5. Switch buffered listener into passthrough mode.
 *
 * Result: replayed events are not duplicated by the live handoff for a given
 * connection. Strict global id ordering is not guaranteed: if the relay's
 * publish to Redis fails for one row, later ids may arrive before the failed
 * row is retried on the next drain pass. Consumers must be id-tolerant.
 */
export const events = new Elysia({ prefix: "/api/events", normalize: "typebox" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .get("/", ({ user, request }) => {
        const url = new URL(request.url);
        const sinceParam = url.searchParams.get("since");
        const lastEventId = request.headers.get("last-event-id") ?? undefined;
        const sinceId = parseSinceId(lastEventId ?? sinceParam ?? undefined);

        const userId = user.id;
        const encoder = new TextEncoder();

        let cleanup: (() => void) | undefined;

        const stream = new ReadableStream({
          async start(controller) {
            const write = (text: string) => {
              try {
                controller.enqueue(encoder.encode(text));
              } catch {
                // stream already closed
              }
            };

            const writeFrame = (frame: EventFrame) => {
              write(
                `id: ${frame.id}\nevent: ${frame.kind}\ndata: ${JSON.stringify({
                  payload: frame.payload,
                  createdAt: frame.createdAt,
                })}\n\n`,
              );
            };

            // Phase 1: subscribe to live, buffering until replay finishes.
            let mode: "buffering" | "passthrough" = "buffering";
            const buffer: EventFrame[] = [];
            const unsubscribe = subscribeUserEvents(userId, (frame) => {
              if (mode === "buffering") {
                buffer.push(frame);
              } else {
                writeFrame(frame);
              }
            });

            const heartbeat = setInterval(() => {
              write(": heartbeat\n\n");
            }, 30_000);
            if (typeof heartbeat === "object" && "unref" in heartbeat) {
              heartbeat.unref();
            }

            cleanup = () => {
              unsubscribe();
              clearInterval(heartbeat);
            };

            write(": connected\n\n");

            // Phase 2 + 3: snapshot watermark, replay rows in (since, watermark].
            let watermark = sinceId;
            if (sinceId !== undefined) {
              try {
                watermark = await getReplayHighWatermark(userId);
                if (watermark > sinceId) {
                  const replay = await getEventsSince(userId, sinceId, watermark);
                  for (const frame of replay) writeFrame(frame);
                }
              } catch (err) {
                console.warn(
                  "[events:sse] replay failed for user",
                  userId,
                  err instanceof Error ? err.message : String(err),
                );
              }
            }

            // Phase 4: flush buffered live frames newer than the watermark.
            const cutoff = watermark ?? 0;
            for (const frame of buffer) {
              if (frame.id > cutoff) writeFrame(frame);
            }
            buffer.length = 0;
            mode = "passthrough";
          },
          cancel() {
            cleanup?.();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        }) as Response;
      })
      .guard({}, (inner) =>
        serverEnv().NODE_ENV === "development"
          ? inner.post(
              "/_demo",
              async ({ user, body }) => {
                await publishEvent({
                  userId: user.id,
                  kind: "agent.progress",
                  payload: {
                    runId: body.runId ?? "demo-run",
                    step: body.step ?? "manual",
                    message: body.message,
                  },
                });
                return { ok: true } as const;
              },
              {
                body: t.Object({
                  runId: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
                  step: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
                  message: t.Optional(t.String({ maxLength: 2_000 })),
                }),
              },
            )
          : inner,
      ),
  );

function parseSinceId(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}
