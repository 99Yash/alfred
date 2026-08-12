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
 *   3. Replay one bounded page in (since, watermark]. If more rows remain,
 *      close so EventSource reconnects with the page's final id.
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
                // Unknown legacy kinds are filtered from dispatch, but their
                // ids must still advance Last-Event-ID or reconnect could
                // request the same page forever.
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
      // Elysia calls this builder callback EAGERLY, at module load, so whichever
      // environment reader sits here runs when `@alfred/http`'s barrel is
      // imported — not when a request arrives. That is why this is `nodeEnv()`
      // and not `serverEnv().NODE_ENV`: the two read the same field through the
      // same schema and agree whenever the whole environment is valid, but
      // `serverEnv()` throws when any of its required variables is missing OR
      // invalid, and this package must stay importable with no environment at
      // all. The divergence is real and one-sided: where `serverEnv()` would
      // have aborted the import, `nodeEnv()` returns the schema default
      // `"development"` and therefore MOUNTS `_demo`. Note the trigger is
      // wider than an empty environment — a `.default()` fires only on
      // `undefined`, so a fully configured deploy that sets `NODE_ENV` to a
      // value outside the enum (`Production`, or an empty string) diverges
      // too. What keeps a diverged `_demo` off the wire is a control inside
      // this package: the route sits behind `authMacro`, whose resolve runs
      // `getSessionCached` -> `auth()` -> `serverEnv()` on every request that
      // reaches the handler — Elysia validates the body first, so a malformed
      // body answers 400 without it (the global `errorHandler` maps Elysia's
      // `VALIDATION` code to `VALIDATION_ERROR`; 422 is Elysia's default only on
      // a bare mount with no `errorHandler`). The divergence set is contained in the
      // set where `serverEnv()` throws, so an environment that mounts `_demo`
      // BECAUSE of that divergence answers 500 on a well-formed request and
      // 400 on a malformed one, and reaches `publishEvent` on neither path
      // (measured). The 500 body is `errorHandler`'s generic
      // `INTERNAL_SERVER_ERROR`; the missing-variable list goes to the server
      // log only. A valid development environment is not that case — it
      // mounts `_demo` and serves it, as it does today. That control survives
      // item 12's deletion of `@alfred/api`. Process-level reads sit behind it
      // as backstops, not as the argument: `apps/server/src/index.ts` calls
      // `serverEnv()` at module scope in `startRuntime()` (`:54`), for
      // `CORS_ORIGIN` (`:59`), for the HSTS flag (`:67`) and for
      // `.listen({ port })` (`:75`), all of which outlive item 12, while
      // `@alfred/api`'s own import-time read through `auth()` dies with it. A
      // valid `NODE_ENV=production` is unaffected either way.
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
