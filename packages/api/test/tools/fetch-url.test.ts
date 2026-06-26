import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  decodeEntities,
  FetchError,
  htmlToText,
  isBlockedHost,
  isBlockedIp,
  MAX_TEXT_CHARS,
  runFetchUrl,
  type RawResponse,
  type Transport,
} from "../../src/modules/tools/fetch-url";

/**
 * Pins the pure surface of `system.fetch_url` (#286, ADR-0071 honest read-in):
 * HTML→text extraction, entity decoding, the SSRF IP/host classifiers, and the
 * content-type / size / binary-sniff handling in `runFetchUrl` (with the network
 * transport stubbed). The live connect-time pinning + redirect path is covered by
 * smoke-fetch-url.ts.
 */

describe("decodeEntities", () => {
  test("named + numeric + hex entities", () => {
    assert.equal(decodeEntities("Tom &amp; Jerry"), "Tom & Jerry");
    assert.equal(decodeEntities("a &lt; b &gt; c"), "a < b > c");
    assert.equal(decodeEntities("&#39;quoted&#39;"), "'quoted'");
    assert.equal(decodeEntities("&#x2014;"), "—");
    assert.equal(decodeEntities("caf&eacute;".replace("eacute", "#233")), "café");
  });

  test("leaves unknown entities untouched rather than mangling", () => {
    assert.equal(decodeEntities("&notareal;"), "&notareal;");
  });
});

describe("htmlToText", () => {
  test("drops script/style/head, keeps body copy", () => {
    const html = `
      <html><head><title>T</title><style>.a{color:red}</style></head>
      <body><script>alert(1)</script><h1>Hello</h1><p>World copy.</p></body></html>`;
    const text = htmlToText(html);
    assert.match(text, /Hello/);
    assert.match(text, /World copy\./);
    assert.doesNotMatch(text, /alert/);
    assert.doesNotMatch(text, /color:red/);
  });

  test("blocks become line breaks; list items become bullets", () => {
    const text = htmlToText("<p>one</p><p>two</p><ul><li>a</li><li>b</li></ul>");
    assert.equal(text, "one\n\ntwo\n\n- a\n- b");
  });

  test("collapses whitespace and caps blank-line runs", () => {
    const text = htmlToText("<p>x</p>\n\n\n\n\n<p>y</p>     <span>z</span>");
    assert.equal(text, "x\n\ny\nz");
  });

  test("strips control bytes (keeps newline)", () => {
    const text = htmlToText("a\u0000\u0007b\nc");
    assert.equal(text, "ab\nc");
  });
});

describe("isBlockedIp", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "192.0.0.1", // IETF protocol assignments
    "192.0.2.1", // documentation
    "192.31.196.1", // AS112
    "192.52.193.1", // AMT
    "192.88.99.1", // deprecated 6to4 relay anycast
    "192.175.48.1", // AS112
    "198.18.0.1", // benchmarking
    "198.19.255.255", // benchmarking
    "198.51.100.1", // documentation
    "203.0.113.1", // documentation
    "240.0.0.1", // reserved
    "255.255.255.255", // broadcast
    "::1",
    "::",
    "::7f00:1", // IPv4-compatible loopback (hex)
    "::127.0.0.1", // IPv4-compatible loopback (dotted)
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fec0::1",
    "ff00::1",
    "ff02::1",
    "64:ff9b:1::1",
    "100::1",
    "2001:2::1",
    "2001:db8::1",
    "2002:7f00:1::", // 6to4 embedding 127.0.0.1
    "3fff::1",
    "64:ff9b::7f00:1", // NAT64 embedding 127.0.0.1
    "239.0.0.1", // multicast
    "::ffff:127.0.0.1", // IPv4-mapped loopback (dotted)
    "::ffff:7f00:1", // IPv4-mapped loopback (hex)
    "::ffff:169.254.169.254", // IPv4-mapped metadata
    "::ffff:198.18.0.1", // IPv4-mapped benchmarking range
  ]) {
    test(`blocks ${ip}`, () => assert.equal(isBlockedIp(ip), true));
  }

  for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1", "::ffff:1.1.1.1"]) {
    test(`allows ${ip}`, () => assert.equal(isBlockedIp(ip), false));
  }
});

