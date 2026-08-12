import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, connect as connectTcp, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { before, describe, test } from "node:test";

/**
 * Why `"subscriber"` exists as a kind of its own, pinned at the process
 * boundary and on the wire.
 *
 * After a reconnect, ioredis's `readyHandler` re-issues the previous SUBSCRIBE
 * and PSUBSCRIBE with NO `.catch` — unlike the `readonly().catch(noop)` a few
 * lines above it in the same function. That is the only command on such a
 * connection that no module owns, so ANY rejection of it is an unhandled
 * rejection, and `apps/server/src/index.ts` turns one of those into
 * `process.exit(1)`. Two measured routes reach that rejection, and removing
 * either alone leaves the other:
 *
 * 1. a `commandTimeout` times the re-issued command out;
 * 2. a numeric `maxRetriesPerRequest` flushes it with `MaxRetriesPerRequestError`
 *    when the peer then refuses — `prevCommandQueue = self.commandQueue` in the
 *    close handler is an ALIAS, not a move, and only a TCP `connect` calls
 *    `resetCommandQueue()`, which a refusing peer never emits.
 *
 * `"subscriber"` therefore deletes the command itself: `autoResubscribe: false`.
 * That is what these subtests measure — not the absence of a crash, which an
 * outage that never happened also produces, but the absence of the COMMAND, on a
 * reconnect the harness proves it provoked.
 *
 * The three subtests are one subject and two controls:
 *
 * - The subject reconnects for real (a second `READY` from the child) and must
 *   send ZERO further SUBSCRIBE frames.
 * - Control A is the same reconnect on `"command"`, which MUST send one. Without
 *   it, "zero frames" is equally consistent with a harness that never
 *   reconnected — which is exactly how the previous version of this file passed
 *   while measuring nothing.
 * - Control B is `"command"` against a peer that accepts and never replies,
 *   which must exit 1. It proves an unhandled rejection is observable through
 *   this harness at all, and it is why `"subscriber"` also carries no
 *   `commandTimeout`.
 *
 * There is deliberately NO `"subscriber"` counterpart to control B: measured on
 * ioredis 5.11.1, a connection with no `commandTimeout` never reaches `ready`
 * against a peer that accepts and never replies, because the `CLIENT SETINFO`
 * handshake never completes. It would exit 0 by not reconnecting, which is the
 * vacuity this file was rewritten to remove. The subject uses a HEALTHY peer
 * behind a cut socket instead, where reaching `ready` again is guaranteed and
 * observable.
 *
 * Needs a reachable Redis: the connection must genuinely subscribe before the
 * outage, or the reconnect has nothing to re-issue. The `db-tests` CI job
 * supplies one; locally, `docker compose up redis` does.
 */

const UPSTREAM_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
/** The child's own window is 8s; this is that plus room for spawn and install. */
const CHILD_DEADLINE_MS = 20_000;
/** How long a reconnect onto a healthy peer may take before it counts as never. */
const RECONNECT_DEADLINE_MS = 10_000;
/** Time given to a re-issued SUBSCRIBE to reach the wire after `ready`. */
const RESUBSCRIBE_WINDOW_MS = 750;

