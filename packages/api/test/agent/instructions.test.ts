import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENT_OUTPUT_PURPOSES,
  composeAgentInstructions,
} from "../../src/modules/agent/instructions";
import { DEFAULT_VOICE_PROMPT } from "../../src/modules/agent/voice";

describe("composeAgentInstructions", () => {
  it("applies Alfred's voice by default and keeps dynamic grounding last", () => {
    const prompt = composeAgentInstructions({
      purpose: "assistant_response",
      role: "role",
      rules: ["stable rules"],
      grounding: ["today", "connected tools"],
    });

    assert.equal(
      prompt,
      ["role", "stable rules", DEFAULT_VOICE_PROMPT, "today", "connected tools"].join("\n\n"),
    );
  });

  it("keeps the purpose-to-voice policy closed and explicit", () => {
    assert.deepEqual(AGENT_OUTPUT_PURPOSES, {
      assistant_response: { voice: "default" },
      audience_content: { voice: "default" },
      source_faithful: { voice: "none" },
      internal: { voice: "none" },
    });
  });

  for (const purpose of ["source_faithful", "internal"] as const) {
    it(`omits Alfred's voice for ${purpose} output`, () => {
      assert.equal(composeAgentInstructions({ purpose, role: "role" }), "role");
    });
  }

  it("allows a typed voice override without accepting custom prompt text", () => {
    const prompt = composeAgentInstructions({
      purpose: "audience_content",
      role: "role",
      voice: "none",
    });
    assert.equal(prompt, "role");
  });

  it("drops empty optional blocks without changing separators", () => {
    assert.equal(
      composeAgentInstructions({
        purpose: "assistant_response",
        role: "role",
        rules: [""],
        grounding: ["", "context"],
      }),
      ["role", DEFAULT_VOICE_PROMPT, "context"].join("\n\n"),
    );
  });

  it("keeps direct default-voice imports inside the instruction constructor", () => {
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const imports: string[] = [];

    function visit(path: string): void {
      for (const name of readdirSync(path)) {
        const child = `${path}/${name}`;
        if (statSync(child).isDirectory()) visit(child);
        else if (
          name.endsWith(".ts") &&
          /^import\s+[^;\n]*\bDEFAULT_VOICE_PROMPT\b/m.test(readFileSync(child, "utf8"))
        ) {
          imports.push(child.slice(srcRoot.length + 1));
        }
      }
    }

    visit(srcRoot);
    assert.deepEqual(imports, ["modules/agent/instructions.ts"]);
  });
});
