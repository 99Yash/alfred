import { getCheapModel, meteredGenerateObject } from "@alfred/ai";
import {
  chatMemoryExtractionResultSchema,
  type ChatMemoryExtractionResult,
  type ChatProposition,
} from "@alfred/contracts";
import type { ChatMessageRole } from "@alfred/db/schemas";

/**
 * Chat → memory end-of-thread extractor (chat-memory-capture-v1.md, #398;
 * decisions D6/D9).
 *
 * A pure cheap-model pass over a FINISHED chat transcript that distills CRISP,
 * nameable propositions (D6) tagged with the D4 epistemic axes. It mirrors the
 * document extractor (`../memory/extraction.ts`): the LLM call is kept separate
 * from persistence so the workflow owns writes (and #399 can wire the output
 * into `insertObservation` without touching this file), and so both the
 * transcript-building and the parse are unit-testable without the AI SDK.
 *
 * v1 reads role + content only (D9) — tool-call details are out of scope. The
 * idle debounce means the whole conversation is visible, so a correction arc
 * has already resolved: capture the FINAL state, never the mid-thread wrong turn.
 *
 * Cheap-tier model per ADR-0016 (`getCheapModel()`).
 */

/** One transcript turn the extractor reads (role + content only, D9). */
export interface ThreadTurn {
  role: ChatMessageRole;
  content: string;
}

/**
 * Char budget for the transcript fed to the extractor. Bounded like the doc
 * extractor's ~12k cap; when a thread exceeds it we keep the LATEST turns so
 * the resolved end-of-thread state (the whole point of the debounce, D9)
 * survives — the oldest turns are dropped first.
 */
export const MAX_TRANSCRIPT_CHARS = 12_000;

export interface ExtractThreadArgs {
  userId: string;
  threadId: string;
  /** The thread's finished turns, oldest-first. */
  transcript: ThreadTurn[];
  /** Run/step ids forwarded to the metering log + Langfuse trace. */
  runId?: string;
  stepId?: string;
  /** Stable per-call idempotency key — caller derives from `(runId, stepId, threadId)`. */
  idempotencyKey?: string;
  /**
   * Seam for tests (and future callers): the structured-generation function.
   * Defaults to the metered cheap-model call. A test can inject a stub that
   * returns a fixed object without dragging the AI SDK into the harness — the
   * same split the doc extractor achieves via the workflow's manual mode.
   */
  generate?: GenerateObject;
}

/** The minimal generation seam the extractor depends on (see `ExtractThreadArgs.generate`). */
export type GenerateObject = (args: {
  system: string;
  prompt: string;
}) => Promise<ChatMemoryExtractionResult>;

const ROLE_LABELS: Record<ChatMessageRole, string> = {
  user: "User",
  assistant: "Alfred",
};

/**
 * Render the turns into a `Role: content` transcript, newest-preserving. Joins
 * turns oldest-first but, when the budget is exceeded, drops from the FRONT so
 * the tail (where a correction lands) is always kept. Pure + exported so the
 * truncation rule is unit-testable on its own.
 */
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

  // Accumulate from the newest turn backwards until the budget is spent, so the
  // dropped turns are the oldest ones.
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

/**
 * Default generation seam: the metered cheap-model structured-output call.
 * Mirrors `extractFactsFromDocument`'s metering attribution so chat capture
 * shows up in the same cost lane.
 */
function defaultGenerate(args: ExtractThreadArgs): GenerateObject {
  return async ({ system, prompt }) => {
    const result = await meteredGenerateObject<ChatMemoryExtractionResult>(
      {
        model: getCheapModel(),
        system,
        prompt,
        schema: chatMemoryExtractionResultSchema,
        temperature: 0,
        // Hard cap so a misbehaving model can't produce a huge blob.
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
    return result.object;
  };
}

/**
 * Run the cheap-tier model over a finished thread and return its crisp
 * propositions. No persistence — the caller (the `chat-memory-capture`
 * workflow) owns what happens next. Returns an empty array for an empty
 * transcript without calling the model.
 */
export async function extractPropositionsFromThread(
  args: ExtractThreadArgs,
): Promise<ChatProposition[]> {
  const transcript = buildThreadTranscript(args.transcript);
  if (transcript.trim().length === 0) return [];

  const generate = args.generate ?? defaultGenerate(args);
  const result = await generate({ system: SYSTEM_PROMPT, prompt: userPrompt(transcript) });
  // Re-validate the seam's output so an injected/relaxed generator can't return
  // a shape that violates the contract downstream consumers rely on.
  return chatMemoryExtractionResultSchema.parse(result).propositions;
}