const CHILD = fileURLToPath(new URL("./support/subscriber-reconnect-child.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

/** `*2\r\n$9\r\nsubscribe\r\n…` — the RESP framing of the command, not a substring of a payload. */
const SUBSCRIBE_FRAME = /\$9\r\nsubscribe\r\n/i;

interface ChildOutcome {
  readonly code: number | null;
  readonly stderr: string;
  /** SUBSCRIBE frames the client put on the wire AFTER the socket was cut. */
  readonly resubscribeFrames: number;
}

/**
 * A TCP proxy in front of the real Redis. It can cut every live socket while
 * still serving the reconnect (a flap), stop answering entirely (a peer that
 * accepts and never replies), and count the SUBSCRIBE frames the client sends.
 *
 * A closed port is not enough for the subject: the client must reconnect
 * SUCCESSFULLY to reach `ready` and re-issue its subscriptions, and nothing
 * reconnects successfully to a closed port.
 */
class SwitchableProxy {
  private mode: "forward" | "silent" = "forward";
  private readonly open = new Set<Socket>();
  private readonly server: Server;
  /** Counted from the client's bytes, so it measures what ioredis actually sent. */
  subscribeFrames = 0;
  private constructor(server: Server) {
    this.server = server;
  }

  static async start(upstream: URL): Promise<SwitchableProxy> {
    const upstreamPort = Number(upstream.port === "" ? "6379" : upstream.port);
    const upstreamHost = upstream.hostname;
    let self: SwitchableProxy | undefined;
    const server = createServer((downstream) => {
      const proxy = self;
      if (!proxy) {
        downstream.destroy();
        return;
      }
      proxy.track(downstream);
      if (proxy.mode === "silent") return;
      const upstreamSocket = connectTcp(upstreamPort, upstreamHost);
      // Not `pipe`: every client byte is inspected on its way through, which is
      // the only place a re-issued SUBSCRIBE is visible. A mock of the
      // connection could not show it — the whole question is which commands
      // reach the wire.
      let pending = "";
      downstream.on("data", (chunk: Buffer) => {
        pending = (pending + chunk.toString("latin1")).slice(-512);
        for (;;) {
          const match = SUBSCRIBE_FRAME.exec(pending);
          if (!match) break;
          proxy.subscribeFrames += 1;
          pending = pending.slice(match.index + match[0].length);
        }
        upstreamSocket.write(chunk);
      });
      upstreamSocket.pipe(downstream);
      upstreamSocket.on("error", () => downstream.destroy());
      proxy.track(upstreamSocket);
    });
    self = new SwitchableProxy(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return self;
  }

  private track(socket: Socket): void {
    this.open.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => this.open.delete(socket));
  }

  get url(): string {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error(`unexpected proxy address: ${String(address)}`);
    }
    return `redis://127.0.0.1:${address.port}`;
  }

  /** Cut every live socket. The next connection is served normally — a flap. */
  cutSockets(): void {
    for (const socket of this.open) socket.destroy();
  }

  /** Take Redis away: cut every live socket and answer nothing from now on. */
  goSilent(): void {
    this.mode = "silent";
    this.cutSockets();
  }

  async stop(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** The child's stdout, as the two events the parent waits on. */
class ChildEvents {
  private buffer = "";
  private readonly waiters: { needle: string; count: number; resolve: () => void }[] = [];
  private readonly seen = new Map<string, number>();

  feed(chunk: string): void {
    this.buffer += chunk;
    // Recounted from the whole buffer each time rather than tracked across
    // partial lines: the volume is a handful of lines, and a miscounted READY
    // is precisely the failure this file exists to avoid.
    this.seen.clear();
    for (const line of this.buffer.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      this.seen.set(trimmed, (this.seen.get(trimmed) ?? 0) + 1);
    }
    for (const waiter of this.waiters.slice()) {
      if ((this.seen.get(waiter.needle) ?? 0) >= waiter.count) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  count(needle: string): number {
    return this.seen.get(needle) ?? 0;
  }

  async wait(needle: string, count: number, timeoutMs: number, what: string): Promise<void> {
    if (this.count(needle) >= count) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.waiters.push({ needle, count, resolve });
        timer = setTimeout(() => reject(new Error(what)), timeoutMs);
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * A fresh proxy per child: `goSilent()` is one-way, so a shared one would leave
 * the second child unable to subscribe in the first place.
 */
async function runChild(
  kind: string,
  outage: (proxy: SwitchableProxy, events: ChildEvents) => Promise<void>,
): Promise<ChildOutcome> {
  const proxy = await SwitchableProxy.start(new URL(UPSTREAM_URL));
  try {
    return await drive(kind, proxy, outage);
  } finally {
    await proxy.stop();
  }
}

async function drive(
  kind: string,
  proxy: SwitchableProxy,
  outage: (proxy: SwitchableProxy, events: ChildEvents) => Promise<void>,
): Promise<ChildOutcome> {
  const child = spawn(TSX, [CHILD, kind, proxy.url], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  const events = new ChildEvents();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => events.feed(chunk));

  let exitedEarly = false;
  child.once("exit", () => (exitedEarly = true));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );

  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await events.wait(
      "SUBSCRIBED",
      1,
      CHILD_DEADLINE_MS,
      `child never subscribed${exitedEarly ? " (it exited first)" : ""}: ${stderr}`,
    );
    // Only now: the subscription must exist before the outage, or the reconnect
    // has nothing to re-issue and the whole file measures nothing.
    const framesBefore = proxy.subscribeFrames;
    await outage(proxy, events);
    const resubscribeFrames = proxy.subscribeFrames - framesBefore;

    const code = await Promise.race([
      exited,
      new Promise<number | null>((resolve) => {
        deadline = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(null);
        }, CHILD_DEADLINE_MS);
      }),
    ]);
    return { code, stderr, resubscribeFrames };
  } finally {
    if (deadline) clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

/**
 * Cut the socket and serve the reconnect normally, then WAIT FOR PROOF that the
 * reconnect happened before measuring anything. A second `READY` is that proof.
 */
async function flapAndProveReconnect(proxy: SwitchableProxy, events: ChildEvents): Promise<void> {
  proxy.cutSockets();
  await events.wait(
    "READY",
    2,
    RECONNECT_DEADLINE_MS,
    "the child never reached `ready` a second time — it did not reconnect, so nothing about a re-issued subscribe was measured. Fix the harness before trusting any subtest in this file",
  );
  // `ready` is when `readyHandler` runs; the re-issued SUBSCRIBE is written from
  // inside it, so a short window after is enough for it to reach the proxy.
  await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_WINDOW_MS));
}

describe("a subscriber connection that reconnects", () => {
  before(() => {
    assert.ok(existsSync(TSX), `no tsx binary at ${TSX} — run \`pnpm install\``);
    assert.ok(existsSync(CHILD), `no child fixture at ${CHILD}`);
  });

  test('"subscriber" re-issues nothing of its own and survives', async () => {
    const outcome = await runChild("subscriber", flapAndProveReconnect);

    assert.equal(
      outcome.resubscribeFrames,
      0,
      `ioredis put ${String(outcome.resubscribeFrames)} SUBSCRIBE frame(s) on the wire after the reconnect — \`autoResubscribe\` is back on, and that command is the one nothing catches`,
    );
    assert.equal(
      outcome.code,
      0,
      `a "subscriber" connection took the process down (exit ${String(outcome.code)}): ${outcome.stderr}`,
    );
    assert.doesNotMatch(outcome.stderr, /UNHANDLED/);
  });

  test('"command" re-issues one — the control that proves the reconnect happens', async () => {
    const outcome = await runChild("command", flapAndProveReconnect);

    assert.equal(
      outcome.resubscribeFrames,
      1,
      "ioredis did not re-issue a SUBSCRIBE on a kind whose `autoResubscribe` is ON, so this harness is no longer reaching the point of failure and the subtest above proves nothing. Check that the flap really cuts the socket before assuming the vendor changed",
    );
  });

  test('"command" against a peer that never replies exits 1 — the crash is observable', async () => {
    const outcome = await runChild("command", async (proxy) => {
      proxy.goSilent();
      // No reconnect proof to wait for: this peer is the one shape where the
      // connection reaches `ready` only BECAUSE of the `commandTimeout`, which
      // is the fact under measurement.
      await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_WINDOW_MS));
    });

    assert.equal(
      outcome.code,
      1,
      'a "command" connection survived a peer that accepts and never replies — an unhandled rejection is no longer observable through this harness, so the subject subtest cannot be read as evidence of anything',
    );
    assert.match(outcome.stderr, /UNHANDLED Command timed out/);
  });
});
