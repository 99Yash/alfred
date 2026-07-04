import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Elysia } from "elysia";

import { errorHandler } from "../src/middleware/error-handler";
import { securityHeaders } from "../src/middleware/security-headers";

/** Headers every API response must carry, regardless of HSTS. */
const EXPECTED: Readonly<Record<string, string>> = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function assertBaseHeaders(res: Response): void {
  for (const [name, value] of Object.entries(EXPECTED)) {
    assert.equal(res.headers.get(name), value, `header ${name}`);
  }
}

describe("securityHeaders", () => {
  test("sets the full header set on a normal 200 response", async () => {
    const app = new Elysia().use(securityHeaders({ hsts: true })).get("/ok", () => ({ ok: true }));

    const res = await app.handle(new Request("http://localhost/ok"));
    assert.equal(res.status, 200);
    assertBaseHeaders(res);
  });

  test("still sets headers on a 404 and on an error response", async () => {
    const app = new Elysia()
      .use(errorHandler)
      .use(securityHeaders())
      .get("/boom", () => {
        throw new Error("kaboom");
      });

    const notFound = await app.handle(new Request("http://localhost/nope"));
    assert.equal(notFound.status, 404);
    assertBaseHeaders(notFound);

    const errored = await app.handle(new Request("http://localhost/boom"));
    assert.equal(errored.status, 500);
    assertBaseHeaders(errored);
  });

  test("covers a .mount()ed sub-handler (mirrors the mounted Better Auth handler)", async () => {
    const app = new Elysia()
      .use(securityHeaders())
      .mount("/mounted", () => new Response("hi from mount"));

    const res = await app.handle(new Request("http://localhost/mounted"));
    assert.equal(await res.text(), "hi from mount");
    assertBaseHeaders(res);
  });

  test("emits HSTS only when enabled", async () => {
    const withHsts = new Elysia().use(securityHeaders({ hsts: true })).get("/", () => "ok");
    const withoutHsts = new Elysia().use(securityHeaders({ hsts: false })).get("/", () => "ok");

    const on = await withHsts.handle(new Request("http://localhost/"));
    const off = await withoutHsts.handle(new Request("http://localhost/"));

    assert.equal(
      on.headers.get("strict-transport-security"),
      "max-age=63072000; includeSubDomains; preload",
    );
    assert.equal(off.headers.get("strict-transport-security"), null);
  });

  test("web Caddyfile pins the current inline index.html scripts by hash", () => {
    const html = readFileSync(resolve(REPO_ROOT, "apps/web/index.html"), "utf8");
    const caddyfile = readFileSync(resolve(REPO_ROOT, "Caddyfile"), "utf8");
    const scripts = Array.from(
      html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g),
      (match) => match[1] ?? "",
    );

    const expectedHashes = scripts.map(
      (script) => `sha256-${createHash("sha256").update(script).digest("base64")}`,
    );
    const caddyHashes = Array.from(
      (caddyfile.match(/^.*Content-Security-Policy .*$/m)?.[0] ?? "").matchAll(/'sha256-([^']+)'/g),
      (match) => `sha256-${match[1]}`,
    );

    assert.deepEqual(caddyHashes, expectedHashes);
  });

  test("web Caddyfile exposes env-backed CSP origins for non-production deploys", () => {
    const caddyfile = readFileSync(resolve(REPO_ROOT, "Caddyfile"), "utf8");
    for (const name of [
      "WEB_CSP_API_ORIGIN",
      "WEB_CSP_POSTHOG_ASSET_ORIGIN",
      "WEB_CSP_POSTHOG_CONNECT_SRC",
      "WEB_CSP_SENTRY_CONNECT_SRC",
    ]) {
      assert.match(caddyfile, new RegExp(String.raw`\{\$${name}:`), `${name} placeholder`);
    }
  });
});
