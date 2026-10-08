import { route, meteredGenerateObject } from "@alfred/ai";
import {
  chatMemoryExtractionResultSchema,
  type ChatMemoryExtractionResult,
  type ChatProposition,
} from "@alfred/contracts";
import type { ChatMessageRole } from "@alfred/db/schemas";

/**
 * Chat end-of-thread extractor (`docs/plans/chat-memory-capture-v1.md`, D6/D9).
 * A cheap-model pass over a finished transcript that returns crisp, tagged
 * propositions. It writes nothing. Reads role and content only. The thread is
 * finished, so capture the final state, not a mid-thread wrong turn.
 */

/** One transcript turn: role and content only (D9). */
export interface ThreadTurn {
  role: ChatMessageRole;
  content: string;
}

/** Over budget, keep the latest turns: the resolved end state lives there. */
export const MAX_TRANSCRIPT_CHARS = 12_000;

export interface ExtractThreadArgs {
  userId: string;
  threadId: string;
  /** Finished turns, oldest first, or an already-rendered transcript. */
  transcript: ThreadTurn[] | string;
  /** Forwarded to the metering log and Langfuse trace. */
  runId?: string;
  stepId?: string;
  /** The caller derives it from `(runId, stepId, threadId)`. */
  idempotencyKey?: string;
  /** Test seam. Defaults to the metered cheap-model call. */
  generate?: GenerateObject;
}

export type GenerateObject = (args: {
  system: string;
  prompt: string;
}) => Promise<ChatMemoryExtractionResult>;

const ROLE_LABELS = {
  user: "User",
  assistant: "Alfred",
} satisfies Record<ChatMessageRole, string>;

/** Render `Role: content` lines, dropping the oldest turns when over budget. */
export function buildThreadTranscript(
  transcript: ThreadTurn[],
  maxChars: number = MAX_TRANSCRIPT_CHARS,
): string {
  const lines = transcript
    .map((t) => {
      const body = t.content.trim();

      return body.length > 0 ? `${ROLE_LABELS[t.role]}: ${body}` : null;
    })
    .filter((line): line is string => line !== null);

  // Walk back from the newest turn, so the oldest turns drop first.
  const kept: string[] = [];
  let used = 0;
  let truncated = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;

    if (line.length > maxChars && kept.length === 0) {
      kept.push(line.slice(line.length - maxChars));
      truncated = true;
      break;
    }

    // +1 for the joining newline between turns.
    const cost = line.length + (kept.length > 0 ? 1 : 0);

    if (used + cost > maxChars && kept.length > 0) {
      truncated = true;
      break;
    }

    kept.push(line);
    used += cost;
  }

  kept.reverse();
  const marker = truncated ? "[…earlier turns truncated]\n" : "";

  return `${marker}${kept.join("\n")}`;
}

function capRenderedTranscript(
  transcript: string,
  maxChars: number = MAX_TRANSCRIPT_CHARS,
): string {
  const trimmed = transcript.trim();

  if (trimmed.length <= maxChars) return trimmed;

  return `[…earlier turns truncated]\n${trimmed.slice(trimmed.length - maxChars)}`;
}

export const SYSTEM_PROMPT = `You read a FINISHED conversation between a user and their personal assistant (Alfred) and extract durable, CRISP facts worth remembering.

The conversation is over. Because you see the whole thread, any back-and-forth has already resolved — capture the FINAL, settled state of every claim, never a value the user later corrected.

Extract ONLY crisp, nameable, checkable propositions — a specific person's role or name, the user's employer/title/location, a stated preference, a relationship. Each proposition must be a single lasting truth you could write on an index card.

NEVER extract diffuse, countable, or aggregate signal. Things like "how many people work at a company", "who the user talks to most", "how active a project is", or general org membership are computed on demand from other data — they are NOT facts to extract. If a claim is a count, a frequency, a ranking, or a vague impression, SKIP it. When in doubt, skip: an empty list is the common, correct outcome.

For every proposition you DO keep, tag it:
- subject: "user" if it is about the user themselves; "entity" if it is about another person or organization. For "entity", also set subjectRef to how they were named (an email if given, else the display name).
- key: a short snake_case key naming the attribute (e.g. "employer", "job_title", "home_city", "user_nickname", "pref:tone", or "relationship:<email>" for the user's relationship to someone). Use your best guess — it is normalized later.
- value: the simplest correct value — a plain string for atomic facts, or a shallow object for structured ones (e.g. { "role": "co-founder" }).
- verificationClass: how the claim could be confirmed — "self_evident" (needs no source, e.g. the user's own nickname/preference), "integration_checkable" (confirmable against the user's own connected accounts), "external_checkable" (needs a public/web source), or "user_only" (subjective or private; only the user can attest).
- volatility: "stable" if it rarely changes (a name, "co-founder of"), "volatile" if it is expected to drift (a current title, a company someone currently works at).
- attribution: who established it in THIS conversation — "user_assertion" (the user stated it), "user_correction" (the user corrected an earlier claim), "user_confirmation" (the user affirmed a claim), "user_rejection" (the user rejected a claim), or "alfred_enrichment" (Alfred inferred it, e.g. from a web lookup — not something the user attested).
- confidence: 0.0–1.0. Use 0.9+ for facts the user stated plainly; skip anything below ~0.6.
- rationale: one short sentence quoting or paraphrasing the turn that grounds the proposition.

Output a JSON object: { "propositions": [ { "subject": ..., "key": ..., "value": ..., "verificationClass": ..., "volatility": ..., "attribution": ..., "confidence": ..., "rationale": ... }, ... ] }`;

function userPrompt(transcript: string): string {
  return ["=== Conversation transcript ===", transcript].join("\n");
}

/** The metered cheap-model call, attributed like `extractFactsFromDocument`. */
function defaultGenerate(args: ExtractThreadArgs): GenerateObject {
  return async ({ system, prompt }) => {
    const result = await meteredGenerateObject<ChatMemoryExtractionResult>(
      {
        model: route("cheap").model(),
        instructions: system,
        prompt,
        schema: chatMemoryExtractionResultSchema,
        temperature: 0,
        maxOutputTokens: 2_000,
      },
      {
        role: "memory_extraction",
        userId: args.userId,
        runId: args.runId,
        stepId: args.stepId,
        idempotencyKey: args.idempotencyKey,
        requestMeta: {
          purpose: "chat-memory.extract",
          threadId: args.threadId,
        },
        name: "chat-memory.extract",
      },
    );

    return result.output;
  };
}

/** Propositions from a finished thread. Empty transcript returns `[]` with no model call. */
export async function extractPropositionsFromThread(
  args: ExtractThreadArgs,
): Promise<ChatProposition[]> {
  const transcript =
    typeof args.transcript === "string"
      ? capRenderedTranscript(args.transcript)
      : buildThreadTranscript(args.transcript);

  if (transcript.trim().length === 0) return [];

  const generate = args.generate ?? defaultGenerate(args);
  const result = await generate({ system: SYSTEM_PROMPT, prompt: userPrompt(transcript) });

  // Re-validate: an injected generator can return anything.
  return chatMemoryExtractionResultSchema.parse(result).propositions;
}
