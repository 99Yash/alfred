import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseEmailAddress } from "@alfred/contracts";

/** Self-mail drops and retirements compare parsed addresses exactly, so a parse change is destructive. */
describe("parseEmailAddress", () => {
  test("unwraps the address from a display-name `From` header", () => {
    assert.equal(parseEmailAddress("Alfred <hey@alfred.beauty>"), "hey@alfred.beauty");
  });

  test("accepts a bare address with no display name", () => {
    assert.equal(parseEmailAddress("hey@alfred.beauty"), "hey@alfred.beauty");
  });

  test("lowercases and trims so matching is case/whitespace insensitive", () => {
    assert.equal(parseEmailAddress("  Alfred <HEY@Alfred.Beauty>  "), "hey@alfred.beauty");
  });

  test("returns null for empty / null / undefined input", () => {
    assert.equal(parseEmailAddress(null), null);
    assert.equal(parseEmailAddress(undefined), null);
    assert.equal(parseEmailAddress(""), null);
  });

  test("returns null when there is no `@` (not an address)", () => {
    assert.equal(parseEmailAddress("Alfred"), null);
    assert.equal(parseEmailAddress("<no-at-here>"), null);
  });

  test("extracts the angle-bracket address, not text that merely mentions one", () => {
    // Display text that mentions Alfred's address must not parse to it.
    assert.equal(
      parseEmailAddress("hey@alfred.beauty (re: your briefing) <real@person.com>"),
      "real@person.com",
    );
  });

  test("self vs non-self comparison is exact, not substring", () => {
    const self = parseEmailAddress("Alfred <hey@alfred.beauty>");
    assert.notEqual(parseEmailAddress("Notifs <noreply@alfred.beauty>"), self);
    assert.notEqual(parseEmailAddress("hey@alfred.beauty <real@person.com>"), self);
    assert.equal(parseEmailAddress("hey@alfred.beauty"), self);
  });
});
