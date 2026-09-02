import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  HostedEndpointError,
  createGuardedFetch,
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
});

describe("host and DNS safety", () => {
  test("blocks metadata and translated private addresses", () => {
    for (const address of [
      "169.254.169.254",
      "100.64.0.1",
      "::ffff:127.0.0.1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
    ]) {
      assert.equal(isBlockedIp(address), true, address);
    }
    assert.equal(isBlockedHost("service.internal"), true);
  });

  test("rejects a mixed public/private answer set and an empty answer set", async () => {
    const run = (resolve: DnsLookupAll) =>
      new Promise<NodeJS.ErrnoException | null>((done) => {
        pinningLookup("mcp.example.test", { all: true }, (error) => done(error), resolve);
      });
    const mixed: DnsLookupAll = (_hostname, _options, callback) =>
      callback(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]);
    const empty: DnsLookupAll = (_hostname, _options, callback) => callback(null, []);

    assert.equal((await run(mixed))?.code, "EBLOCKEDHOST");
    assert.equal((await run(empty))?.code, "ENOTFOUND");
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
