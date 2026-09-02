import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  HostedEndpointError,
  createGuardedFetch,
  hostedEndpointErrorFrom,
  isBlockedHost,
  isBlockedIp,
  pinningLookup,
  validatePinnedHttpsEndpoint,
  type DnsLookupAll,
  type GuardedFetchRequester,
} from "../../src/connections/hosted-endpoint";

describe("hosted endpoint validation", () => {
  test("rejects non-HTTPS, embedded credentials, fragments, non-default ports, and origin drift", () => {
    for (const candidate of [
      "http://mcp.example.test/mcp",
      "https://user:pass@mcp.example.test/mcp",
      "https://mcp.example.test:8443/mcp",
      "https://mcp.example.test/mcp#fragment",
      "https://mcp.example.test/mcp?access_token=secret",
      "https://127.0.0.1/mcp",
    ]) {
      assert.throws(
        () => validatePinnedHttpsEndpoint(candidate, "https://mcp.example.test"),
        HostedEndpointError,
        candidate,
      );
    }
    assert.throws(
      () =>
        validatePinnedHttpsEndpoint("https://other.example.test/mcp", "https://mcp.example.test"),
      /stored origin/,
    );
  });

  test("accepts one normalized public HTTPS endpoint", () => {
    assert.equal(
      validatePinnedHttpsEndpoint("https://mcp.example.test/mcp", "https://mcp.example.test").href,
      "https://mcp.example.test/mcp",
    );
  });

  test("tells a corrupt stored origin apart from an endpoint that moved", () => {
    const codeOf = (expectedOrigin: string) => {
      try {
        validatePinnedHttpsEndpoint("https://mcp.example.test/mcp", expectedOrigin);
        return null;
      } catch (error) {
        return error instanceof HostedEndpointError ? error.code : null;
      }
    };
    assert.equal(codeOf("not a url"), "invalid_origin");
    assert.equal(codeOf("https://mcp.example.test/path"), "invalid_origin");
    assert.equal(codeOf("https://other.example.test"), "origin_mismatch");
  });
});

describe("hostedEndpointErrorFrom", () => {
  test("recovers a DNS-level refusal buried under fetch's TypeError", () => {
    const blocked = Object.assign(
      new Error("'rebind.example' resolves to a private or internal address (10.0.0.5)."),
      { code: "EBLOCKEDHOST" },
    );
    const wrapped = new TypeError("fetch failed", { cause: blocked });

    const hosted = hostedEndpointErrorFrom(wrapped);

    assert.equal(hosted?.code, "blocked_host");
    assert.match(hosted?.message ?? "", /rebind\.example.*10\.0\.0\.5/);
  });

  test("passes a URL-level refusal through and ignores unrelated errors", () => {
    const direct = new HostedEndpointError("blocked_port", "port");
    assert.equal(hostedEndpointErrorFrom(direct), direct);
    assert.equal(hostedEndpointErrorFrom(new TypeError("fetch failed")), null);
    assert.equal(
      hostedEndpointErrorFrom(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
        }),
      ),
      null,
    );
    assert.equal(hostedEndpointErrorFrom("string"), null);
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

describe("pinningLookup (connect-time IP pin)", () => {
  const opts = { all: true } as Parameters<typeof pinningLookup>[1];

  function run(
    hostname: string,
    resolve: DnsLookupAll,
  ): Promise<{
    err: NodeJS.ErrnoException | null;
    address?: string | { address: string }[] | undefined;
  }> {
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

describe("guarded fetch", () => {
  test("follows a same-origin GET redirect after validating the next hop", async () => {
    const seen: string[] = [];
    const requester: GuardedFetchRequester = async (input) => {
      const url = String(input);
      seen.push(url);
      return url.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "/done" } })
        : new Response("ok", { status: 200 });
    };
    const guarded = createGuardedFetch({
      expectedOrigin: "https://mcp.example.test",
      requester,
    });

    const response = await guarded("https://mcp.example.test/start");

    assert.equal(await response.text(), "ok");
    assert.deepEqual(seen, ["https://mcp.example.test/start", "https://mcp.example.test/done"]);
  });

  test("does not send a cross-origin redirect or replay a POST body", async () => {
    let crossOriginCalls = 0;
    const crossOrigin = createGuardedFetch({
      expectedOrigin: "https://mcp.example.test",
      requester: async () => {
        crossOriginCalls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example.test/steal" },
        });
      },
    });
    await assert.rejects(crossOrigin("https://mcp.example.test/start"), /stored origin/);
    assert.equal(crossOriginCalls, 1);

    let postCalls = 0;
    const redirectedPost = createGuardedFetch({
      expectedOrigin: "https://mcp.example.test",
      requester: async () => {
        postCalls += 1;
        return new Response(null, { status: 307, headers: { location: "/again" } });
      },
    });
    await assert.rejects(
      redirectedPost("https://mcp.example.test/mcp", { method: "POST", body: "payload" }),
      /not replayed/,
    );
    assert.equal(postCalls, 1);
  });

  test("strips credentials before a public OAuth GET follows a cross-origin redirect", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const guarded = createGuardedFetch({
      requester: async (input, init) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) });
        return seen.length === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "https://auth.example.test/metadata" },
            })
          : new Response("ok");
      },
    });

    await guarded("https://mcp.example.test/.well-known/oauth", {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "proxy-authorization": "Basic secret",
        "mcp-session-id": "session-secret",
        traceparent: "00-secret",
        tracestate: "vendor=secret",
        "x-api-key": "api-secret",
      },
    });

    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.url, "https://auth.example.test/metadata");
    for (const name of [
      "authorization",
      "cookie",
      "proxy-authorization",
      "mcp-session-id",
      "traceparent",
      "tracestate",
      "x-api-key",
    ]) {
      assert.equal(seen[1]?.headers.has(name), false, name);
    }
  });
});
