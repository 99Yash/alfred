import { getCheapModel, meteredGenerateObject } from "@alfred/ai";
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
 * Conservative-by-default: facts about other people, ambiguous signals,
 * and anything below 0.7 confidence get dropped. Single-user trust
 * matters more than recall for cold start.
 */

const factValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const coldStartProposalSchema = z.object({
  /**
   * Canonical snake_case key. Allowed shapes for cold-start output:
   *   `name`, `company`, `job_title`, `team`, `location`,
   *   `home_city`, `home_country`,
   *   `personal_site`, `github_username`, `twitter_handle`, `linkedin_url`,
   *   `bio_summary` (one-paragraph self-introduction text).
   */
  key: z.string().min(1).max(100),
  value: factValueSchema,
  confidence: z.number().min(0).max(1),
  /** Quote or paraphrase the citation that grounds the fact. */
  rationale: z.string().min(1).max(500),
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
   - 'name', 'company', 'job_title', 'team', 'location'
   - 'home_city', 'home_country'
   - 'personal_site' (URL), 'github_username', 'twitter_handle', 'linkedin_url'
   - 'bio_summary' (one short paragraph self-introduction text, ≤400 chars)
4. Confidence calibration:
   - 0.95+ : research stated as fact with multiple supporting citations
   - 0.7–0.9 : research stated as fact with one or weak citations
   - <0.7 : SKIP — do not emit
5. Do NOT propose:
   - Facts about other people (family members, colleagues by name).
   - The user's email or email domain — those are already known and do not need to be re-stored.
   - Anything sensitive (home address, phone, financial details).
6. If research couldn't confirm anyone matching the subject (or matched the wrong person), return an empty proposals array.

Output a JSON object: { "proposals": [{ "key": "...", "value": ..., "confidence": 0.0–1.0, "rationale": "..." }, ...] }`;

function buildUserPrompt(args: ExtractColdStartFactsArgs): string {
  const lines: string[] = [];
  lines.push(`Subject:`);
  lines.push(`- Name: ${args.signals.name}`);
  lines.push(`- Email: ${args.signals.email}`);
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
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(args),
      schema: extractColdStartResultSchema,
      temperature: 0,
      // Schema permits up to 20 proposals × ~150 tokens each + JSON
      // overhead. 4k is comfortable headroom; 2k truncated mid-JSON on
      // longer research outputs and the SDK rejected the partial parse.
      maxOutputTokens: 4_000,
    },
    {
      userId: args.signals.userId,
      runId: args.runId,
      stepId: args.stepId,
      idempotencyKey: args.idempotencyKey,
      requestMeta: { purpose: "cold-start.extract" },
      name: "cold-start.extract",
    },
  );
  return result.object.proposals;
}
