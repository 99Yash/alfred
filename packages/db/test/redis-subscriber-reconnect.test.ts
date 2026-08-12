import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, connect as connectTcp, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { before, describe, test } from "node:test";

/**
 * Why `"subscriber"` exists as a kind of its own, pinned by the process
 * boundary.
 *
 * A `commandTimeout` on a connection that holds subscriptions kills the server.
 * Two steps, both measured on ioredis 5.11.1 and both needed:
 *
 * 1. Against a peer that accepts the TCP connection and never replies, the
 *    `commandTimeout` is what lets the connection reach `ready` at all — it
 *    ends the `CLIENT SETINFO` handshake ioredis sends on every connect. With
 *    no `commandTimeout` that handshake never completes and `ready` never
 *    fires.
 * 2. Reaching `ready` runs ioredis's `readyHandler`, which re-issues the
 *    previous SUBSCRIBE/PSUBSCRIBE with NO `.catch` — unlike the
 *    `readonly().catch(noop)` two lines above it in the same function. The next
 *    `commandTimeout` on that re-issued command is an unhandled rejection, and
 *    `apps/server/src/index.ts` turns an unhandled rejection into
 *    `process.exit(1)`.
 *
 * The subject is `"subscriber"` and MUST survive. The control is `"command"`,
 * which must NOT — that is what proves the harness reproduces the crash rather
 * than passing because the outage never happened. If the control ever goes
 * green, either this harness stopped provoking a reconnect or `"command"` lost
 * its `commandTimeout`; check which before deleting the subtest.
 *
 * Both run as child processes because `node:test` fails any test in whose
 * process an unhandled rejection occurs, even one the test installed a listener
 * for — so a control that expects a crash cannot live in this process.
 *
 * Needs a reachable Redis: the connection must genuinely subscribe before the
 * outage, or the reconnect has nothing to re-issue. The `db-tests` CI job
 * supplies one; locally, `docker compose up redis` does.
 */

const UPSTREAM_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
/** The child's own window is 8s; this is that plus room for spawn and install. */
const CHILD_DEADLINE_MS = 20_000;

const CHILD = fileURLToPath(new URL("./support/subscriber-reconnect-child.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

interface ChildOutcome {
  readonly code: number | null;
  readonly stderr: string;
}

/**
 * A TCP proxy in front of the real Redis that can be turned into a peer which
 * accepts connections and never answers. A closed port is not enough here: the
 * client must reconnect SUCCESSFULLY to reach `ready` and re-issue its
 * subscriptions, and nothing reconnects successfully to a closed port.
 */
class SwitchableProxy {
  private mode: "forward" | "silent" = "forward";
  private readonly open = new Set<Socket>();
  private readonly server: Server;
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
      const upstreamSocket = connectTcp(upstreamPort, upstreamHost, () => {
        downstream.pipe(upstreamSocket);
        upstreamSocket.pipe(downstream);
      });
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

  /** Take Redis away: cut every live socket and answer nothing from now on. */
  goSilent(): void {
    this.mode = "silent";
    for (const socket of this.open) socket.destroy();
  }

  async stop(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/**
 * A fresh proxy per child: `goSilent()` is one-way, so a shared one would leave
 * the second child unable to subscribe in the first place.
 */
async function runChild(kind: string): Promise<ChildOutcome> {
  const proxy = await SwitchableProxy.start(new URL(UPSTREAM_URL));
  try {
    return await drive(kind, proxy);
  } finally {
    await proxy.stop();
  }
}

async function drive(kind: string, proxy: SwitchableProxy): Promise<ChildOutcome> {
  const child = spawn(TSX, [CHILD, kind, proxy.url], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  const subscribed = new Promise<void>((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("SUBSCRIBED")) resolve();
    });
    child.once("exit", () => reject(new Error(`child exited before subscribing: ${stderr}`)));
  });

  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await subscribed;
    // Only now: the subscription must exist before the outage, or the reconnect
    // has nothing to re-issue and the whole file measures nothing.
    proxy.goSilent();
    const code = await Promise.race([
      exited,
      new Promise<number | null>((resolve) => {
        deadline = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(null);
        }, CHILD_DEADLINE_MS);
      }),
    ]);
    return { code, stderr };
  } finally {
    if (deadline) clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

describe("a subscriber connection that reconnects onto an unresponsive Redis", () => {
  before(() => {
    assert.ok(existsSync(TSX), `no tsx binary at ${TSX} — run \`pnpm install\``);
    assert.ok(existsSync(CHILD), `no child fixture at ${CHILD}`);
  });

  test('"subscriber" survives the reconnect', async () => {
    const outcome = await runChild("subscriber");

    assert.equal(
      outcome.code,
      0,
      `a "subscriber" connection took the process down (exit ${String(outcome.code)}): ${outcome.stderr}`,
    );
    assert.doesNotMatch(outcome.stderr, /UNHANDLED/);
  });

  test('"command" does not — the control that proves the reconnect really happens', async () => {
    const outcome = await runChild("command");

    assert.equal(
      outcome.code,
      1,
      'a "command" connection survived the same sequence — the harness is no longer provoking the re-issued subscribe, so the subtest above proves nothing',
    );
    assert.match(outcome.stderr, /UNHANDLED Command timed out/);
  });
});
