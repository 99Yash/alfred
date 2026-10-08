import { route, meteredGenerateObject } from "@alfred/ai";
import { confidenceSchema } from "@alfred/contracts";
import { z } from "zod";
import type { ColdStartSignals } from "./signals";

/**
 * Turn the cold-start summary into `user_facts` proposals (ADR-0011, ADR-0019).
 * `value` is a plain string because structured output failed often on a union.
 * `rationale` allows 2000 chars because the model quotes sources at length.
 */

export const coldStartProposalSchema = z.object({
  /**
   * Canonical snake_case key (#330). Cold-start keys: `full_name`, `bio_summary`,
   * `employer`, `job_title`, `team`, `location`, `home_city`, `home_country`,
   * `personal_site`, `github_username`, `twitter_handle`, `linkedin_url`,
   * `marital_status`, `spouse_name`, `family_summary`, `notable_relations`.
   */
  key: z.string().min(1).max(100),
  value: z.string().min(1).max(2_000),
  confidence: confidenceSchema,
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

  // Domain only: the rules forbid the local-part as a fact.
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
      model: route("cheap").model(),
      instructions: SYSTEM_PROMPT,
      prompt: buildUserPrompt(args),
      schema: extractColdStartResultSchema,
      temperature: 0,
      // 2k truncated the JSON on long research.
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
