import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { after, before, describe, test } from "node:test";

/**
 * A failed SUBSCRIBE must not make this replica permanently deaf.
 *
 * The bus refcounts SSE listeners per user and holds one Redis channel per
 * user. Those are two different facts, and while they were one Map a single
 * rejected SUBSCRIBE was terminal: the refcount had already been incremented,
 * so no later listener passed the "first listener" test and re-issued the
 * subscription, and ioredis will not re-issue it either — its auto-resubscribe
 * reads the channel list from `condition.subscriber`, which is populated only
 * from a SUBSCRIBE REPLY that never arrived, and on the `"subscriber"` kind that
 * auto-resubscribe is switched off outright because it is uncaught. Every poke
 * for that user was then dropped for the lifetime of the process.
 *
 * Two recovery paths, and the second subtest exists because the first one alone
 * is not enough. A LATER listener re-issuing the subscription only helps if a
 * later listener arrives; a listener that was already attached when its
 * SUBSCRIBE failed has no such rescuer, and stayed deaf for the life of its SSE
 * stream even after Redis came back. The connection's `ready` event is what
 * recovers it, and `ready` is also the only thing that re-subscribes after an
 * ordinary reconnect, because ioredis no longer does.
 *
 * The Redis here is a real socket speaking just enough RESP to refuse a
 * SUBSCRIBE on demand and to drop its connections. A mock of the bus's own
 * connection could not show either subtest: the defect is in which commands
 * reach the wire, and only the wire can count them.
 *
 * `user-events-bus.ts` carries the identical pair of structures and the identical
 * `ready` handler for the same reason. It is not separately pinned here — the two
 * files are deliberate mirrors, and this test is what documents the shape.
 */

/**
 * Format-valid dummies for `serverEnv()`, which is all-or-nothing: without them
 * `isQueueEnabled()` returns false and the bridge quietly does nothing, so the
 * test would pass while measuring nothing. `??=`, so the `assistant-unit-tests`
 * CI job's own `env:` block wins where it has an opinion.
 */
const ENV_DUMMIES: Readonly<Record<string, string>> = {
  DATABASE_URL: "postgresql://ci:ci@localhost:5432/alfred_ci",
  BETTER_AUTH_SECRET: "ci-dummy-better-auth-secret-32chars-min",
  OAUTH_CREDENTIAL_KEK: "Y2ktZHVtbXkta2VrLTMyLWJ5dGVzLW5vdC1zZWNyZXQ",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALFRED_ALLOWED_EMAIL: "ci@example.com",
  RESEND_API_KEY: "re_ci_dummy",
  RESEND_FROM_EMAIL: "Alfred <noreply@example.com>",
  ANTHROPIC_API_KEY: "ci-dummy",
  GOOGLE_GENERATIVE_AI_API_KEY: "ci-dummy",
  GOOGLE_OAUTH_CLIENT_ID: "ci-dummy",
  GOOGLE_OAUTH_CLIENT_SECRET: "ci-dummy",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/integrations/google/callback",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "ci-dummy",
  GITHUB_APP_CLIENT_ID: "ci-dummy",
  GITHUB_APP_CLIENT_SECRET: "ci-dummy",
  GITHUB_APP_PRIVATE_KEY: "ci-dummy",
  GITHUB_WEBHOOK_SECRET: "ci-dummy",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
};

/** One user per subtest: the bus is a module singleton and keeps its refcounts. */
const LATER_LISTENER_USER = "poke-recovery-user";
const RECONNECT_USER = "poke-reconnect-user";
const DEADLINE_MS = 5_000;

/** Split one inbound RESP array into its arguments. Returns null if incomplete. */
function readCommand(buffer: string): { args: string[]; rest: string } | null {
  if (!buffer.startsWith("*")) return null;
  const lines = buffer.split("\r\n");
  const count = Number(lines[0]?.slice(1));
  if (!Number.isInteger(count) || count < 0) return null;
  // Each argument is a `$len` line plus its payload line.
  if (lines.length < 1 + count * 2) return null;
  const args: string[] = [];
  for (let index = 0; index < count; index++) {
    const value = lines[2 + index * 2];
    if (value === undefined) return null;
    args.push(value);
  }
  const consumed = lines.slice(0, 1 + count * 2).join("\r\n").length + 2;
  return { args, rest: buffer.slice(consumed) };
}

function bulk(value: string): string {
  return `$${String(Buffer.byteLength(value))}\r\n${value}\r\n`;
}

/**
 * A Redis that refuses a SUBSCRIBE whenever the test says to, counts the
 * SUBSCRIBE frames it received per channel, and can drop its connections to make
 * the client reconnect.
 */
class FlakySubscribeRedis {
  /** Set by the test around the SUBSCRIBE it wants to fail. */
  refuseSubscribes = false;
  private readonly subscribesByChannel = new Map<string, number>();
  private readonly sockets = new Set<Socket>();
  private constructor(private readonly server: Server) {}

