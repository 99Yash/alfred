import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test } from "node:test";
import { WebSocket } from "undici";

import { EMAIL_CSP_META, sanitizeEmailHtml } from "../../src/modules/me/email-html";

const LOOSE_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="` +
  `default-src 'none'; img-src http: https: data: cid:; media-src http: https:; font-src 'none'; ` +
  `connect-src 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; ` +
  `style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`;

const CHROME_STARTUP_TIMEOUT_MS = process.env.CI ? 60_000 : 10_000;
const CHROME_POLL_INTERVAL_MS = 100;
const CHROME_STDERR_TAIL_LINES = 40;

interface Counts {
  pixel: number;
  background: number;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface CdpClient {
  send: (method: string, params?: object) => Promise<CdpMessage>;
  waitForEvent: (method: string, timeoutMs?: number) => Promise<CdpMessage>;
  close: () => void;
}

const CHROME = findChrome();

describe(
  "email original CSP in a real browser (#294)",
  { skip: CHROME ? false : "Chrome not found" },
  () => {
    test("remote image and CSS background requests happen only after explicit opt-in", async () => {
      const fixture = await startFixtureServer();
      const chrome = await startChrome();
      try {
        const cdp = await connectToFirstPage(chrome.debugPort);
        try {
          await cdp.send("Page.enable");
          await cdp.send("Runtime.enable");
          await cdp.send("Page.navigate", { url: fixture.url });
          await cdp.waitForEvent("Page.loadEventFired");

          await delay(800);
          assert.deepEqual(
            fixture.counts,
            { pixel: 0, background: 0 },
            "strict CSP must block sender-hosted media on Original open",
          );

          await cdp.send("Runtime.evaluate", {
            expression: `document.querySelector("[data-load-remote]")?.click()`,
            awaitPromise: false,
          });
          await delay(1_000);

          assert.ok(fixture.counts.pixel > 0, "remote <img> loads after opt-in");
          assert.ok(
            fixture.counts.background > 0,
            "remote CSS background image loads after opt-in",
          );
        } finally {
          cdp.close();
        }
      } finally {
        await chrome.close();
        await fixture.close();
      }
    });
  },
);

function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      // `spawnSync` would work too, but `accessSync` keeps this check cheap and
      // avoids starting Chrome just to decide whether the optional test runs.
      accessSync(candidate);
      return candidate;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

async function startFixtureServer(): Promise<{
  url: string;
  counts: Counts;
  close: () => Promise<void>;
}> {
  const counts: Counts = { pixel: 0, background: 0 };
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const reqUrl = req.url ?? "/";
    if (reqUrl.startsWith("/pixel")) {
      counts.pixel += 1;
      res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" });
      res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
      return;
    }
    if (reqUrl.startsWith("/background")) {
      counts.background += 1;
      res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" });
      res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
      return;
    }
    if (reqUrl.startsWith("/page")) {
      const origin = `http://127.0.0.1:${addressPort(server)}`;
      const strict = sanitizeEmailHtml(`
        <html>
          <head><title>remote media fixture</title></head>
          <body>
            <img alt="tracker" src="${origin}/pixel">
            <style>
              .remote-bg {
                width: 20px;
                height: 20px;
                background-image: url("${origin}/background");
              }
            </style>
            <div class="remote-bg">body</div>
          </body>
        </html>
      `);
      assert.ok(strict);
      const loose = strict.replace(EMAIL_CSP_META, LOOSE_CSP_META);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <meta charset="utf-8">
        <button data-load-remote type="button">Display remote media</button>
        <iframe id="email" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>
        <script>
          const strict = ${JSON.stringify(strict)};
          const loose = ${JSON.stringify(loose)};
          const frame = document.getElementById("email");
          frame.srcdoc = strict;
          document.querySelector("[data-load-remote]").addEventListener("click", () => {
            frame.srcdoc = loose;
          });
        </script>`);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${addressPort(server)}/page`,
    counts,
    close: () => closeFixtureServer(server, sockets),
  };
}

async function closeFixtureServer(server: http.Server, sockets: Set<Socket>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const forceClose = setTimeout(() => {
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    }, 500);
    forceClose.unref();

    server.close((err) => {
      clearTimeout(forceClose);
      if (err) reject(err);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

async function startChrome(): Promise<{
  debugPort: number;
  close: () => Promise<void>;
}> {
  assert.ok(CHROME);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "alfred-email-csp-"));
  const stderrLines: string[] = [];
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--no-first-run",
      "--no-sandbox",
      "--remote-debugging-address=127.0.0.1",
      // Port 0 lets Chrome pick, then announce, the port it actually bound.
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrLines.push(...chunk.split(/\r?\n/).filter(Boolean));
    if (stderrLines.length > CHROME_STDERR_TAIL_LINES) {
      stderrLines.splice(0, stderrLines.length - CHROME_STDERR_TAIL_LINES);
    }
  });

