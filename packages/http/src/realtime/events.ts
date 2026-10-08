import { Elysia, t } from "elysia";
import { nodeEnv } from "@alfred/env/server";
import { authMacro } from "../middleware/auth";
import { sseResponse } from "./sse";
import { publishEvent } from "@alfred/assistant/triggers";
import {
  getEventsSince,
  getReplayHighWatermark,
  subscribeUserEvents,
} from "@alfred/assistant/realtime";
import type { EventFrame } from "@alfred/contracts/events";
import { toMessage } from "@alfred/contracts";

/**
 * SSE stream of user events. Replays from `Last-Event-ID` or `?since=`.
 * Subscribe first and buffer, replay up to a watermark, then flush only newer live frames.
 * Ids can arrive out of order when a relay publish is retried.
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

        return sseResponse(async (conn) => {
          const writeFrame = (frame: EventFrame) => {
            conn.frame({
              id: frame.id,
              event: frame.kind,
              data: JSON.stringify({ payload: frame.payload, createdAt: frame.createdAt }),
            });
          };

          // Phase 1: subscribe to live, buffering until replay finishes.
          let mode: "buffering" | "passthrough" = "buffering";
          const buffer: EventFrame[] = [];
          conn.defer(
            subscribeUserEvents(userId, (frame) => {
              if (mode === "buffering") {
                buffer.push(frame);
              } else {
                writeFrame(frame);
              }
            }),
          );

          // Phase 2 + 3: snapshot watermark, replay rows in (since, watermark].
          let watermark = sinceId;

          if (sinceId !== undefined) {
            try {
              watermark = await getReplayHighWatermark(userId);

              if (watermark > sinceId) {
                const replay = await getEventsSince(userId, sinceId, watermark);

                for (const frame of replay.frames) writeFrame(frame);

                // Filtered unknown kinds must still advance the cursor, or reconnect loops on one page.
                if (replay.cursor > (replay.frames.at(-1)?.id ?? sinceId)) {
                  conn.cursor(replay.cursor);
                }

                if (replay.hasMore) {
                  conn.close();

                  return;
                }
              }
            } catch (err) {
              console.warn("[events:sse] replay failed for user", userId, toMessage(err));
            }
          }

          // Phase 4: flush buffered live frames newer than the watermark.
          const cutoff = watermark ?? 0;

          for (const frame of buffer) {
            if (frame.id > cutoff) writeFrame(frame);
          }

          buffer.length = 0;
          mode = "passthrough";
        });
      })
      // Elysia runs this callback at import, so it uses `nodeEnv()`: `serverEnv()` throws
      // with no env. Trap: a missing or invalid NODE_ENV defaults to "development" and mounts
      // `_demo`. `authMacro` still calls `serverEnv()` per request, so that env gets a 500.
      .guard({}, (inner) =>
        nodeEnv() === "development"
          ? inner.post(
              "/_demo",
              async ({ user, body }) => {
                await publishEvent({
                  untransacted: true,
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
