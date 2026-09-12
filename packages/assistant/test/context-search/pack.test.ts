import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { packEvidenceCards } from "@alfred/assistant/context-search";
import type { EvidenceCard } from "@alfred/contracts";

/**
 * Behavioral tests for the #423 packer.
 *
 * These cover what the compiler cannot: that each card kind renders its
 * attribution and citations, that the output is honestly bounded, and that a
 * source which returned nothing or failed is reported rather than silently
 * dropped. They assert on structure and substrings, not exact packed text, so a
 * rendering tweak does not require rewriting the suite. The card shape itself is
 * proven by the `EvidenceCard` annotations below plus `evidenceCardSchema`'s use
 * at the read boundary, not by a schema round-trip here.
 */

describe("packEvidenceCards — card kinds", () => {
  test("packs a minimal text card with its source and citation", () => {
    const card: EvidenceCard = {
      id: "gmail:msg-1",
      source: { id: "gmail", kind: "native", displayName: "Gmail", domain: "mail.google.com" },
      mediaKind: "text",
      snippet: "The deploy failed on main.",
      citations: [
        {
          label: "Gmail message",
          locator: "message msg-1",
          url: "https://mail.google.com/mail/u/0/#all/msg-1",
        },
      ],
    };

    const packed = packEvidenceCards({ evidence: [card], sources: [] });

    assert.deepEqual(packed.includedIds, ["gmail:msg-1"]);
    assert.equal(packed.omittedCount, 0);
    assert.equal(packed.truncated, false);
    assert.match(packed.text, /Gmail \[gmail\]/);
    assert.match(packed.text, /The deploy failed on main\./);
    assert.match(packed.text, /Gmail message \(message msg-1\)/);
    assert.match(packed.text, /mail\.google\.com\/mail/);
    // Freshness is always stated; a card that declares none reads unknown.
    assert.match(packed.text, /freshness unknown/);
  });

  test("renders object-state evidence deterministically", () => {
    const card: EvidenceCard = {
      id: "github:pr-42",
      source: { id: "github", kind: "native", displayName: "GitHub" },
      mediaKind: "text",
      snippet: "PR 42 merged into main.",
      object: {
        provider: "github",
        kind: "pull_request",
        externalId: "42",
        stateCategory: "resolved",
        nativeState: "merged",
        title: "Close the CI loop",
        url: "https://github.com/acme/repo/pull/42",
        repo: "acme/repo",
      },
      time: { observedAt: "2026-09-01T12:00:00.000Z", freshness: "live" },
      authority: { level: "high", label: "GitHub App webhook" },
    };

    const packed = packEvidenceCards({ evidence: [card], sources: [] });

    assert.match(packed.text, /Object: github\/pull_request merged \(resolved\)/);
    assert.match(packed.text, /"Close the CI loop"/);
    assert.match(packed.text, /\[acme\/repo\]/);
    assert.match(packed.text, /freshness live/);
    assert.match(packed.text, /Authority: high — GitHub App webhook/);
  });

  test("renders an MCP-style source card without a display name or declared authority", () => {
    const card: EvidenceCard = {
      id: "mcp:linear:LIN-1",
      source: { id: "mcp:linear", kind: "mcp" },
      mediaKind: "text",
      snippet: "LIN-1 moved to Done.",
      authority: { level: "unknown" },
      expansion: { sourceId: "mcp:linear", kind: "mcp_tool", ref: "linear.get_issue:LIN-1" },
    };

    const packed = packEvidenceCards({ evidence: [card], sources: [] });

    // No display name falls back to the stable id, cited once; the source kind is visible.
    assert.match(packed.text, /mcp:linear \(mcp, text\)/);
    assert.match(packed.text, /Authority: unknown/);
    assert.match(packed.text, /Expand: mcp_tool linear\.get_issue:LIN-1/);
  });

  test("renders a media placeholder from its note and anchors, not a fabricated snippet", () => {
    const card: EvidenceCard = {
      id: "attachment:att-9",
      source: { id: "attachments", kind: "internal", displayName: "Attachments" },
      mediaKind: "image",
      note: "OCR is not available for this image yet.",
      anchors: [
        { kind: "visual", region: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 }, confidence: 0.6 },
      ],
      citations: [{ label: "Chat attachment", locator: "message m-1" }],
      expansion: { sourceId: "attachments", kind: "attachment", ref: "att-9", hint: "download" },
    };

    const packed = packEvidenceCards({ evidence: [card], sources: [] });

    assert.equal(packed.text.includes("Content:"), false);
    assert.match(packed.text, /Note: OCR is not available for this image yet\./);
    assert.match(packed.text, /Anchors: visual region 0\.1,0\.2 0\.4x0\.3 confidence 0\.6/);
    assert.match(packed.text, /Chat attachment \(message m-1\)/);
    assert.match(packed.text, /Expand: attachment att-9/);
  });
});

