import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChatMemoryExtractionResult, ChatProposition } from "@alfred/contracts";
import {
  buildThreadTranscript,
  extractPropositionsFromThread,
  SYSTEM_PROMPT,
  type GenerateObject,
  type ThreadTurn,
} from "../../src/modules/chat-memory/extractor";

/**
 * Pins the pure surface of the chat→memory extractor (#398): transcript
 * assembly (role labels, blank-skipping, newest-preserving truncation) and the
 * extract pipeline (empty short-circuit, prompt shape, output re-validation).
 * The live cheap-model call is exercised via smokes, not here — the `generate`
 * seam lets these stay deterministic and AI-SDK-free.
 */

describe("buildThreadTranscript", () => {
  test("renders role labels and joins turns oldest-first", () => {
    const turns: ThreadTurn[] = [
      { role: "user", content: "who is dvd?" },
      { role: "assistant", content: "Venkata Deepankar Duvvuru." },
    ];
    assert.equal(
      buildThreadTranscript(turns),
      "User: who is dvd?\nAlfred: Venkata Deepankar Duvvuru.",
    );
  });

  test("skips blank/whitespace-only turns", () => {
    const turns: ThreadTurn[] = [
      { role: "user", content: "  " },
      { role: "assistant", content: "hi" },
      { role: "user", content: "" },
    ];
    assert.equal(buildThreadTranscript(turns), "Alfred: hi");
  });

  test("keeps the LATEST turns when over budget and marks truncation", () => {
    const turns: ThreadTurn[] = [
      { role: "user", content: "OLDEST oldest oldest" },
      { role: "assistant", content: "middle" },
      { role: "user", content: "NEWEST" },
    ];
    // Budget large enough for only the last turn or two.
    const out = buildThreadTranscript(turns, 20);
    assert.match(out, /\[…earlier turns truncated\]/);
    assert.match(out, /User: NEWEST/);
    assert.doesNotMatch(out, /OLDEST/);
  });

  test("caps a single oversized newest turn instead of sending the whole blob", () => {
    const out = buildThreadTranscript([{ role: "user", content: "x".repeat(100) }], 20);
    assert.match(out, /\[…earlier turns truncated\]/);
    assert.equal(out.endsWith("x".repeat(20)), true);
    assert.ok(out.length < 60);
  });

  test("no truncation marker when the whole thread fits", () => {
    const out = buildThreadTranscript([{ role: "user", content: "short" }], 10_000);
    assert.equal(out, "User: short");
  });
});

describe("extractPropositionsFromThread", () => {
  const dvdThread: ThreadTurn[] = [
    { role: "user", content: "dvd is a co-founder of Oliv." },
    { role: "assistant", content: "Got it — and Oliv is around 6 people?" },
    { role: "user", content: "No, Oliv is not ~6 people." },
  ];

  const dvdResult: ChatMemoryExtractionResult = {
    propositions: [
      {
        subject: "entity",
        subjectRef: "dvd",
        key: "relationship:dvd",
        value: { role: "co-founder" },
        verificationClass: "external_checkable",
        volatility: "stable",
        attribution: "user_assertion",
        confidence: 0.92,
        rationale: "User stated dvd is a co-founder of Oliv.",
      },
    ],
  };

  test("returns [] for an empty transcript WITHOUT calling the model", async () => {
    let called = false;
    const generate: GenerateObject = async () => {
      called = true;
      return { propositions: [] };
    };
    const out = await extractPropositionsFromThread({
      userId: "usr_1",
      threadId: "thread_1",
      transcript: [],
      generate,
    });
    assert.deepEqual(out, []);
    assert.equal(called, false);
  });

  test("passes the system prompt + built transcript to the model and returns its propositions", async () => {
    let seenPrompt = "";
    let seenSystem = "";
    const generate: GenerateObject = async ({ system, prompt }) => {
      seenSystem = system;
      seenPrompt = prompt;
      return dvdResult;
    };
    const out = await extractPropositionsFromThread({
      userId: "usr_1",
      threadId: "thread_1",
      transcript: dvdThread,
      generate,
    });
    assert.equal(seenSystem, SYSTEM_PROMPT);
    // The final, settled correction must be visible to the model (D9).
    assert.match(seenPrompt, /Oliv is not ~6 people/);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.key, "relationship:dvd");
  });

  test("caps an already-rendered transcript before calling the model", async () => {
    let seenPrompt = "";
    const generate: GenerateObject = async ({ prompt }) => {
      seenPrompt = prompt;
      return { propositions: [] };
    };
    await extractPropositionsFromThread({
      userId: "usr_1",
      threadId: "thread_1",
      transcript: `OLDEST\n${"x".repeat(12_050)}\nNEWEST`,
      generate,
    });
    assert.match(seenPrompt, /\[…earlier turns truncated\]/);
    assert.match(seenPrompt, /NEWEST/);
    assert.doesNotMatch(seenPrompt, /OLDEST/);
  });

  test("re-validates the model output — a malformed proposition throws", async () => {
    const generate: GenerateObject = async () =>
      ({
        propositions: [{ ...dvdResult.propositions[0], verificationClass: "vibes" }],
      }) as unknown as ChatMemoryExtractionResult;
    await assert.rejects(
      () =>
        extractPropositionsFromThread({
          userId: "usr_1",
          threadId: "thread_1",
          transcript: dvdThread,
          generate,
        }),
      /verificationClass|enum|expected/i,
    );
  });
});

describe("SYSTEM_PROMPT (D6 guidance)", () => {
  test("instructs crisp-only extraction and forbids diffuse/countable signal", () => {
    assert.match(SYSTEM_PROMPT, /CRISP/);
    assert.match(SYSTEM_PROMPT, /diffuse, countable, or aggregate/i);
    assert.match(SYSTEM_PROMPT, /how many people/i);
  });

  test("instructs capturing the FINAL settled state (D9)", () => {
    assert.match(SYSTEM_PROMPT, /FINAL/);
  });

  // A trivially-referenced type import keeps the ChatProposition symbol in use
  // for readers wiring further assertions; harmless and documents intent.
  test("proposition shape is the contract type", () => {
    const p: ChatProposition = {
      subject: "user",
      key: "timezone",
      value: "America/Los_Angeles",
      verificationClass: "user_only",
      volatility: "stable",
      attribution: "user_assertion",
      confidence: 0.9,
      rationale: "User stated their timezone.",
    };
    assert.equal(p.subject, "user");
  });
});
