import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSensitiveLogPaths, SENSITIVE_LOG_PATHS } from "../src/log-redaction";

test("exact dotted paths censor the nested leaf only", () => {
  const out = redactSensitiveLogPaths({
    req: { headers: { authorization: "Bearer sk_live", "x-request-id": "abc" } },
  });

  assert.deepEqual(out, {
    req: { headers: { authorization: "[redacted]", "x-request-id": "abc" } },
  });
});

test("a one-key entry censors that key at any depth, in any case and separator form", () => {
  const out = redactSensitiveLogPaths({
    credential: { accessToken: "tok", refresh_token: "ref" },
    user: { name: "sam", password: "hunter2" },
    deep: { nested: { result: { "Api-Key": "key", tokens: 3 } } },
  });

  assert.deepEqual(out, {
    credential: { accessToken: "[redacted]", refresh_token: "[redacted]" },
    user: { name: "sam", password: "[redacted]" },
    deep: { nested: { result: { "Api-Key": "[redacted]", tokens: 3 } } },
  });
});

test("arrays are walked and their elements' leaves are matched", () => {
  const out = redactSensitiveLogPaths({
    rows: [{ password: "p1" }, { password: "p2", ok: true }],
  });

  assert.deepEqual(out, {
    rows: [{ password: "[redacted]" }, { password: "[redacted]", ok: true }],
  });
});

test("non-plain values pass through untouched and the input is never mutated", () => {
  const at = new Date(0);
  const input = { at, secret: { tag: "Redacted" }, nested: { accessToken: "tok" } };
  const out = redactSensitiveLogPaths(input);
  assert.equal(input.nested.accessToken, "tok");
  assert.equal(out.at.getTime(), 0);
});

test("every declared path censors its own sample payload shape", () => {
  for (const path of SENSITIVE_LOG_PATHS) {
    const segments = path.split(".");

    const node = segments.reduceRight<Record<string, unknown>>((child, segment) => {
      return { [segment]: child };
    }, {});

    const censored = JSON.stringify(redactSensitiveLogPaths(node));
    assert.ok(censored.includes("[redacted]"), `path ${path} should censor its sample payload`);
  }
});