describe("packEvidenceCards — budget and honesty", () => {
  test("drops whole cards past the budget and reports how many were omitted", () => {
    const cards: EvidenceCard[] = Array.from({ length: 20 }, (_, index) => ({
      id: `doc:${index}`,
      source: { id: "docs", kind: "native" },
      mediaKind: "text",
      snippet: "x".repeat(500),
    }));

    const packed = packEvidenceCards({ evidence: cards, sources: [] }, { maxChars: 1_200 });

    assert.equal(packed.truncated, true);
    assert.ok(packed.omittedCount > 0);
    assert.ok(packed.includedIds.length > 0);
    assert.ok(packed.includedIds.length < cards.length);
    assert.ok(packed.text.length <= 1_200);
  });

  test("reports sources that returned nothing or failed", () => {
    const packed = packEvidenceCards({
      evidence: [],
      sources: [
        { sourceId: "gmail", status: "empty", evidenceCount: 0 },
        { sourceId: "docs", status: "error", evidenceCount: 0, reason: "token expired" },
      ],
    });

    assert.match(packed.text, /gmail: no evidence found/);
    assert.match(packed.text, /docs: unavailable \(token expired\)/);
    assert.deepEqual(packed.includedIds, []);
    assert.equal(packed.truncated, false);
  });

  test("names a productive source whose cards the read dropped entirely", () => {
    const card: EvidenceCard = {
      id: "documents:1",
      source: { id: "documents", kind: "native", displayName: "Documents" },
      mediaKind: "text",
      snippet: "The deploy runbook lives in the wiki.",
    };

    const packed = packEvidenceCards({
      evidence: [card],
      sources: [
        { sourceId: "documents", status: "ok", evidenceCount: 1 },
        { sourceId: "memory", status: "ok", evidenceCount: 7 },
      ],
    });

    // The source that contributed a card is not accused of being dropped.
    assert.doesNotMatch(packed.text, /documents: \d+ item\(s\) not shown/);
    // The productive source the read slid off the combined evidence names its loss.
    assert.match(packed.text, /memory: 7 item\(s\) not shown \(evidence budget\)/);
    assert.deepEqual(packed.includedIds, ["documents:1"]);
    // The read reported 8 cards and handed over 1; the aggregate already said so.
    assert.equal(packed.omittedCount, 7);
    assert.equal(packed.truncated, true);
  });

  test("states plainly when no evidence matched", () => {
    const packed = packEvidenceCards({ evidence: [], sources: [] });

    assert.match(packed.text, /No evidence matched the query\./);
    assert.equal(packed.omittedCount, 0);
    assert.equal(packed.truncated, false);
  });

  test("clamps a caller budget to the pack floor", () => {
    const card: EvidenceCard = {
      id: "doc:1",
      source: { id: "docs", kind: "native" },
      mediaKind: "text",
      snippet: "y".repeat(200),
    };

    const packed = packEvidenceCards({ evidence: [card], sources: [] }, { maxChars: 1 });

    assert.ok(packed.text.length <= 500);
  });
});
