import assert from "node:assert/strict";
import { describe, test } from "node:test";

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

function assertBaseHeaders(res: Response): void {
  for (const [name, value] of Object.entries(EXPECTED)) {
    assert.equal(res.headers.get(name), value, `header ${name}`);
  }
}

describe("securityHeaders", () => {
  test("sets the full header set on a normal 200 response", async () => {
    const app = new Elysia()
      .use(securityHeaders({ hsts: true }))
      .get("/ok", () => ({ ok: true }));

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
    const withHsts = new Elysia()
      .use(securityHeaders({ hsts: true }))
      .get("/", () => "ok");
    const withoutHsts = new Elysia()
      .use(securityHeaders({ hsts: false }))
      .get("/", () => "ok");

    const on = await withHsts.handle(new Request("http://localhost/"));
    const off = await withoutHsts.handle(new Request("http://localhost/"));

    assert.equal(
      on.headers.get("strict-transport-security"),
      "max-age=63072000; includeSubDomains; preload",
    );
    assert.equal(off.headers.get("strict-transport-security"), null);
  });
});
