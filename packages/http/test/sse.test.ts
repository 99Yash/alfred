import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { EVENT_KINDS } from "@alfred/contracts/events";

import { sseResponse } from "../src/realtime/sse";

/**
 * The frame and teardown contract of the shared SSE primitive. DB-free and
 * env-free on purpose: it runs in `http-tests` with nothing configured, which
 * is the same property the two routes that adopt it must keep.
 */

async function readAvailable(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  assert.ok(reader, "response has a body");
  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value);
}

/**
 * Read the first `count` chunks as text. One `enqueue` is one chunk, so each
 * chunk is exactly one frame and the assertions can be byte-exact.
 */
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

/**
 * Count heartbeat arms and clears across `fn`. `getActiveResourcesInfo()`
 * cannot see an unref'd timer, so counting the calls is the only way to assert
 * that a stream torn down by a throwing `open` did not orphan its interval.
 */
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
    // There is no caller-supplied header door, so this is a property no route
    // can vary: `Content-Type` cannot be replaced and neither SSE route can
    // diverge on `X-Accel-Buffering`. The name set is asserted whole, because
    // "the four headers" is the claim — a fifth would be a new decision.
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
    // `Headers` is mutable. A module-scope instance shared by every response
    // would carry an edit made through one response into every later one.
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
    // An id-only frame: advances `Last-Event-ID`, dispatches nothing.
    assert.equal(cursor, "id: 7\n\n");
  });

  test("no event kind can end a frame early", () => {
    // `SseFrame.event` is the closed union `EventKind | "poke"`, so `frame()`
    // needs no run-time check for the line break that would terminate a frame
    // early and let the payload write a second one. That trades a throw for a
    // compile error (`test/type/sse-event-name.type-test.ts` is the gate), and
    // it trusts the union: every name in it holds no line break. `"poke"` is a
    // literal in this package, but `EventKind` is owned by `@alfred/contracts`,
    // where a kind is added without reading this file. This detects such a kind;
    // it does not prevent one.
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
    // The shape this exists for: an `open` that must await a subscribe before
    // it can register the matching unsubscribe. A client that disconnects
    // inside that await tears the stream down first, so the handler arrives
    // after the list has already been drained.
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
    // Let the continuation of `open` past its await actually run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(calls, 1);
  });

  test("runs teardown and clears the heartbeat when open throws synchronously", async () => {
    // A synchronous throw is still inside `new ReadableStream`, so it leaves
    // `sseResponse` and reaches the error middleware: the client gets 500 and
    // no stream. Measured against the package's own `errorHandler` on Node 22.
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
    // The path a rejected `start` takes: WHATWG moves the stream to `errored`,
    // and that transition never invokes the underlying source's `cancel`. So
    // without the primitive's own catch, this leaks the armed interval and
    // every registered handler for the life of the process — the round-1
    // measurement was `armed=1 cleared=0 teardown=0`.
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

      // The body read must be caught: the stream errors, and an uncaught
      // rejection here would fail the process rather than the assertion.
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
    // `Promise<T>` is structural, so a promise whose prototype chain does not
    // include this realm's `Promise` — one from `node:vm`, or from a library
    // class that implements the interface — satisfies the signature of `open`.
    // A prototype test would send it down the synchronous path and never
    // attach the rejection handler, which is the leak this seam exists to
    // close. The cast stands in for that class: it is what the type system
    // already admits, not a widening of the contract.
    let calls = 0;
    // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- boundary cast: source type is structurally incompatible with target
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
    // One handler per route today, which is exactly why this needs pinning:
    // the reason teardown is a LIST is that a later adopter registers a second
    // one beside the first.
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
    // `getActiveResourcesInfo()` cannot see an unref'd timer, so the handle
    // delta is blind to this claim. Count the arm instead: wrap
    // `setInterval` across the call and assert `.unref()` ran on the handle it
    // returned.
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
