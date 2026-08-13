import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseEmailAddress } from "@alfred/contracts";

/**
 * Pins the self-mail match semantics (issue #211). `parseEmailAddress` is the
 * single source of truth shared by the Gmail ingestion guard (`isSelfAuthored`)
 * and the self-mail retirement backfill — both decide what to drop / retire by
 * comparing parsed addresses for EXACT equality. A regression here silently
 * widens or narrows that destructive set, so the parsing rules are pinned below.
 */
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
    // The exact-match guard relies on this: a real sender whose display text
    // happens to mention Alfred's address must NOT parse to Alfred's address,
    // or the destructive backfill would retire a stranger's mail.
    assert.equal(
      parseEmailAddress("hey@alfred.beauty (re: your briefing) <real@person.com>"),
      "real@person.com",
    );
  });

  test("self vs non-self comparison is exact, not substring", () => {
    const self = parseEmailAddress("Alfred <hey@alfred.beauty>");
    // A near-miss on the same domain is a different address — not self.
    assert.notEqual(parseEmailAddress("Notifs <noreply@alfred.beauty>"), self);
    // Display text that contains the self address still resolves to the real
    // sender, so the equality check below is false — mail is kept, not dropped.
    assert.notEqual(parseEmailAddress("hey@alfred.beauty <real@person.com>"), self);
    // The genuine self address matches.
    assert.equal(parseEmailAddress("hey@alfred.beauty"), self);
  });
});
