import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import {
  decodeEntities,
  decodeResponseBody,
  FetchError,
  htmlToText,
  isBlockedHost,
  isBlockedIp,
  MAX_TEXT_CHARS,
  pinningLookup,
  redactCredentialUrl,
  runFetchUrl,
  safeRequest,
  type DnsLookupAll,
  type HttpRequester,
  type RawResponse,
  type Transport,
  type UndiciResponseLike,
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
    if (!r.ok) {
      assert.equal(r.reason, "blocked_host");
      assert.doesNotMatch(JSON.stringify(r), /user:pw/);
      assert.match(JSON.stringify(r), /\[REDACTED]@example\.com/);
    }
  });

  // #292 — non-default / scheme-mismatched ports are refused in validateUrl, so
  // the real transport throws before any socket; no network to stub.
  for (const url of [
    "http://example.com:8080/admin",
    "https://example.com:8443/",
    "http://example.com:443/", // scheme/port mismatch
    "https://example.com:80/", // scheme/port mismatch
  ]) {
    test(`#292 rejects non-default port ${url} before any socket`, async () => {
      const r = await runFetchUrl({ url });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "blocked_port");
    });
  }

  // #293 — credential-bearing query params are refused before any socket.
  for (const url of [
    "https://example.com/cb?code=abc123",
    "https://example.com/?access_token=xyz",
    "https://example.com/?session-token=zzz", // segment stem
    "https://example.com/?X-Amz-Signature=deadbeef",
    "https://example.com/?key=sk_live_42",
    "https://example.com/?access%20token=spacesecret",
    "https://example.com/?client+secret=plussecret",
  ]) {
    test(`#293 rejects credential URL ${url} before any socket`, async () => {
      const r = await runFetchUrl({ url });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.reason, "credential_url");
        // The error's url/finalUrl must not echo the secret back.
        assert.doesNotMatch(
          JSON.stringify(r),
          /abc123|sk_live_42|deadbeef|\bxyz\b|zzz|spacesecret|plussecret/,
        );
      }
    });
  }

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

  test("#293 redacts a credential fragment on the OK path (fragment is fetched, not blocked)", async () => {
    // A `#access_token=…` fragment is never sent to the server, so the fetch
    // succeeds — but the persisted result must not echo the secret.
    const r = await runFetchUrl(
      { url: "https://example.com/page#access_token=secretfrag&state=ok" },
      { transport: transportOf({ finalUrl: "https://example.com/page", body: "<p>hi</p>" }) },
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.url, /access_token=\[REDACTED\]/);
      assert.match(r.url, /state=ok/); // non-credential params survive
      assert.doesNotMatch(r.url, /secretfrag/);
    }
  });

  test("#293 redacts credential params in finalUrl and the redirect chain", async () => {
    const transport: Transport = async () => ({
      finalUrl: "https://example.com/landing?token=finalsecret&page=2",
      status: 200,
      contentType: "text/html",
      charset: null,
      contentLength: null,
      redirectChain: ["https://example.com/start?sig=hopsecret"],
      body: streamOf("<p>ok</p>"),
    });
    const r = await runFetchUrl({ url: "https://example.com/start" }, { transport });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.finalUrl, /token=\[REDACTED\]/);
      assert.match(r.finalUrl, /page=2/);
      assert.deepEqual(r.redirects, ["https://example.com/start?sig=[REDACTED]"]);
      assert.doesNotMatch(JSON.stringify(r), /finalsecret|hopsecret/);
    }
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

