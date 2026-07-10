import { getCheapModel, meteredGenerateObject } from "@alfred/ai";
import { confidenceSchema } from "@alfred/contracts";
import { z } from "zod";
import type { ColdStartSignals } from "./signals";

/**
 * Turn cold-start research prose into structured `user_facts` proposals
 * (ADR-0011 + ADR-0019).
 *
 * Why a second LLM pass and not a deterministic parse: Sonar's output
 * is free-form prose with inline citations, not a typed payload. The
 * cheap-tier model's job here is purely transformation — read the
 * research, emit a constrained JSON shape — so it doesn't need the
 * boss-tier reasoning budget.
 *
 * Conservative-by-default: ambiguous signals and anything below 0.7
 * confidence get dropped. Single-user trust matters more than recall.
 *
 * Schema choices worth flagging:
 *   - `value` is `z.string()` (not a union). Every cold-start canonical
 *     key holds a string anyway (names, URLs, paragraph summaries) and
 *     Gemini's structured-output mode handles unions inconsistently —
 *     a polymorphic `value` field reliably triggered "response did not
 *     match schema" failures on longer extractions.
 *   - `rationale.max(2000)` is generous on purpose: Gemini quotes
 *     multiple research sources verbatim per proposal once the corpus
 *     is dense enough, and a 500-char cap was the failure mode that
 *     blocked the whole extraction.
 */

export const coldStartProposalSchema = z.object({
  /**
   * Canonical snake_case key. Allowed shapes for cold-start output (#330 — the
   * one fact ontology; `name`→`full_name`, `company`→`employer` still map via
   * `FACT_KEY_ALIASES` but prefer the canonical spelling):
   *   Identity:      `full_name`, `bio_summary` (paragraph)
   *   Work:          `employer`, `job_title`, `team`, `location`,
   *                  `home_city`, `home_country`
   *   Online:        `personal_site` (URL), `github_username`,
   *                  `twitter_handle`, `linkedin_url`
   *   Personal:      `marital_status` (e.g. "married", "single"),
   *                  `spouse_name`, `family_summary` (paragraph),
   *                  `notable_relations` (paragraph naming public-figure
   *                  family members and what makes them notable)
   */
  key: z.string().min(1).max(100),
  value: z.string().min(1).max(2_000),
  confidence: confidenceSchema,
  /** Quote or paraphrase the citation that grounds the fact. */
  rationale: z.string().min(1).max(2_000),
});
export type ColdStartProposal = z.infer<typeof coldStartProposalSchema>;

export const extractColdStartResultSchema = z.object({
  proposals: z.array(coldStartProposalSchema).max(20),
});

export interface ExtractColdStartFactsArgs {
  signals: ColdStartSignals;
  research: { content: string; citations: string[] };
  runId?: string;
  stepId?: string;
  idempotencyKey?: string;
}

const SYSTEM_PROMPT = `You convert free-form web research into structured facts about a single person for their personal AI assistant.

Rules:
1. Be CONSERVATIVE. The research may have hedged ("tentative", "could not confirm") — respect those qualifiers and drop the proposal when the evidence is thin. False facts erode user trust.
2. Cite evidence in 'rationale' — quote or paraphrase the specific clause from the research that grounds the fact.
3. Use snake_case keys. Pick from this short canonical list when applicable; do not invent ad-hoc keys for things outside it:
   Identity:  'full_name', 'bio_summary' (one short paragraph, ≤500 chars)
   Work:      'employer', 'job_title', 'team', 'location',
              'home_city', 'home_country'
   Online:    'personal_site' (URL), 'github_username', 'twitter_handle', 'linkedin_url'
   Personal:  'marital_status' (e.g. "married", "single", "partnered"),
              'spouse_name',
              'family_summary' (one short paragraph on the user's family if the research mentions it),
              'notable_relations' (one short paragraph naming public-figure family members and what makes them notable; only when the research explicitly establishes both the relationship AND why they're notable)
4. Confidence calibration:
   - 0.95+ : research stated as fact with multiple supporting citations
   - 0.7–0.9 : research stated as fact with one or weak citations
   - <0.7 : SKIP — do not emit
5. Do NOT propose:
   - The user's email or email domain — already known.
   - Contact details (home address, personal phone, financial details).
   - Family/relation facts that the research itself didn't explicitly attest. "Likely has a sibling because shared surname" is NOT enough.
6. 'value' must always be a single string. For paragraph-shaped keys ('bio_summary', 'family_summary', 'notable_relations'), keep it under 500 chars and self-contained — no inline citation markers, since the rationale carries those.
7. If research couldn't confirm anyone matching the subject (or matched the wrong person), return an empty proposals array.

Output a JSON object: { "proposals": [{ "key": "...", "value": "...", "confidence": 0.0–1.0, "rationale": "..." }, ...] }`;

function buildUserPrompt(args: ExtractColdStartFactsArgs): string {
  const lines: string[] = [];
  lines.push(`Subject:`);
  lines.push(`- Name: ${args.signals.name}`);
  // Domain only — the local-part is a contact detail the rules already forbid
  // proposing, and there's no reason to put it in front of the extractor.
  if (args.signals.emailDomain) {
    lines.push(`- Email domain: ${args.signals.emailDomain}`);
  }
  lines.push("");
  lines.push(`=== Research output ===`);
  lines.push(args.research.content);
  if (args.research.citations.length > 0) {
    lines.push("");
    lines.push(`=== Citations ===`);
    args.research.citations.forEach((url, i) => {
      lines.push(`[${i + 1}] ${url}`);
    });
  }
  return lines.join("\n");
}

export async function extractColdStartFacts(
  args: ExtractColdStartFactsArgs,
): Promise<ColdStartProposal[]> {
  const result = await meteredGenerateObject<z.infer<typeof extractColdStartResultSchema>>(
    {
      model: getCheapModel(),
      instructions: SYSTEM_PROMPT,
      prompt: buildUserPrompt(args),
      schema: extractColdStartResultSchema,
      temperature: 0,
      // Schema permits up to 20 proposals × ~150 tokens each + JSON
      // overhead. 4k is comfortable headroom; 2k truncated mid-JSON on
      // longer research outputs and the SDK rejected the partial parse.
      maxOutputTokens: 4_000,
    },
    {
      role: "cold_start",
      userId: args.signals.userId,
      runId: args.runId,
      stepId: args.stepId,
      idempotencyKey: args.idempotencyKey,
      requestMeta: { purpose: "cold-start.extract" },
      name: "cold-start.extract",
    },
  );
  return result.output.proposals;
}
