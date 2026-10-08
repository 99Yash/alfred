import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { EVENT_KINDS } from "@alfred/contracts/events";

import { sseResponse } from "../src/realtime/sse";

// DB-free and env-free on purpose, like the two routes that use the primitive.

async function readAvailable(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  assert.ok(reader, "response has a body");
  const { value } = await reader.read();
  await reader.cancel();

  return new TextDecoder().decode(value);
}

/** One `enqueue` is one chunk, so each chunk is one frame and asserts can be byte-exact. */
async function readChunks(res: Response, count: number): Promise<string[]> {
  const reader = res.body?.getReader();
  assert.ok(reader, "response has a body");
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const { value, done } = await reader.read();

    if (done) break;
    chunks.push(decoder.decode(value));
  }

  await reader.cancel();

  return chunks;
}

/** Count heartbeat arms and clears. `getActiveResourcesInfo()` cannot see an unref'd timer. */
async function countingIntervals(fn: () => Promise<void> | void): Promise<{
  armed: number;
  cleared: number;
}> {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let armed = 0;
  let cleared = 0;

  try {
    globalThis.setInterval = ((...args: Parameters<typeof realSetInterval>) => {
      armed += 1;

      return realSetInterval(...args);
    }) as typeof globalThis.setInterval;
    globalThis.clearInterval = ((handle?: Parameters<typeof realClearInterval>[0]) => {
      cleared += 1;
      realClearInterval(handle);
    }) as typeof globalThis.clearInterval;
    await fn();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }

  return { armed, cleared };
}