describe("redactCredentialUrl (#293 matcher + redaction)", () => {
  // Credential-bearing params → value replaced, everything else verbatim.
  for (const [input, expected] of [
    ["https://h/cb?code=abc", "https://h/cb?code=[REDACTED]"],
    ["https://h/?access_token=x&page=2", "https://h/?access_token=[REDACTED]&page=2"],
    ["https://h/?session-token=x", "https://h/?session-token=[REDACTED]"], // segment stem
    ["https://h/?auth.code=x", "https://h/?auth.code=[REDACTED]"], // segment stem
    ["https://h/?accessToken=x", "https://h/?accessToken=[REDACTED]"], // camelCase segment
    ["https://h/?X-Amz-Signature=x", "https://h/?X-Amz-Signature=[REDACTED]"],
    ["https://h/?access%20token=x", "https://h/?access%20token=[REDACTED]"],
    ["https://h/?client+secret=x", "https://h/?client+secret=[REDACTED]"],
    ["https://h/?key=x", "https://h/?key=[REDACTED]"], // exact-name blunt instrument
    ["https://h/p#access_token=x&state=ok", "https://h/p#access_token=[REDACTED]&state=ok"],
    [
      "https://user:pw@example.com/path?token=x",
      "https://[REDACTED]@example.com/path?token=[REDACTED]",
    ],
  ] as const) {
    test(`redacts ${input}`, () => assert.equal(redactCredentialUrl(input), expected));
  }

  // Ordinary / look-alike params must pass through untouched — the segmenter is
  // what keeps these out of the credential net.
  for (const url of [
    "https://h/?country_code=US",
    "https://h/?sort_key=name",
    "https://h/?promo_code=SAVE10",
    "https://h/?zipcode=94016",
    "https://h/?keyword=monkey",
    "https://h/?monkey=banana",
    "https://h/?authenticationMode=oauth",
    "https://h/?utm_source=newsletter&utm_medium=email",
    "https://h/path/no/query",
  ]) {
    test(`leaves ${url} untouched`, () => assert.equal(redactCredentialUrl(url), url));
  }

  test("is idempotent (redacting an already-redacted url is a no-op)", () => {
    const once = redactCredentialUrl("https://h/?token=secret&page=1");
    assert.equal(redactCredentialUrl(once), once);
  });

  test("does not throw on a malformed url", () => {
    assert.equal(redactCredentialUrl("not a url ?token=x"), "not a url ?token=[REDACTED]");
  });
});

/* ── hermetic SSRF + transport coverage (no network) ──────────────────────── */

function streamOfBytes(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) yield p;
    },
  };
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

describe("decodeResponseBody", () => {
  const payload = Buffer.from("the quick brown fox ".repeat(50), "utf-8");

  for (const [encoding, compress] of [
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const) {
    test(`decodes ${encoding}`, async () => {
      const { body, decoded } = decodeResponseBody(
        streamOfBytes(compress(payload)),
        encoding,
        "https://example.com/",
      );
      assert.equal(decoded, true);
      assert.deepEqual(await collect(body), payload);
    });
  }

  test("decodes a doubly-encoded body (gzip then deflate) in the right order", async () => {
    // Content-Encoding lists outermost-first; decoders apply in reverse.
    const doubly = deflateSync(gzipSync(payload));
    const { body, decoded } = decodeResponseBody(
      streamOfBytes(doubly),
      "gzip, deflate",
      "https://example.com/",
    );
    assert.equal(decoded, true);
    assert.deepEqual(await collect(body), payload);
  });

  test("identity / empty encoding is a no-op pass-through", () => {
    const src = streamOfBytes(payload);
    assert.equal(decodeResponseBody(src, "identity", "https://e.com/").decoded, false);
    assert.equal(decodeResponseBody(src, undefined, "https://e.com/").decoded, false);
    assert.equal(decodeResponseBody(src, "", "https://e.com/").decoded, false);
  });

  test("rejects an unsupported content encoding", () => {
    assert.throws(
      () => decodeResponseBody(streamOfBytes(payload), "compress", "https://e.com/"),
      (e) => e instanceof FetchError && e.reason === "fetch_failed",
    );
  });

  test("rejects an absurd encoding stack (decompression-bomb guard)", () => {
    assert.throws(
      () =>
        decodeResponseBody(
          streamOfBytes(payload),
          "gzip,gzip,gzip,gzip,gzip,gzip",
          "https://e.com/",
        ),
      (e) => e instanceof FetchError && e.reason === "fetch_failed",
    );
  });
});

describe("pinningLookup (connect-time IP pin)", () => {
  const opts = { all: true } as Parameters<typeof pinningLookup>[1];

  function run(
    hostname: string,
    resolve: DnsLookupAll,
  ): Promise<{ err: NodeJS.ErrnoException | null; address?: string | { address: string }[] }> {
    return new Promise((res) => {
      pinningLookup(hostname, opts, (err, address) => res({ err, address }), resolve);
    });
  }

  test("refuses EBLOCKEDHOST when the host resolves to a private address", async () => {
    const resolve: DnsLookupAll = (_h, _o, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }]);
    const { err } = await run("rebind.example", resolve);
    assert.equal(err?.code, "EBLOCKEDHOST");
  });

  test("refuses EBLOCKEDHOST when ANY resolved address is private", async () => {
    const resolve: DnsLookupAll = (_h, _o, cb) =>
      cb(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
    const { err } = await run("mixed.example", resolve);
    assert.equal(err?.code, "EBLOCKEDHOST");
  });

  test("passes validated public addresses through (all:true array shape)", async () => {
    const resolve: DnsLookupAll = (_h, _o, cb) =>
      cb(null, [{ address: "93.184.216.34", family: 4 }]);
    const { err, address } = await run("example.com", resolve);
    assert.equal(err, null);
    assert.ok(Array.isArray(address));
  });

  test("surfaces ENOTFOUND when nothing resolves", async () => {
    const resolve: DnsLookupAll = (_h, _o, cb) => cb(null, []);
    const { err } = await run("void.example", resolve);
    assert.equal(err?.code, "ENOTFOUND");
  });

  test("propagates a resolver error verbatim", async () => {
    const boom = Object.assign(new Error("dns down"), { code: "EAI_AGAIN" });
    const resolve: DnsLookupAll = (_h, _o, cb) => cb(boom);
    const { err } = await run("flaky.example", resolve);
    assert.equal(err?.code, "EAI_AGAIN");
  });
});

