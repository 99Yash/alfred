/**
 * Replay the exact captured chat-turn input (run_wrdn0t5bme58 — the "edit my
 * resume from my website" turn that punted) against Sonnet 4.6 and Gemini 2.5
 * Pro *separately*, with the real turn-0 `system.*` toolset. Decisive A/B for
 * the question: is the punt a harness/context problem (both models punt) or a
 * model problem (Sonnet acts, Gemini punts)?
 *
 *   $ ./node_modules/.bin/tsx --env-file=.env src/scripts/replay-resume-turn.ts
 */
import { getChatModel, getChatProviderOptions } from "@alfred/ai";
import { closeConnections, listToolsForIntegration, registerBuiltinTools } from "@alfred/api";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { generateText, stepCountIs, tool, type ToolSet } from "ai";

// Verbatim system prompt the model received (from Langfuse I/O capture).
const SYSTEM = `You are Alfred, the user's personal assistant. You are chatting with them directly. Be warm, concise, and direct — answer the question and don't pad.

How you work:
- Use integration tools for the user's real email, calendar, documents, files, and connected services. Integration tools are named integration.action (for example calendar.list_events); never call a bare action name like list_events.
- Use only tools that exist. Never invent a plausible-sounding tool name — pick the closest real tool over guessing, and never ask the user for a parameter (a repo, an account, a date) you can resolve or look up yourself.
- When the user asks for a real connected service whose tool is not active yet, infer the integration and call system.load_integration yourself. Do not ask the user to load an integration just to proceed.
- Use system.read_user_context before answering questions or making judgments about the user's people, relationships, preferences, standing instructions, projects, or personal context. Do not guess from generic memory when this tool can read Alfred's stored context.
- Default to calling tools directly, and fan out independent lookups in the same turn rather than one item at a time; then synthesize their results.

The current date is Thursday, 25 June 2026 (2026-06-25), timezone Asia/Calcutta.

You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.
- gmail — search, read_message, send_draft — the user's email
- calendar — list_events, create_event — the user's calendar
- drive — search_files, get_file, export_file, download_file — the user's Drive files
- docs — get_document — the user's Google Docs
- github — search, get_pull_request, get_issue — the user's GitHub issues and pull requests — connected as 99Yash`;

const USER =
  "Edit my resume and fill it up with the description from my website. just the experience section.";

function systemToolSet(rename?: (n: string) => string): ToolSet {
  const out: ToolSet = {};
  for (const t of listToolsForIntegration("system")) {
    // `execute`-less, exactly like the real dispatch loop (decorateTools).
    out[rename ? rename(t.name) : t.name] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
    });
  }
  return out;
}

async function run(
  label: string,
  model: Parameters<typeof generateText>[0]["model"],
  opts: { rename?: (n: string) => string; providerOptions?: Record<string, unknown> } = {},
) {
  const tools = systemToolSet(opts.rename);
  try {
    const res = await generateText({
      model,
      system: SYSTEM,
      messages: [{ role: "user", content: USER }],
      tools,
      stopWhen: stepCountIs(1),
      providerOptions: opts.providerOptions as never,
    });
    const calls = res.toolCalls ?? [];
    console.log(`\n===== ${label} =====`);
    console.log("finishReason:", res.finishReason);
    console.log("toolCalls:", calls.length ? calls.map((c) => c.toolName).join(", ") : "(none)");
    for (const c of calls) console.log("  →", c.toolName, JSON.stringify(c.input));
    console.log("text:", res.text || "(empty)");
  } catch (e) {
    console.log(`\n===== ${label} =====`);
    console.log("THREW:", (e as Error).message);
  }
}

async function main() {
  registerBuiltinTools();
  const dot2us = (n: string) => n.replace(/\./g, "__");
  // A) Faithful prod path: the real withFallback wrapper + provider options.
  for (let i = 0; i < 3; i++)
    await run(`PROD WRAPPER getChatModel(standard) trial ${i + 1}`, getChatModel("standard"), {
      providerOptions: getChatProviderOptions("standard") as Record<string, unknown>,
    });
  // B) Sonnet, dotted names (the names the harness actually uses).
  await run("SONNET 4.6  dotted names", anthropic("claude-sonnet-4-6"));
  // C) Sonnet, dots→__ (does renaming fix the rejection?).
  await run("SONNET 4.6  underscored names", anthropic("claude-sonnet-4-6"), { rename: dot2us });
  // C2) Sonnet, underscored names + the real adaptive-thinking provider options
  // (is `thinking:{type:'adaptive'}` a SECOND 400 source on Sonnet, like #224 on Opus?).
  await run("SONNET 4.6  underscored + providerOptions", anthropic("claude-sonnet-4-6"), {
    rename: dot2us,
    providerOptions: getChatProviderOptions("standard") as Record<string, unknown>,
  });
  // D) Gemini, dotted names.
  await run("GEMINI 2.5 PRO  dotted names", google("gemini-2.5-pro"));
  await closeConnections();
}

void main();
