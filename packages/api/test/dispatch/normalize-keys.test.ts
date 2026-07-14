import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  calendarListEventsInput,
  gmailSearchInput,
  githubGetPullRequestInput,
} from "@alfred/contracts";
import { z } from "zod";
import { normalizeToolInputKeys } from "../../src/modules/dispatch/normalize-keys";

describe("normalizeToolInputKeys", () => {
  test("renames a snake_case variant to the camelCase schema key", () => {
    const { input, renamed } = normalizeToolInputKeys(
      { q: "hi", max_results: 5 },
      gmailSearchInput,
    );
    assert.deepEqual(input, { q: "hi", maxResults: 5 });
    assert.deepEqual(renamed, [{ from: "max_results", to: "maxResults" }]);
    // And it validates first-try after normalization.
    assert.equal(gmailSearchInput.safeParse(input).success, true);
  });

  test("renames camelCase → the snake_case schema key (direction-agnostic)", () => {
    // GitHub uses snake_case to match the REST API; the model reaches for camel.
    const { input } = normalizeToolInputKeys(
      { owner: "99Yash", repo: "alfred", pullNumber: 305 },
      githubGetPullRequestInput,
    );
    assert.deepEqual(input, { owner: "99Yash", repo: "alfred", pull_number: 305 });
  });

  test("normalizes the calendar bounds casing family (time_min/time_max)", () => {
    const { input } = normalizeToolInputKeys(
      { time_min: "2026-07-01T00:00:00Z", time_max: "2026-07-02T00:00:00Z" },
      calendarListEventsInput,
    );
    assert.deepEqual(input, {
      timeMin: "2026-07-01T00:00:00Z",
      timeMax: "2026-07-02T00:00:00Z",
    });
  });

  test("leaves an already-canonical key untouched (no spurious rename)", () => {
    const { input, renamed } = normalizeToolInputKeys({ q: "hi", maxResults: 5 }, gmailSearchInput);
    assert.deepEqual(input, { q: "hi", maxResults: 5 });
    assert.deepEqual(renamed, []);
  });

  test("does not clobber a canonical key the model already set", () => {
    // Both present → the variant is ambiguous; leave it for strict validation.
    const { input, renamed } = normalizeToolInputKeys(
      { q: "hi", maxResults: 5, max_results: 99 },
      gmailSearchInput,
    );
    assert.equal((input as { maxResults?: number }).maxResults, 5);
    assert.ok("max_results" in (input as object));
    assert.deepEqual(renamed, []);
  });

  test("leaves a genuine unknown key alone (no canonical match)", () => {
    const { input, renamed } = normalizeToolInputKeys({ q: "hi", gibberish: 1 }, gmailSearchInput);
    assert.deepEqual(input, { q: "hi", gibberish: 1 });
    assert.deepEqual(renamed, []);
  });

  test("returns non-record input unchanged", () => {
    assert.deepEqual(normalizeToolInputKeys("nope", gmailSearchInput), {
      input: "nope",
      renamed: [],
    });
    assert.deepEqual(normalizeToolInputKeys(null, gmailSearchInput), { input: null, renamed: [] });
  });

  test("a schema with no object properties is a no-op", () => {
    const { input, renamed } = normalizeToolInputKeys({ a: 1 }, z.string());
    assert.deepEqual(input, { a: 1 });
    assert.deepEqual(renamed, []);
  });

  test("does not mutate the caller's input object", () => {
    const original = { q: "hi", max_results: 5 };
    normalizeToolInputKeys(original, gmailSearchInput);
    assert.deepEqual(original, { q: "hi", max_results: 5 });
  });
});
