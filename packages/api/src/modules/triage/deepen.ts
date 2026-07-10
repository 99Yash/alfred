import { getBossModel, meteredGenerateObject } from "@alfred/ai";
import {
  SEVERITY_SUSPECT_BOTS,
  TRIAGE_CATEGORIES,
  confidenceSchema,
  type SenderContext,
  type TriageCategory,
} from "@alfred/contracts";
import { z } from "zod";
import type { TriageClassification } from "./classify";
import type { TriageUserContext } from "./user-context";

export const DEEPEN_REASONS = ["severity_suspect_bot", "low_confidence", "unknown_human"] as const;
export type DeepenReason = (typeof DEEPEN_REASONS)[number];

export type DeepenMode = "skip" | "shadow" | "execute";

export interface DeepenDecision {
  mode: DeepenMode;
  reason?: DeepenReason;
}

export interface DeepenTriageArgs {
  /** Optional metering attribution. The caller supplies the already-bounded user context. */
  userId?: string;
  document: {
    id: string;
    title: string | null;
    content: string;
    authoredAt: Date | null;
    metadata: Record<string, unknown>;
  };
  classification: TriageClassification;
  senderContext: SenderContext;
  userContext: TriageUserContext;
  runId?: string;
  stepId?: string;
  attempt?: number;
  idempotencyKey?: string;
}

export interface DeepenTriageResult {
  classification: TriageClassification;
  severityFlag: DeepenOutput["severityFlag"];
  dossierRequest?: {
    personEmail: string;
  };
}

const importantCategories = new Set<TriageCategory>(["urgent", "action_needed", "awaiting_reply"]);

const deepenOutputSchema = z.object({
  refinedCategory: z.enum(TRIAGE_CATEGORIES),
  confidence: confidenceSchema,
  rationale: z.string().min(1).max(500),
  severityFlag: z.enum(["severe", "normal", "low"]),
  dossierRequest: z.object({ personEmail: z.string().email() }).optional(),
});
type DeepenOutput = z.infer<typeof deepenOutputSchema>;

const DEEPEN_SYSTEM_PROMPT = `You refine email triage for Alfred, a personal assistant.

You receive:
- the cheap classifier output,
- deterministic SenderContext,
- compact user context from Alfred's database,
- one email.

Return the final category. Keep the same 10-category taxonomy:
urgent, action_needed, follow_up, awaiting_reply, meeting, fyi, done, payment, newsletter, marketing.

Rules:
1. Use user context only to judge relevance/severity. Do not invent facts not present in the email or context.
2. For severity-suspect bot alerts, determine whether this affects the user's real account/project/integration. Use urgent only for same-day or access-breaking consequences.
3. Payment failures that break access today may be urgent; ordinary receipts/statements stay payment.
4. Error/deploy/security alerts are urgent only when they affect production, access, security, or a user-owned active project. Otherwise choose action_needed, fyi, or done as appropriate.
5. Code review bots are advisory by default unless the body shows security exposure, production impact, blocked deploy/release, or an explicit same-day remediation deadline.
6. Public events, webinars, conferences, keynotes, AGMs, and shareholder notices are not meetings unless the user is personally expected to attend or schedule.
7. Do not request web search. If a human sender looks important but profile research would help, set dossierRequest; the async dossier workflow handles that later.
8. Rationale must be 1-2 sentences citing concrete cues from the email/context.`;

export function shouldDeepen(args: {
  classification: TriageClassification;
  senderContext: SenderContext;
  senderAddress?: string | null;
  knownSender?: boolean;
}): DeepenDecision {
  if (args.senderContext.botSlug && SEVERITY_SUSPECT_BOTS.has(args.senderContext.botSlug)) {
    return { mode: "execute", reason: "severity_suspect_bot" };
  }

  if (args.classification.confidence < 0.7) {
    return { mode: "shadow", reason: "low_confidence" };
  }

  if (
    args.senderAddress &&
    args.senderContext.effectiveAuthor === "person" &&
    importantCategories.has(args.classification.category) &&
    args.knownSender !== true
  ) {
    return { mode: "shadow", reason: "unknown_human" };
  }

  return { mode: "skip" };
}

export async function deepenTriageClassification(
  args: DeepenTriageArgs,
): Promise<DeepenTriageResult> {
  const model = getBossModel();
  const result = await meteredGenerateObject<DeepenOutput>(
    {
      model,
      instructions: DEEPEN_SYSTEM_PROMPT,
      prompt: deepenUserPrompt(args),
      schema: deepenOutputSchema,
      schemaName: "triage_deepen",
      schemaDescription:
        "Refines an email triage category using sender context and compact user context.",
      temperature: 0,
      maxOutputTokens: 1_500,
    },
    {
      role: "triage",
      userId: args.userId,
      runId: args.runId,
      stepId: args.stepId,
      attempt: args.attempt,
      idempotencyKey: args.idempotencyKey,
      requestMeta: {
        purpose: "triage.deepen",
        documentId: args.document.id,
        cheapCategory: args.classification.category,
        botSlug: args.senderContext.botSlug ?? null,
      },
      name: "triage.deepen",
    },
  );

  return {
    classification: {
      category: result.object.refinedCategory,
      confidence: result.object.confidence,
      rationale: truncateRationale(result.object.rationale),
    },
    severityFlag: result.object.severityFlag,
    ...(result.object.dossierRequest ? { dossierRequest: result.object.dossierRequest } : {}),
  };
}

function deepenUserPrompt(args: DeepenTriageArgs): string {
  const meta = args.document.metadata;
  const lines: string[] = [];
  lines.push("=== CheapClassifier ===");
  lines.push(JSON.stringify(args.classification));
  lines.push("");
  lines.push("=== SenderContext ===");
  lines.push(JSON.stringify(args.senderContext));
  lines.push("");
  lines.push("=== UserContext ===");
  lines.push(compactJson(args.userContext, 6_000));
  lines.push("");
  lines.push("=== Email ===");
  appendStringMeta(lines, "From", meta.from);
  appendStringMeta(lines, "To", meta.to);
  appendStringMeta(lines, "Cc", meta.cc);
  if (args.document.title) lines.push(`Subject: ${args.document.title}`);
  if (args.document.authoredAt) lines.push(`Date: ${args.document.authoredAt.toISOString()}`);
  appendStringMeta(lines, "GmailSnippet", meta.snippet);
  lines.push("");
  lines.push("=== Body ===");
  lines.push(truncateText(args.document.content, 8_000));
  return lines.join("\n");
}

function appendStringMeta(lines: string[], label: string, value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    lines.push(`${label}: ${value}`);
  }
}

function compactJson(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value);
  return truncateText(text, maxChars);
}

function truncateText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 15)}\n[...truncated]` : value;
}

function truncateRationale(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}
