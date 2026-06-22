import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpError,
  httpErrorFromResponse,
  isHttpError,
  MAX_ERROR_BODY_CHARS,
  redactSecrets,
  summarizeBody,
  toMessage,
} from "@alfred/contracts";

test("toMessage matches the err-or-String idiom", () => {
  assert.equal(toMessage(new Error("boom")), "boom");
  assert.equal(toMessage("plain string"), "plain string");
  assert.equal(toMessage(42), "42");
  assert.equal(toMessage(null), "null");
});

test("redactSecrets strips bearer/basic tokens and secret-keyed values", () => {
  const authLine = redactSecrets("Authorization: Bearer ya29.abcDEF12345");
  assert.ok(!authLine.includes("ya29.abcDEF12345"));
  assert.match(authLine, /\[redacted\]/);
  assert.ok(!redactSecrets("Bearer ya29.abcDEF12345").includes("ya29.abcDEF12345"));

  const json = '{"access_token":"sk-secret-value-123","note":"keep me"}';
  const out = redactSecrets(json);
  assert.ok(!out.includes("sk-secret-value-123"));
  assert.match(out, /\[redacted\]/);
  // Non-secret fields survive.
  assert.match(out, /keep me/);

  assert.ok(!redactSecrets("?refresh_token=abc123def&page=2").includes("abc123def"));
});

test("summarizeBody redacts then bounds with a visible marker", () => {
  const big = "x".repeat(MAX_ERROR_BODY_CHARS + 50);
  const out = summarizeBody(big);
  assert.ok(out.length < big.length);
  assert.match(out, /…\[\+50 chars\]$/);

  // Short bodies pass through untouched (after redaction).
  assert.equal(summarizeBody("short body"), "short body");

  // Secrets are gone even when the body is short enough to keep.
  assert.ok(!summarizeBody('{"client_secret":"hunter2"}').includes("hunter2"));
});

test("HttpError carries structured fields and a tag, not just a message", () => {
  const err = new HttpError({
    provider: "gmail",
    status: 429,
    url: "https://example.com/x",
    method: "POST",
    body: "rate limited",
  });
  assert.equal(err._tag, "HttpError");
  assert.equal(err.provider, "gmail");
  assert.equal(err.status, 429);
  assert.equal(err.method, "POST");
  assert.ok(err instanceof Error);
  assert.ok(isHttpError(err));
  assert.match(err.message, /\[gmail] POST 429 https:\/\/example\.com\/x :: rate limited/);
});

test("HttpError.retryable is true for 429 and 5xx, false otherwise", () => {
  const mk = (status: number) => new HttpError({ provider: "p", status, url: "u", body: "" });
  assert.equal(mk(429).retryable, true);
  assert.equal(mk(503).retryable, true);
  assert.equal(mk(500).retryable, true);
  assert.equal(mk(404).retryable, false);
  assert.equal(mk(401).retryable, false);
});

test("HttpError redacts secrets that ride in the URL", () => {
  const err = new HttpError({
    provider: "p",
    status: 400,
    url: "https://api.example.com/v1?access_token=topsecret123",
    body: "",
  });
  assert.ok(!err.message.includes("topsecret123"));
});

test("isHttpError rejects plain errors and non-errors", () => {
  assert.equal(isHttpError(new Error("nope")), false);
  assert.equal(isHttpError("string"), false);
  assert.equal(isHttpError(null), false);
});

test("httpErrorFromResponse builds a bounded, redacted error from a Response", async () => {
  const res = new Response('{"error":"bad","api_key":"leakme"}', {
    status: 403,
    statusText: "Forbidden",
  });
  const err = await httpErrorFromResponse("notion", res, { url: "/v1/pages", method: "GET" });
  assert.ok(isHttpError(err));
  assert.equal(err.status, 403);
  assert.equal(err.provider, "notion");
  assert.ok(!err.message.includes("leakme"));
  assert.match(err.message, /bad/);
});