describe("isBlockedHost", () => {
  for (const host of [
    "localhost",
    "foo.localhost",
    "service.internal",
    "printer.local",
    "127.0.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "203.0.113.1",
    "[::1]",
    "[::7f00:1]",
    "[::ffff:127.0.0.1]",
  ]) {
    test(`blocks ${host}`, () => assert.equal(isBlockedHost(host), true));
  }

  // A public name that *resolves* to a private IP (e.g. 127.0.0.1.nip.io) passes
  // the string check and is caught at connect time — not here.
  for (const host of [
    "example.com",
    "www.yashk.xyz",
    "8.8.8.8",
    "github.com",
    "127.0.0.1.nip.io",
  ]) {
    test(`allows ${host}`, () => assert.equal(isBlockedHost(host), false));
  }
});

describe("runFetchUrl (stubbed transport)", () => {
  function streamOf(...parts: Array<string | Uint8Array>): AsyncIterable<Uint8Array> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const p of parts) yield typeof p === "string" ? new TextEncoder().encode(p) : p;
      },
    };
  }

  function transportOf(
    res: Omit<Partial<RawResponse>, "body"> & { body?: string | Uint8Array[] },
  ): Transport {
    // RawResponse.contentType is bare (no params) — safeRequest strips them, so
    // the stub does too, letting tests pass a realistic full header.
    const contentTypeHeader = res.contentType ?? "text/html";
    const bare = contentTypeHeader.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const charsetMatch = /(?:^|;)\s*charset\s*=\s*("?)([^";]+)\1/i.exec(contentTypeHeader);
    return async () => ({
      finalUrl: res.finalUrl ?? "https://example.com/",
      status: res.status ?? 200,
      contentType: bare,
      charset: res.charset ?? charsetMatch?.[2]?.trim().toLowerCase() ?? null,
      contentLength: res.contentLength ?? null,
      body: Array.isArray(res.body) ? streamOf(...res.body) : streamOf(res.body ?? ""),
    });
  }

  function destroyableBody(): AsyncIterable<Uint8Array> & {
    readonly destroyed: boolean;
    destroy: () => void;
  } {
    let destroyed = false;
    return {
      get destroyed() {
        return destroyed;
      },
      destroy() {
        destroyed = true;
      },
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode("ignored body");
      },
    };
  }

  // These run the real transport: each is refused by validateUrl *before* any
  // socket is opened, so there's no network to stub.
  test("rejects a non-http scheme before any socket", async () => {
    const r = await runFetchUrl({ url: "ftp://example.com/x" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "blocked_host");
  });

  test("rejects a private host before any socket", async () => {
    const r = await runFetchUrl({ url: "http://192.168.1.1/admin" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "blocked_host");
  });

  test("rejects a URL that embeds credentials before any socket", async () => {
    const r = await runFetchUrl({ url: "https://user:pw@example.com/" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "blocked_host");
  });

  test("reads an HTML page into text + title", async () => {
    const r = await runFetchUrl(
      { url: "https://www.yashk.xyz" },
      {
        transport: transportOf({
          finalUrl: "https://www.yashk.xyz/",
          contentType: "text/html; charset=utf-8",
          body: "<html><head><title>Yash</title></head><body><h1>Hi</h1><p>copy</p></body></html>",
        }),
      },
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.title, "Yash");
      assert.match(r.text, /Hi/);
      assert.match(r.text, /copy/);
      assert.equal(r.truncated, false);
      assert.equal(r.contentType, "text/html");
    }
  });

  test("passes plain text through without HTML stripping", async () => {
    const r = await runFetchUrl(
      { url: "https://example.com/robots.txt" },
      {
        transport: transportOf({
          contentType: "text/plain",
          body: "line one\nline two <not a tag>",
        }),
      },
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.text, /<not a tag>/);
      assert.equal(r.contentType, "text/plain");
    }
  });

  test("decodes a declared non-UTF-8 charset", async () => {
    const r = await runFetchUrl(
      { url: "https://example.com/latin1.txt" },
      {
        transport: transportOf({
          contentType: "text/plain; charset=iso-8859-1",
          body: [new Uint8Array([0x63, 0x61, 0x66, 0xe9])],
        }),
      },
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.text, "café");
  });

  test("does not default unknown content to HTML", async () => {
    const r = await runFetchUrl(
      { url: "https://example.com/data" },
      { transport: transportOf({ contentType: "", body: "just some plain words" }) },
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.contentType, "text/plain");
  });

  test("refuses a binary content type honestly", async () => {
    const r = await runFetchUrl(
      { url: "https://example.com/resume.pdf" },
      { transport: transportOf({ contentType: "application/pdf", body: "%PDF-1.7" }) },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "unsupported_content_type");
      assert.match(r.message, /application\/pdf/);
    }
  });

  test("disposes the body when refusing a binary content type", async () => {
    const body = destroyableBody();
    const r = await runFetchUrl(
      { url: "https://example.com/resume.pdf" },
      {
        transport: async () => ({
          finalUrl: "https://example.com/resume.pdf",
          status: 200,
          contentType: "application/pdf",
          charset: null,
          contentLength: null,
          body,
        }),
      },
    );
    assert.equal(r.ok, false);
    assert.equal(body.destroyed, true);
  });

  test("refuses a binary body even when Content-Type lies (sniff)", async () => {
    const r = await runFetchUrl(
      { url: "https://example.com/sneaky" },
      { transport: transportOf({ contentType: "text/html", body: "%PDF-1.7\n%binary" }) },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "unsupported_content_type");
  });

  test("refuses a body with a NUL byte (not UTF-8 text)", async () => {
    const r = await runFetchUrl(
      { url: "https://example.com/blob" },
      { transport: transportOf({ contentType: "text/plain", body: "ok\u0000then binary" }) },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "unsupported_content_type");
  });

  test("refuses a body with a late NUL byte beyond the sniff head", async () => {
    const r = await runFetchUrl(
      { url: "https://example.com/blob" },
      { transport: transportOf({ contentType: "text/plain", body: `${"a".repeat(2048)}\u0000` }) },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "unsupported_content_type");
  });

  test("maps a transport blocked_host error (e.g. redirect into private space)", async () => {
    const transport: Transport = async () => {
      throw new FetchError(
        "blocked_host",
        "The URL redirected to a private host.",
        "http://169.254.169.254/",
      );
    };
    const r = await runFetchUrl({ url: "https://example.com/redirector" }, { transport });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "blocked_host");
      assert.equal(r.finalUrl, "http://169.254.169.254/");
    }
  });

  test("surfaces an HTTP error status", async () => {
    const r = await runFetchUrl(
      { url: "https://example.com/missing" },
      { transport: transportOf({ status: 404, contentType: "text/html" }) },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "http_error");
      assert.match(r.message, /404/);
    }
  });

  test("disposes the body when surfacing an HTTP error", async () => {
    const body = destroyableBody();
    const r = await runFetchUrl(
      { url: "https://example.com/missing" },
      {
        transport: async () => ({
          finalUrl: "https://example.com/missing",
          status: 404,
          contentType: "text/html",
          charset: null,
          contentLength: null,
          body,
        }),
      },
    );
    assert.equal(r.ok, false);
    assert.equal(body.destroyed, true);
  });

  test("refuses an oversized body via declared content-length", async () => {
    const r = await runFetchUrl(
      { url: "https://example.com/huge" },
      { transport: transportOf({ contentType: "text/html", contentLength: 50_000_000 }) },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "too_large");
  });

  test("disposes the body when declared content-length is too large", async () => {
    const body = destroyableBody();
    const r = await runFetchUrl(
      { url: "https://example.com/huge" },
      {
        transport: async () => ({
          finalUrl: "https://example.com/huge",
          status: 200,
          contentType: "text/html",
          charset: null,
          contentLength: 50_000_000,
          body,
        }),
      },
    );
    assert.equal(r.ok, false);
    assert.equal(body.destroyed, true);
  });

  test("refuses an oversized chunked body with no content-length (streamed bound)", async () => {
    // 9 × 1MB chunks, no declared length — must abort, not buffer it all.
    const chunk = new Uint8Array(1_000_000).fill(0x61); // 'a'
    const r = await runFetchUrl(
      { url: "https://example.com/chunked" },
      {
        transport: transportOf({
          contentType: "text/plain",
          body: Array.from({ length: 9 }, () => chunk),
        }),
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "too_large");
  });

  test("truncates a body past the char cap and flags it", async () => {
    const r = await runFetchUrl(
      { url: "https://example.com/long.txt" },
      {
        transport: transportOf({
          contentType: "text/plain",
          body: "x".repeat(MAX_TEXT_CHARS + 5_000),
        }),
      },
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.truncated, true);
      assert.equal(r.chars, MAX_TEXT_CHARS);
    }
  });
});
