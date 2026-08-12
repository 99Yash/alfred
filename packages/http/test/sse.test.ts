import assert from "node:assert/strict";
import { describe, test } from "node:test";

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

describe("sseResponse", () => {
  test("sends the connected prelude before anything the route writes", async () => {
    const res = sseResponse((conn) => {
      conn.write("event: poke\ndata: {}\n\n");
    });

    const reader = res.body?.getReader();
    assert.ok(reader);
    const first = new TextDecoder().decode((await reader.read()).value);
    const second = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();

    assert.equal(first, ": connected\n\n");
    assert.equal(second, "event: poke\ndata: {}\n\n");
  });

  test("merges caller headers over the three base headers without deleting them", async () => {
    const res = sseResponse(() => {}, {
      headers: { "X-Accel-Buffering": "no", "Cache-Control": "no-store" },
    });
    await res.body?.cancel();

    assert.equal(res.headers.get("Content-Type"), "text/event-stream");
    assert.equal(res.headers.get("Connection"), "keep-alive");
    assert.equal(res.headers.get("X-Accel-Buffering"), "no");
    // A caller may override a base header; it cannot drop one.
    assert.equal(res.headers.get("Cache-Control"), "no-store");

    const bare = sseResponse(() => {});
    await bare.body?.cancel();
    assert.equal(bare.headers.get("Cache-Control"), "no-cache");
    assert.equal(bare.headers.get("X-Accel-Buffering"), null);
  });

  test("runs a registered teardown exactly once on client cancel", async () => {
    let calls = 0;
    const res = sseResponse((conn) => {
      conn.onCancel(() => {
        calls += 1;
      });
    });

    await readAvailable(res);
    assert.equal(calls, 1);
  });

  test("runs a registered teardown exactly once on close(), and close() is idempotent", async () => {
    let calls = 0;
    const res = sseResponse((conn) => {
      conn.onCancel(() => {
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
      conn.onCancel(() => {
        calls += 1;
      });
      conn.close();
    });

    await res.body?.cancel();
    assert.equal(calls, 1);
  });

  test("write after close does not throw", async () => {
    let threw: unknown;
    const res = sseResponse((conn) => {
      conn.close();
      try {
        conn.write("event: poke\ndata: {}\n\n");
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