describe("safeRequest (manual redirect re-validation)", () => {
  const signal = AbortSignal.timeout(5_000);

  function res(over: Partial<UndiciResponseLike>): UndiciResponseLike {
    return {
      statusCode: 200,
      headers: {},
      body: streamOfBytes(new TextEncoder().encode("body")),
      ...over,
    };
  }

  test("refuses a redirect into private/metadata space (the hop, not just hop 0)", async () => {
    const requester: HttpRequester = async (url) => {
      if (url === "https://innocuous.example/")
        return res({ statusCode: 302, headers: { location: "http://169.254.169.254/latest" } });
      throw new Error("must not fetch the private target");
    };
    await assert.rejects(
      safeRequest("https://innocuous.example/", signal, requester),
      (e) =>
        e instanceof FetchError &&
        e.reason === "blocked_host" &&
        Array.isArray(e.redirects) &&
        e.redirects.includes("https://innocuous.example/"),
    );
  });

  test("#292 refuses a redirect to a non-default port (the hop, not just hop 0)", async () => {
    const requester: HttpRequester = async (url) => {
      if (url === "https://innocuous.example/")
        return res({ statusCode: 302, headers: { location: "https://innocuous.example:8443/" } });
      throw new Error("must not fetch the non-default-port target");
    };
    await assert.rejects(
      safeRequest("https://innocuous.example/", signal, requester),
      (e) =>
        e instanceof FetchError &&
        e.reason === "blocked_port" &&
        Array.isArray(e.redirects) &&
        e.redirects.includes("https://innocuous.example/"),
    );
  });

  test("#293 refuses a redirect target that adds a credential query param", async () => {
    const requester: HttpRequester = async (url) => {
      if (url === "https://innocuous.example/")
        return res({
          statusCode: 302,
          headers: { location: "https://innocuous.example/cb?access_token=leaked" },
        });
      throw new Error("must not fetch the credential target");
    };
    await assert.rejects(
      safeRequest("https://innocuous.example/", signal, requester),
      (e) =>
        e instanceof FetchError &&
        e.reason === "credential_url" &&
        // The blocked redirect target carried into the error must be redacted.
        typeof e.finalUrl === "string" &&
        e.finalUrl.includes("access_token=[REDACTED]") &&
        !e.finalUrl.includes("leaked"),
    );
  });

  test("follows redirects manually and records the chain", async () => {
    const requester: HttpRequester = async (url) => {
      if (url === "https://a.example/")
        return res({ statusCode: 301, headers: { location: "https://b.example/" } });
      if (url === "https://b.example/")
        return res({ statusCode: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
      throw new Error(`unexpected url ${url}`);
    };
    const out = await safeRequest("https://a.example/", signal, requester);
    assert.equal(out.finalUrl, "https://b.example/");
    assert.deepEqual(out.redirectChain, ["https://a.example/"]);
    assert.equal(out.contentType, "text/plain");
    assert.equal(out.charset, "utf-8");
  });

  test("gives up after too many redirects rather than auto-following forever", async () => {
    const requester: HttpRequester = async () =>
      res({ statusCode: 302, headers: { location: "https://loop.example/next" } });
    await assert.rejects(
      safeRequest("https://loop.example/", signal, requester),
      (e) => e instanceof FetchError && /Too many redirects/.test(e.message),
    );
  });

  test("the recorded redirect chain surfaces all the way out to runFetchUrl", async () => {
    const requester: HttpRequester = async (url) => {
      if (url === "https://start.example/")
        return res({ statusCode: 302, headers: { location: "https://final.example/" } });
      return res({
        statusCode: 200,
        headers: { "content-type": "text/plain" },
        body: streamOfBytes(new TextEncoder().encode("hi")),
      });
    };
    const transport: Transport = (url, sig) => safeRequest(url, sig, requester);
    const r = await runFetchUrl({ url: "https://start.example/" }, { transport });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.redirects, ["https://start.example/"]);
  });
});
