import { getCheapModel, meteredGenerateObject } from "@alfred/ai";
import { confidenceSchema } from "@alfred/contracts";
import type { Document } from "@alfred/db/schemas";
import { factValueSchema } from "@alfred/sync";
import { z } from "zod";

/**
 * Memory-extraction sub-agent (ADR-0019).
 *
 * Pure function over a single document. Returns proposals; the
 * workflow is responsible for calling `proposeFact` (which enforces the
 * idempotency + rejection guards) and persisting status rows. Keeping
 * the LLM call separate from the persistence layer makes both unit
 * testable and lets the workflow inject pre-baked proposals in test
 * mode without dragging the AI SDK into the test harness.
 *
 * Cheap-tier model per ADR-0016 (`getCheapModel()` → Gemini 2.5 Flash).
 */

export const factProposalSchema = z.object({
  /**
   * Canonical key. Use snake-case. Examples:
   *   `manager`, `employer`, `birthday`, `home_city`,
   *   `relationship:alice@oliv.ai`, `pref:tone`.
   */
  key: z.string().min(1).max(200),
  value: factValueSchema,
  confidence: confidenceSchema,
  /** Short justification grounded in the source — used for audit and to debug bad proposals. */
  rationale: z.string().min(1).max(500),
});
export type FactProposal = z.infer<typeof factProposalSchema>;

export const extractionResultSchema = z.object({
  proposals: z.array(factProposalSchema).max(20),
});

export interface ExtractDocumentArgs {
  userId: string;
  /**
   * The document to extract facts from. Derived from the `documents` table
   * so the shape (and its nullability) can never drift from the schema —
   * see the duplication rules in docs/reference/code-style.md.
   */
  document: Pick<Document, "id" | "title" | "content" | "source" | "authoredAt">;
  /** Existing confirmed facts so the model can avoid duplicates. Top-N most relevant. */
  existingFacts?: Array<{ key: string; value: unknown }>;
  /** Run/step ids forwarded to the metering log + Langfuse trace. */
  runId?: string;
  stepId?: string;
  /** Stable per-call idempotency key — caller should derive from `(runId, stepId, doc.id)`. */
  idempotencyKey?: string;
}

const SYSTEM_PROMPT = `You extract durable facts ABOUT THE USER from their personal data (emails, calendar events, slack messages, docs).

The single test for every fact: "Is this a lasting truth about the USER as a person — their identity, life, work, preferences, or relationships?" If it instead describes a third party, a company, a job posting, a product, or the message/document itself, it is NOT a user fact. SKIP it.

Rules:
1. Be CONSERVATIVE. Only propose a fact if the document strongly and unambiguously supports it AND it passes the test above. When in doubt, skip. Most emails (newsletters, job alerts, recruiter outreach, receipts, automated notifications, statements) yield ZERO user facts — returning an empty array is the common, correct outcome.
2. Cite evidence in 'rationale' — quote or paraphrase the specific clause that grounds the fact AND why it is about the user, not a third party.
3. The user's OWN employment (\`employer\`, \`job_title\`, \`team\`, \`manager\`) counts ONLY when the document is authored by or unambiguously about the user themselves — e.g. their own offer letter, their signature block, their own LinkedIn. A job posting, recruiter message, job-board digest, or newsletter that merely NAMES a company or role is about that posting, NOT the user — SKIP it. Never treat a company/title mentioned in an opportunity as the user's employer.
4. NEVER store attributes of the source document or its sender as facts. No email subjects, bodies, senders, recipients, message ids, dates, thread ids; no PR/issue numbers; no newsletter author; no addresses, websites, or locations of a company named in the email. A contact's signature-block city/phone/site is THAT PERSON'S, never the user's. If a key would describe the message or a third party rather than the user, do not emit it.
5. Use ONLY these canonical snake_case keys (anything else is dropped downstream):
   - identity: 'full_name', 'first_name', 'last_name', 'user_nickname', 'bio_summary', 'birthday', 'marital_status', 'spouse_name', 'family_summary', 'notable_relations'
   - work: 'employer' (the org the user works for), 'job_title', 'team', 'manager', 'work_summary'
   - location: 'location', 'home_city', 'home_country', 'timezone'
   - online: 'personal_site', 'github_username', 'twitter_handle', 'linkedin_url'
   - 'relationship:<email>' (value: { role, since? }) — the user's relationship to that person
6. The 'value' must be the simplest correct shape: a string for atomic values, an object for structured ones. Prefer canonical forms (full names, ISO dates, lowercase emails).
7. Confidence: 0.95+ for facts directly stated and authored by the user themselves; 0.7–0.9 for clearly implied; below 0.7 means SKIP — do not emit.
8. Do NOT infer facts about other people unless the document directly establishes the user's relationship to them.

Output a JSON object: { "proposals": [{ "key": "...", "value": ..., "confidence": 0.0–1.0, "rationale": "..." }, ...] }`;

function userPrompt(args: ExtractDocumentArgs): string {
  const lines: string[] = [];
  lines.push(`Source: ${args.document.source}`);
  if (args.document.title) lines.push(`Title: ${args.document.title}`);
  if (args.document.authoredAt) lines.push(`Authored: ${args.document.authoredAt.toISOString()}`);
  lines.push("");

  if (args.existingFacts && args.existingFacts.length > 0) {
    lines.push("Already-known facts (do not re-propose these):");
    for (const f of args.existingFacts.slice(0, 30)) {
      lines.push(`  - ${f.key} = ${JSON.stringify(f.value)}`);
    }
    lines.push("");
  }

  lines.push("=== Document content ===");
  // Cap at ~12k chars to keep token budget bounded — most provider
  // emails fit easily; ingested docs that exceed this get truncated.
  const content =
    args.document.content.length > 12_000
      ? args.document.content.slice(0, 12_000) + "\n[…truncated]"
      : args.document.content;
  lines.push(content);
  return lines.join("\n");
}

/**
 * Run the cheap-tier model over a single document and return its
 * proposals. Output is Zod-validated by the AI SDK; on parse failure the
 * caller gets the raw error and the workflow can mark the doc as
 * processed with `proposed_count = 0`.
 */
export async function extractFactsFromDocument(args: ExtractDocumentArgs): Promise<FactProposal[]> {
  const result = await meteredGenerateObject<z.infer<typeof extractionResultSchema>>(
    {
      model: getCheapModel(),
      system: SYSTEM_PROMPT,
      prompt: userPrompt(args),
      schema: extractionResultSchema,
      temperature: 0,
      // Hard cap so a misbehaving model can't produce a 100k-token blob.
      maxOutputTokens: 2_000,
    },
    {
      role: "memory_extraction",
      userId: args.userId,
      runId: args.runId,
      stepId: args.stepId,
      idempotencyKey: args.idempotencyKey,
      requestMeta: {
        purpose: "memory.extract",
        documentId: args.document.id,
        documentSource: args.document.source,
      },
      name: "memory.extract",
    },
  );

  return result.object.proposals;
}