  let debugPort: number;
  try {
    debugPort = await waitForChrome(userDataDir, child, () => stderrLines.join("\n"));
  } catch (err) {
    await stopChrome(child, userDataDir);
    throw err;
  }

  return {
    debugPort,
    close: async () => {
      await stopChrome(child, userDataDir);
    },
  };
}

async function waitForChrome(
  userDataDir: string,
  child: ChildProcess,
  stderrTail: () => string,
): Promise<number> {
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + CHROME_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Chrome exited early with ${child.exitCode}${formatChromeStderr(stderrTail())}`,
      );
    }
    const port = await readDevToolsPort(portFile);
    if (port !== null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) return port;
      } catch {
        /* announced but not accepting yet — keep polling */
      }
    }
    await delay(CHROME_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for Chrome DevTools${formatChromeStderr(stderrTail())}`);
}

/**
 * Chrome writes `DevToolsActivePort` only once the debugger is listening: line 1
 * is the port it actually bound, line 2 the browser target path. Reading the port
 * Chrome chose beats dictating one — reserving a port by opening and closing a
 * server leaves a window where another process takes it, and `node --test` runs
 * test files concurrently, so that window is contended.
 */
async function readDevToolsPort(portFile: string): Promise<number | null> {
  let contents: string;
  try {
    contents = await readFile(portFile, "utf8");
  } catch {
    return null;
  }
  // Both lines present means the write flushed; a lone port line may be partial.
  const [portLine, targetLine] = contents.split("\n");
  if (!portLine || targetLine === undefined) return null;
  const port = Number.parseInt(portLine, 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

async function stopChrome(child: ChildProcess, userDataDir: string): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await waitForExit(child, 5_000);
  await rm(userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function connectToFirstPage(debugPort: number): Promise<CdpClient> {
  const targets = (await fetchJson(`http://127.0.0.1:${debugPort}/json/list`)) as Array<{
    type: string;
    webSocketDebuggerUrl?: string;
  }>;
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) throw new Error("No Chrome page target found");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), {
      once: true,
    });
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (message: CdpMessage) => void; reject: (err: Error) => void }
  >();
  const listeners = new Map<string, Array<(message: CdpMessage) => void>>();

  ws.addEventListener("message", (event: { data: unknown }) => {
    const message = parseCdpMessage(event.data);
    if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message);
      return;
    }
    if (message.method) {
      const waiters = listeners.get(message.method) ?? [];
      listeners.delete(message.method);
      for (const resolve of waiters) resolve(message);
    }
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      const payload = JSON.stringify({ id, method, params });
      return new Promise<CdpMessage>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(payload);
      });
    },
    waitForEvent(method, timeoutMs = 5_000) {
      return new Promise<CdpMessage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${method}`)),
          timeoutMs,
        );
        const wrapped = (message: CdpMessage) => {
          clearTimeout(timer);
          resolve(message);
        };
        const waiters = listeners.get(method) ?? [];
        waiters.push(wrapped);
        listeners.set(method, waiters);
      });
    },
    close() {
      ws.close();
    },
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  return await res.json();
}

function parseCdpMessage(data: unknown): CdpMessage {
  const text = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
  return JSON.parse(text) as CdpMessage;
}

function formatChromeStderr(stderr: string): string {
  return stderr ? `\nChrome stderr:\n${stderr}` : "";
}

function addressPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind to a port");
  return address.port;
}
