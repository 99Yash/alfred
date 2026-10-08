import {
  meteredGenerateText,
  requestFitsContextWindow,
  resolveModelContextWindow,
  route,
  type AttributedCall,
  type LanguageModel,
  type ModelMessage,
} from "@alfred/ai";
import type { AgentTranscriptMessage } from "@alfred/contracts";
import { assertHandoffSections } from "./handoff";
import { COMPACTOR_SYSTEM_PROMPT } from "./prompt";
import { CHARS_PER_TOKEN, estimateTranscriptTokens } from "./tokens";

const compactorModel: LanguageModel = route("compactor").model();

const compactorFallbackModel: LanguageModel = route("compactorFallback").model();

/**
 * Replace `prior` with one `<run_summary>` system message and keep `inFlightTail` as is (ADR-0035).
 * The fallback route is used only when `prior` does not fit the primary window.
 * Throws `compactor_input_too_large` when it fits neither.
 */
export interface CompactTranscriptArgs {
  prior: AgentTranscriptMessage[];
  inFlightTail: AgentTranscriptMessage[];
  /** The compactor sets `role` and `kind` itself, so a caller cannot misfile the spend. */
  attribution: Omit<AttributedCall, "role" | "kind">;
  abortSignal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface CompactTranscriptResult {
  transcript: AgentTranscriptMessage[];
  summary: AgentTranscriptMessage;
  raw: { text: string; inputTokens: number | undefined; outputTokens: number | undefined };
}

/** Also reserved by the fit check, so the two cannot drift. */
const COMPACTOR_MAX_OUTPUT_TOKENS = 2000;

/**
 * Request tokens beyond `prior`: the system prompt and the payload wrapper (#371).
 * Without them, a `prior` just under the window gets a provider 400 on every retry.
 */
const COMPACTOR_FIXED_INPUT_OVERHEAD_TOKENS =
  Math.ceil(COMPACTOR_SYSTEM_PROMPT.length / CHARS_PER_TOKEN) + 64;

export async function compactTranscript(
  args: CompactTranscriptArgs,
): Promise<CompactTranscriptResult> {
  const { prior, inFlightTail, attribution } = args;
  const model = await selectCompactorModel(prior);

  const result = await meteredGenerateText(
    {
      model,
      maxOutputTokens: COMPACTOR_MAX_OUTPUT_TOKENS,
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
      ...(args.timeoutMs === undefined ? {} : { timeout: args.timeoutMs }),
      temperature: 0,
      instructions: COMPACTOR_SYSTEM_PROMPT,
      // SAFETY: transcriptPayloadMessage builds one ModelMessage.
      messages: [transcriptPayloadMessage(prior)] as ModelMessage[],
    },
    {
      ...attribution,
      kind: "llm",
      role: "compactor",
    },
  );

  const text = assertRunSummary(result.text);
  const summary = buildSummaryMessage(text);

  return {
    transcript: [summary, ...inFlightTail],
    summary,
    raw: {
      text,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    },
  };
}

function transcriptPayloadMessage(
  prior: readonly AgentTranscriptMessage[],
): AgentTranscriptMessage {
  return {
    role: "user",
    content: `Compact this Alfred transcript JSON. Preserve IDs and tool outcomes exactly where the system prompt requires them.\n\n${JSON.stringify(prior)}`,
  };
}

async function selectCompactorModel(
  prior: readonly AgentTranscriptMessage[],
): Promise<LanguageModel> {
  const priorTokens = estimateTranscriptTokens(prior);
  const compactorWindow = await resolveModelContextWindow(compactorModel);

  if (
    requestFitsContextWindow(priorTokens, {
      contextWindowTokens: compactorWindow,
      outputReserveTokens: COMPACTOR_MAX_OUTPUT_TOKENS,
      fixedInputOverheadTokens: COMPACTOR_FIXED_INPUT_OVERHEAD_TOKENS,
    })
  ) {
    return compactorModel;
  }

  const fallbackWindow = await resolveModelContextWindow(compactorFallbackModel);

  return chooseCompactorModel({ priorTokens, compactorWindow, fallbackWindow });
}

/** Pure, so the headroom math (#371) is testable without live model windows. */
export function chooseCompactorModel(args: {
  priorTokens: number;
  compactorWindow: number;
  fallbackWindow: number;
}): LanguageModel {
  const budget = {
    outputReserveTokens: COMPACTOR_MAX_OUTPUT_TOKENS,
    fixedInputOverheadTokens: COMPACTOR_FIXED_INPUT_OVERHEAD_TOKENS,
  };

  if (
    requestFitsContextWindow(args.priorTokens, {
      ...budget,
      contextWindowTokens: args.compactorWindow,
    })
  ) {
    return compactorModel;
  }

  if (
    requestFitsContextWindow(args.priorTokens, {
      ...budget,
      contextWindowTokens: args.fallbackWindow,
    })
  ) {
    return compactorFallbackModel;
  }

  throw new Error("compactor_input_too_large");
}

/** Exported for tests. */
export const compactorRequestOverheadTokens =
  COMPACTOR_FIXED_INPUT_OVERHEAD_TOKENS + COMPACTOR_MAX_OUTPUT_TOKENS;

/**
 * Require one `<run_summary>` element with every section. Strip Markdown fences, which the model
 * adds anyway.
 * Throw on anything else, so a bad summary is retried and never replaces the transcript.
 */
function assertRunSummary(raw: string): string {
  const trimmed = stripCodeFences(raw).trim();

  if (!trimmed.startsWith("<run_summary>") || !trimmed.endsWith("</run_summary>")) {
    const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
    throw new Error(
      `compactor_invalid_output: expected one <run_summary>…</run_summary> element, got: ${preview}`,
    );
  }

  assertHandoffSections(trimmed);

  return trimmed;
}

function stripCodeFences(text: string): string {
  const fence = /^\s*```(?:xml)?\s*([\s\S]*?)\s*```\s*$/i;
  const match = fence.exec(text);

  return match ? (match[1] ?? text) : text;
}

/**
 * No `cacheControl` here: `decorateTranscript` owns the transcript breakpoints.
 * A fifth breakpoint goes over Anthropic's cap of 4, and the provider then silently drops the
 * tool-definition cache.
 */
function buildSummaryMessage(text: string): AgentTranscriptMessage {
  return {
    role: "system",
    content: text,
  };
}
