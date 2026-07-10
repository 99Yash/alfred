import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { detectAiTells, summarizeTells } from "../../src/modules/agent/voice-detector";

/**
 * Locks the machine-checkable slice of DEFAULT_VOICE_PROMPT: every rule must
 * fire on a known offender and stay quiet on clean, grounded prose. If a rule
 * regexp drifts, the corresponding case here fails before it can silently pass
 * a tell through the eval scorer.
 */

function ruleIds(text: string): string[] {
  return detectAiTells(text).map((t) => t.ruleId);
}

describe("detectAiTells — flags each tell", () => {
  const cases: Array<{ label: string; text: string; ruleId: string }> = [
    {
      label: "inflated verb",
      text: "We can leverage the calendar API to sync events.",
      ruleId: "inflated-word",
    },
    { label: "inflated adjective", text: "It's a robust, seamless workflow.", ruleId: "inflated-word" },
    { label: "filler phrase", text: "In order to reply, open the thread.", ruleId: "filler" },
    {
      label: "flattery",
      text: "You're absolutely right. I hope this helps, feel free to ask more.",
      ruleId: "flattery",
    },
    { label: "let's construction", text: "Let's dive into your inbox.", ruleId: "lets-construction" },
    { label: "hype", text: "This is a real game-changer for your workflow.", ruleId: "hype" },
    {
      label: "generic conclusion",
      text: "You have three PRs. At the end of the day, the future looks bright.",
      ruleId: "generic-conclusion",
    },
    { label: "chatbot opener", text: "Certainly! Here is your calendar.", ruleId: "chatbot-opener" },
    {
      label: "false concession",
      text: "It's not about speed, it's about focus.",
      ruleId: "false-concession",
    },
    {
      label: "rhetorical opener",
      text: "What if there were a better way to run your day?",
      ruleId: "rhetorical-opener",
    },
    { label: "em-dash", text: "Your day is light — just one meeting.", ruleId: "em-dash" },
    { label: "double-hyphen dash", text: "Your day is light -- just one meeting.", ruleId: "em-dash" },
    { label: "emoji", text: "Nice work today 🎉", ruleId: "emoji" },
  ];

  for (const c of cases) {
    test(c.label, () => {
      const ids = ruleIds(c.text);
      assert.ok(
        ids.includes(c.ruleId),
        `expected "${c.ruleId}" in [${ids.join(", ")}] for: ${c.text}`,
      );
    });
  }
});

describe("detectAiTells — stays quiet on clean prose", () => {
  const clean = [
    "Two things need you today. The Redis URI is exposed on GitHub in PR #22; rotate it now. Fabian is still waiting on your reply from Tuesday.",
    "Your 2pm with Priya moved to 3pm. Nothing else on the calendar.",
    "I checked your inbox. Nothing pressing. Enjoy the weekend, Yash.",
    "The deploy failed on the migration step. I can't retry it for you, but the log points at a missing column.",
  ];

  for (const [i, text] of clean.entries()) {
    test(`clean sample ${i + 1}`, () => {
      const tells = detectAiTells(text);
      assert.equal(tells.length, 0, `unexpected tells: ${summarizeTells(tells)}`);
    });
  }
});

describe("detectAiTells — precision guards", () => {
  test("ignores tells inside fenced code", () => {
    const text = "Run this:\n```\nnpm run build -- --watch\nconst x = utilize()\n```\nThat starts the watcher.";
    assert.deepEqual(detectAiTells(text), []);
  });

  test("ignores tells inside inline code", () => {
    const text = "Pass the `--watch` flag and call `leverage()` from the script.";
    assert.deepEqual(detectAiTells(text), []);
  });

  test("hyphen in a numeric range is not an em-dash", () => {
    const text = "Your focus block is 9-11am.";
    assert.equal(detectAiTells(text).length, 0);
  });

  test("allowEmoji suppresses only the emoji rule", () => {
    const text = "Great work 🎉 but you should utilize the template.";
    const withEmoji = detectAiTells(text).map((t) => t.ruleId);
    const withoutEmoji = detectAiTells(text, { allowEmoji: true }).map((t) => t.ruleId);
    assert.ok(withEmoji.includes("emoji"));
    assert.ok(!withoutEmoji.includes("emoji"));
    assert.ok(withoutEmoji.includes("inflated-word"));
  });

  test("dedupes repeated identical matches within a rule", () => {
    const text = "Leverage this and leverage that.";
    const tells = detectAiTells(text).filter((t) => t.ruleId === "inflated-word");
    assert.equal(tells.length, 1);
  });

  test("normalizes smart apostrophes before matching", () => {
    const text = "It’s worth noting the deploy passed.";
    assert.ok(detectAiTells(text).some((t) => t.ruleId === "filler"));
  });
});
