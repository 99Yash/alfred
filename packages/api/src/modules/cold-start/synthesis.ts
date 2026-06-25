import { getBossModel, meteredGenerateText } from "@alfred/ai";
import type { AspectFinding } from "./aspects";
import type { IdentityAnchor } from "./seed";
import type { ColdStartSignals } from "./signals";

/**
 * Cold-start v2 — step 3 of the agent harness: boss synthesis
 * (ADR-0011/0022 amendment).
 *
 * The boss folds the identity anchor + every aspect finding into one tight,
 * telegraphic research summary (~300 words). This summary is what gets
 * persisted as the `cold_start_research` memory chunk AND fed to the existing
 * cheap-tier fact extractor — so the v1 extract→persist tail (ADR-0019's
 * two-stage extract) is reused byte-for-byte. The {@link ResearchResult} shape
 * is unchanged from the old single-call Sonar path it replaces.
 *
 * Telegraphic on purpose: aspect findings are verbose and overlapping; the
 * synthesis dedupes, drops the padding, and keeps only attested claims. No
 * tools here — synthesis reasons over findings the sub-agents already gathered.
 */

const SYNTHESIS_MAX_OUTPUT_TOKENS = 1_500;

export interface ResearchResult {
  /** Telegraphic synthesized research — the memory chunk + extractor input. */
  content: string;
  /** Deduped citation URLs gathered across seed + all aspects. */
  citations: string[];
  /** finish_reason / token usage surfaced for ops visibility. */
  meta: {
    finishReason: string;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface SynthesizeColdStartArgs {
  signals: ColdStartSignals;
  anchor: IdentityAnchor;
  aspects: AspectFinding[];
  runId?: string;
  stepId?: string;
  idempotencyKey?: string;
}

const SYSTEM_PROMPT = `You synthesize parallel web-research findings into one tight profile of a single person for their personal AI assistant. The findings came from focused sub-agents researching the person's own public footprint at their request.

Rules:
1. Be CONSERVATIVE and faithful. Carry over only claims the findings actually attest. Respect every hedge ("tentative", "could not confirm") — when the findings doubt something, your summary must too. Drop anything a sub-agent reported as not found.
2. Telegraphic, ~300 words MAX. Dense factual clauses, not flowing prose. No preamble, no executive summary, no meta-commentary about the research process. If a whole topic turned up nothing, omit it rather than writing "nothing was found about X".
3. Dedupe across facets — the same fact may appear in several findings; state it once.
4. RELATION GUARD: include a family member only when a finding explicitly attests the relationship; never infer from a shared surname or city. For a public-figure relative, one clause on why they're notable. For minor children, only "exists / how many".
5. Public sources only. Never include contact details (home address, personal phone, email address, exact birthdate).
6. If the identity anchor was "no confident match" and the findings are empty, output a single line saying no confident public profile was found — do not confabulate.`;

function buildPrompt(args: SynthesizeColdStartArgs): string {
  const lines: string[] = [];
  lines.push(`Subject:`);
  lines.push(`- Name: ${args.signals.name}`);
  // No full email — synthesis output is persisted as the memory chunk, so keep
  // the contact-detail local-part out of it. Name + domain + anchor suffice.
  if (args.signals.emailDomain) lines.push(`- Email domain: ${args.signals.emailDomain}`);
  lines.push("");
  lines.push(`=== Identity anchor ===`);
  lines.push(args.anchor.anchor);
  for (const a of args.aspects) {
    lines.push("");
    lines.push(`=== ${a.label} ===`);
    lines.push(a.finding);
  }
  return lines.join("\n");
}

/** Order-preserving dedupe of every citation gathered upstream. */
function mergeCitations(anchor: IdentityAnchor, aspects: AspectFinding[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of [...anchor.citations, ...aspects.flatMap((a) => a.citations)]) {
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

export async function synthesizeColdStart(args: SynthesizeColdStartArgs): Promise<ResearchResult> {
  const result = await meteredGenerateText(
    {
      model: getBossModel(),
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(args),
      maxOutputTokens: SYNTHESIS_MAX_OUTPUT_TOKENS,
      temperature: 0,
    },
    {
      kind: "llm",
      role: "cold_start",
      userId: args.signals.userId,
      runId: args.runId,
      stepId: args.stepId,
      idempotencyKey: args.idempotencyKey,
      requestMeta: { purpose: "cold-start.synthesis" },
      name: "cold-start.synthesis",
    },
  );

  return {
    content: result.text.trim(),
    citations: mergeCitations(args.anchor, args.aspects),
    meta: {
      finishReason: result.finishReason,
      inputTokens: result.totalUsage?.inputTokens,
      outputTokens: result.totalUsage?.outputTokens,
    },
  };
}
