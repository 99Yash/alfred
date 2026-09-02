import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HostedEndpointError } from "../../src/connections/hosted-endpoint";
import { boundedMcpErrorText } from "../../src/connections/mcp/errors";

describe("boundedMcpErrorText", () => {
  test("persists the blocked-host reason instead of fetch's opaque wrapper", () => {
    const blocked = Object.assign(
      new Error("'rebind.example' resolves to a private or internal address (10.0.0.5)."),
      { code: "EBLOCKEDHOST" },
    );
    const text = boundedMcpErrorText(new TypeError("fetch failed", { cause: blocked }));
    assert.match(text, /rebind\.example.*10\.0\.0\.5/);
    assert.doesNotMatch(text, /^fetch failed$/);
  });

  test("keeps the cause chain for other transport failures", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443"), {
      code: "ECONNREFUSED",
    });
    assert.equal(
      boundedMcpErrorText(new TypeError("fetch failed", { cause: refused })),
      "fetch failed: connect ECONNREFUSED 93.184.216.34:443",
    );
  });

  test("uses a URL-level refusal's own sentence", () => {
    assert.equal(
      boundedMcpErrorText(new HostedEndpointError("origin_mismatch", "The endpoint moved.")),
      "The endpoint moved.",
    );
  });
});