  static async start(): Promise<FlakySubscribeRedis> {
    let self: FlakySubscribeRedis | undefined;
    const server = createServer((socket) => {
      self?.attach(socket);
    });
    self = new FlakySubscribeRedis(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return self;
  }

  private attach(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => this.sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const parsed = readCommand(buffer);
        if (!parsed) return;
        buffer = parsed.rest;
        socket.write(this.reply(parsed.args));
      }
    });
  }

  /** SUBSCRIBE frames received for `channel`, refused ones included. */
  subscribesFor(channel: string): number {
    return this.subscribesByChannel.get(channel) ?? 0;
  }

  /** Cut every live connection. The server keeps listening, so the client reconnects. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  private reply(args: string[]): string {
    const name = (args[0] ?? "").toLowerCase();
    const channel = args[1] ?? "";
    if (name === "subscribe") {
      this.subscribesByChannel.set(channel, this.subscribesFor(channel) + 1);
      if (this.refuseSubscribes) return "-ERR simulated subscribe failure\r\n";
      return `*3\r\n${bulk("subscribe")}${bulk(channel)}:1\r\n`;
    }
    if (name === "unsubscribe") return `*3\r\n${bulk("unsubscribe")}${bulk(channel)}:0\r\n`;
    // CLIENT SETINFO and anything else ioredis sends during its handshake.
    return "+OK\r\n";
  }

  get url(): string {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error(`unexpected address: ${String(address)}`);
    }
    return `redis://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("replicache poke bus recovers from a rejected SUBSCRIBE", () => {
  let redis: FlakySubscribeRedis;
  let bus: typeof import("../../src/realtime/replicache-events");
  let db: typeof import("@alfred/db/redis");

  before(async () => {
    redis = await FlakySubscribeRedis.start();
    for (const [key, value] of Object.entries(ENV_DUMMIES)) process.env[key] ??= value;
    // Unconditional: an ambient REDIS_URL pointing at a healthy Redis would
    // make the first SUBSCRIBE succeed and delete the whole point of the file.
    process.env["REDIS_URL"] = redis.url;

    bus = await import("../../src/realtime/replicache-events");
    db = await import("@alfred/db/redis");
    const { serverEnv } = await import("@alfred/env/server");
    assert.equal(serverEnv().REDIS_URL, redis.url, "the REDIS_URL override did not land");

    await bus.initReplicachePokeBridge();
  });

  after(async () => {
    await bus.closeReplicachePokeBridge();
    await db.closeRedis();
    await redis.stop();
  });

  test("a later listener re-issues a subscription the first one failed to open", async () => {
    const channel = `replicache-pokes:u:${LATER_LISTENER_USER}`;
    redis.refuseSubscribes = true;

    const first = bus.subscribeUserPokes(LATER_LISTENER_USER, () => {});
    await waitFor(() => redis.subscribesFor(channel) >= 1, "the first SUBSCRIBE to reach Redis");
    // The rejection has to be delivered and handled before the second listener
    // arrives, or this measures the in-flight guard instead of the recovery.
    await new Promise((resolve) => setTimeout(resolve, 100));
    redis.refuseSubscribes = false;

    const second = bus.subscribeUserPokes(LATER_LISTENER_USER, () => {});
    await waitFor(
      () => redis.subscribesFor(channel) >= 2,
      "a SECOND SUBSCRIBE — a rejected one left the refcount claiming this replica was already subscribed, so no later listener re-issued it and every poke for the user was dropped",
    );

    first();
    second();
  });

  test("a listener that was ALREADY attached recovers when the connection comes back", async () => {
    const channel = `replicache-pokes:u:${RECONNECT_USER}`;
    redis.refuseSubscribes = true;

    // Exactly one listener, and no second one ever arrives. This is the SSE
    // stream that was already open when Redis blipped: the subtest above cannot
    // save it, because its rescuer is a listener that may never come.
    const only = bus.subscribeUserPokes(RECONNECT_USER, () => {});
    await waitFor(() => redis.subscribesFor(channel) >= 1, "the first SUBSCRIBE to reach Redis");
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Redis comes back: the socket drops, ioredis reconnects to the same
    // listening server and reaches `ready`.
    redis.refuseSubscribes = false;
    redis.dropConnections();

    await waitFor(
      () => redis.subscribesFor(channel) >= 2,
      "a SECOND SUBSCRIBE after the reconnect, with no new listener — without the bus's own `ready` handler nothing re-issues it: ioredis's auto-resubscribe is off on the `\"subscriber\"` kind (it is uncaught, and an uncaught rejection exits the server) and it would not have re-issued this one anyway, because it re-reads the channel list from a SUBSCRIBE REPLY that never arrived",
    );

    only();
  });
});
