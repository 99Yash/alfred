import { z } from "zod";
import { type GmailSenderParser } from "@alfred/contracts";
import { type Workflow } from "@alfred/assistant/execution";
import { factProposalSchema } from "./extraction";
import { runMemoryFinalize, runMemoryPickDocuments, runMemoryProcess } from "./workflow-operations";

const stateSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  manualProposals: z.record(z.string(), z.array(factProposalSchema)).optional(),
  sinceDays: z.number().int().positive(),
  maxDocs: z.number().int().positive(),
  documentIds: z.array(z.string()),
  startedAt: z.string(),
  processed: z.number().int().nonnegative(),
  // `.default(0)` lets older runs parse; the inferred type stays required.
  extractionErrors: z.number().int().nonnegative().default(0),
  proposed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
});

type State = z.infer<typeof stateSchema>;

const inputSchema = z.object({
  mode: z.enum(["auto", "manual"]).default("auto"),
  manualProposals: z.record(z.string(), z.array(factProposalSchema)).optional(),
  sinceDays: z.number().int().positive().default(7),
  maxDocs: z.number().int().positive().max(100).default(20),
});

/**
 * Build the daily memory-extraction recipe with an injected Gmail sender parser
 * (ADR-0089), so memory never imports triage's parsers. Recipe identity does not depend on `sender`.
 */
export function buildMemoryExtractionWorkflow(sender: GmailSenderParser): Workflow<State> {
  return {
    slug: "memory-extraction",
    name: "Memory extraction",
    description:
      "Daily extraction of structured facts from recently-ingested documents (ADR-0019).",
    trigger: { kind: "cron", schedule: "0 3 * * *" },
    initialStep: "pick-documents",
    stateSchema,
    closure: { kind: "none" },
    initialState(input) {
      const parsed = inputSchema.parse(input.input ?? {});

      return {
        mode: parsed.mode,
        manualProposals: parsed.manualProposals,
        sinceDays: parsed.sinceDays,
        maxDocs: parsed.maxDocs,
        documentIds: [],
        startedAt: new Date().toISOString(),
        processed: 0,
        extractionErrors: 0,
        proposed: 0,
        blocked: 0,
      };
    },
    steps: {
      "pick-documents": { id: "pick-documents", run: runMemoryPickDocuments },
      process: { id: "process", run: (ctx) => runMemoryProcess(sender, ctx) },
      finalize: { id: "finalize", run: runMemoryFinalize },
    },
  };
}
