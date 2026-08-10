import { Errors } from "@alfred/contracts";
import { Elysia } from "elysia";
import { authMacro } from "@alfred/http";
import { subscribeUserPokes } from "@alfred/assistant/realtime";
import { ReplicacheModel } from "./model";
import { handlePull } from "./pull";
import { handlePush } from "./push";

export const replicache = new Elysia({ prefix: "/api/replicache", normalize: "typebox" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .post(
        "/pull",
        async ({ body, user }) => {
          const result = await handlePull(user.id, body);
          if ("forbidden" in result) {
            throw Errors.ForbiddenError("Client group is bound to another user");
          }
          return result;
        },
        { body: ReplicacheModel.pull },
      )
      .post(
        "/push",
        async ({ body, user }) => {
          if (body.mutations.length > ReplicacheModel.MAX_MUTATIONS) {
            throw Errors.PayloadTooLargeError(
              `Push exceeds ${ReplicacheModel.MAX_MUTATIONS} mutations`,
            );
          }
          const result = await handlePush(user.id, body);
          if ("forbidden" in result) {
            throw Errors.ForbiddenError("Client group is bound to another user");
          }
          return result;
        },
        { body: ReplicacheModel.push },
      )
      .get("/events", ({ user }) => {
        const userId = user.id;
        const encoder = new TextEncoder();
        let cleanup: (() => void) | undefined;

        const stream = new ReadableStream({
          start(controller) {
            const write = (text: string) => {
              try {
                controller.enqueue(encoder.encode(text));
              } catch {
                // stream already closed
              }
            };

            const unsubscribe = subscribeUserPokes(userId, () => {
              write(`event: poke\ndata: {}\n\n`);
            });

            const heartbeat = setInterval(() => {
              write(": heartbeat\n\n");
            }, 30_000);

            write(": connected\n\n");

            cleanup = () => {
              unsubscribe();
              clearInterval(heartbeat);
            };
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
          },
        }) as Response;
      }),
  );