describe("sseResponse", () => {
  test("sends the connected prelude before anything the route writes", async () => {
    const res = sseResponse((conn) => {
      conn.frame({ event: "poke", data: "{}" });
    });

    const [first, second] = await readChunks(res, 2);

    assert.equal(first, ": connected\n\n");
    assert.equal(second, "event: poke\ndata: {}\n\n");
  });

  test("carries exactly the four base headers, including the proxy-buffering posture", async () => {
    // Routes cannot supply headers. Assert the whole set: a fifth header is a new decision.
    const res = sseResponse(() => {});
    await res.body?.cancel();

    assert.equal(res.headers.get("Content-Type"), "text/event-stream");
    assert.equal(res.headers.get("Cache-Control"), "no-cache");
    assert.equal(res.headers.get("Connection"), "keep-alive");
    assert.equal(res.headers.get("X-Accel-Buffering"), "no");
    assert.deepEqual([...res.headers.keys()].sort(), [
      "cache-control",
      "connection",
      "content-type",
      "x-accel-buffering",
    ]);
  });

  test("gives every response its own headers, so one cannot edit another", async () => {
    // `Headers` is mutable, so a shared instance would leak one response's edit into the next.
    const first = sseResponse(() => {});
    const second = sseResponse(() => {});
    await first.body?.cancel();
    await second.body?.cancel();

    first.headers.set("Cache-Control", "no-store");

    assert.equal(first.headers.get("Cache-Control"), "no-store");
    assert.equal(second.headers.get("Cache-Control"), "no-cache");
  });

  test("frames the parts a route names, and only those", async () => {
    const res = sseResponse((conn) => {
      conn.frame({ id: 4, event: "agent.progress", data: '{"step":"one"}' });
      conn.frame({ data: "no id and no event" });
      conn.frame({ data: "one\ntwo" });
      conn.frame({ data: "a\r\nb\rc" });
      conn.cursor(7);
    });

    const [prelude, all, dataOnly, multiline, mixedBreaks, cursor] = await readChunks(res, 6);

    assert.equal(prelude, ": connected\n\n");
    assert.equal(all, 'id: 4\nevent: agent.progress\ndata: {"step":"one"}\n\n');
    // An absent `id`/`event` writes no line at all, rather than an empty one.
    assert.equal(dataOnly, "data: no id and no event\n\n");
    // A raw line break would end the `data` field, so each line gets its own.
    assert.equal(multiline, "data: one\ndata: two\n\n");
    // CR, CRLF and LF are all line terminators to an SSE reader.
    assert.equal(mixedBreaks, "data: a\ndata: b\ndata: c\n\n");
    // An id-only frame advances `Last-Event-ID` and dispatches nothing.
    assert.equal(cursor, "id: 7\n\n");
  });

  test("no event kind can end a frame early", () => {
    // `frame()` trusts the `EventKind | "poke"` union to hold no line break.
    // `EventKind` lives in `@alfred/contracts`, so this detects a bad new kind.
    for (const kind of EVENT_KINDS) {
      assert.ok(!/[\r\n]/.test(kind), `event kind ${JSON.stringify(kind)} holds a line break`);
    }
  });

  test("runs a registered teardown exactly once on client cancel", async () => {
    let calls = 0;

    const res = sseResponse((conn) =>
      conn.defer(() => {
        calls += 1;
      }),
    );

    await readAvailable(res);
    assert.equal(calls, 1);
  });

  test("runs a registered teardown exactly once on close(), and close() is idempotent", async () => {
    let calls = 0;

    const res = sseResponse((conn) => {
      conn.defer(() => {
        calls += 1;
      });
      conn.close();
      conn.close();
    });

    const reader = res.body?.getReader();
    assert.ok(reader);
    assert.equal(new TextDecoder().decode((await reader.read()).value), ": connected\n\n");
    assert.equal((await reader.read()).done, true);
    assert.equal(calls, 1);
  });

  test("does not run teardown twice when a closed stream is then cancelled", async () => {
    let calls = 0;

    const res = sseResponse((conn) => {
      conn.defer(() => {
        calls += 1;
      });
      conn.close();
    });

    await res.body?.cancel();
    assert.equal(calls, 1);
  });

  test("runs a teardown registered after teardown already ran, immediately and once", async () => {
    // `open` awaits a subscribe; the client disconnects first, so the handler arrives after teardown.
    let calls = 0;
    let releaseOpen: () => void = () => {};

    const subscribed = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });

    const res = sseResponse(async (conn) => {
      await subscribed;
      conn.defer(() => {
        calls += 1;
      });
    });

    await res.body?.cancel();
    assert.equal(calls, 0, "nothing is registered yet, so teardown ran no handler");

    releaseOpen();
    await subscribed;
    // Let `open` continue past its await.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(calls, 1);
  });

  test("runs teardown and clears the heartbeat when open throws synchronously", async () => {
    // A sync throw escapes `sseResponse` to the error middleware: the client gets 500 and no stream.
    let calls = 0;

    const counts = await countingIntervals(() => {
      assert.throws(
        () =>
          sseResponse((conn) => {
            conn.defer(() => {
              calls += 1;
            });
            throw new Error("open failed");
          }),
        /open failed/,
      );
    });

    assert.equal(calls, 1);
    assert.deepEqual(counts, { armed: 1, cleared: 1 });
  });

  test("runs teardown and clears the heartbeat when open rejects", async () => {
    // A rejected `start` errors the stream, and WHATWG then never calls `cancel`.
    // Without the primitive's own catch, the interval and handlers leak.
    let calls = 0;
    let failOpen: (err: Error) => void = () => {};

    const gate = new Promise<never>((_, reject) => {
      failOpen = reject;
    });

    let outcome = "not read";

    const counts = await countingIntervals(async () => {
      const res = sseResponse(async (conn) => {
        conn.defer(() => {
          calls += 1;
        });
        await gate;
      });

      // Catch the read: an uncaught rejection would fail the process, not the assert.
      const drained = readChunks(res, 4).then(
        () => "ended",
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );

      failOpen(new Error("open rejected"));
      outcome = await drained;
    });

    assert.equal(outcome, "open rejected", "the body errors with what open rejected with");
    assert.equal(calls, 1);
    assert.deepEqual(counts, { armed: 1, cleared: 1 });
  });

  test("runs teardown when open returns a foreign promise that rejects", async () => {
    // `Promise<T>` is structural, so a foreign thenable (`node:vm`, a library class) fits `open`.
    // A prototype check would treat it as sync and miss the rejection.
    let calls = 0;

    // eslint-disable-next-line anti-slop/no-chained-type-assertions -- boundary cast: source type is structurally incompatible with target
    const foreign = {
      // eslint-disable-next-line unicorn/no-thenable -- the test subject IS a thenable from outside this realm
      then(_onFulfilled: (value: void) => void, onRejected: (reason: unknown) => void) {
        onRejected(new Error("foreign rejected"));
      },
    } as unknown as Promise<void>;

    let outcome = "not read";

    const counts = await countingIntervals(async () => {
      const res = sseResponse((conn) => {
        conn.defer(() => {
          calls += 1;
        });

        return foreign;
      });

      outcome = await readChunks(res, 4).then(
        () => "ended",
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
    });

    assert.equal(outcome, "foreign rejected", "the body errors with what open rejected with");
    assert.equal(calls, 1);
    assert.deepEqual(counts, { armed: 1, cleared: 1 });
  });

  test("a throwing teardown handler does not stop the handlers after it", async () => {
    // Teardown is a list so a later route can register a second handler.
    const ran: string[] = [];

    const res = sseResponse((conn) => {
      conn.defer(() => {
        ran.push("first");
        throw new Error("unsubscribe failed");
      });
      conn.defer(() => {
        ran.push("second");
      });
    });

    await res.body?.cancel();
    assert.deepEqual(ran, ["first", "second"]);
  });

  test("frame after close does not throw", async () => {
    let threw: unknown;

    const res = sseResponse((conn) => {
      conn.close();

      try {
        conn.frame({ event: "poke", data: "{}" });
      } catch (err) {
        threw = err;
      }
    });

    await res.body?.cancel();
    assert.equal(threw, undefined);
  });

  test("unrefs the heartbeat timer", async () => {
    // `getActiveResourcesInfo()` cannot see an unref'd timer, so wrap `setInterval` and spy on `.unref()`.
    const realSetInterval = globalThis.setInterval;
    const unreffed: boolean[] = [];

    try {
      globalThis.setInterval = ((...args: Parameters<typeof realSetInterval>) => {
        const handle = realSetInterval(...args);
        const realUnref = handle.unref.bind(handle);
        handle.unref = () => {
          unreffed.push(true);

          return realUnref();
        };

        return handle;
      }) as typeof globalThis.setInterval;

      const res = sseResponse(() => {});
      await res.body?.cancel();
    } finally {
      globalThis.setInterval = realSetInterval;
    }

    assert.deepEqual(unreffed, [true]);
  });
});
