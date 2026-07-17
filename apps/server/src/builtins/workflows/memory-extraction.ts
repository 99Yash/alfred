import {
  factProposalSchema,
  runMemoryFinalize,
  runMemoryPickDocuments,
  runMemoryProcess,
  type Workflow,
} from "@alfred/api/backend";
import { z } from "zod";

const stateSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  manualProposals: z.record(z.string(), z.array(factProposalSchema)).optional(),
  sinceDays: z.number().int().positive(),
  maxDocs: z.number().int().positive(),
  documentIds: z.array(z.string()),
  startedAt: z.string(),
  processed: z.number().int().nonnegative(),
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

export const memoryExtractionWorkflow: Workflow<State> = {
  slug: "memory-extraction",
  name: "Memory extraction",
  description: "Daily extraction of structured facts from recently-ingested documents (ADR-0019).",
  trigger: { kind: "cron", schedule: "0 3 * * *" },
  initialStep: "pick-documents",
  stateSchema,
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
      proposed: 0,
      blocked: 0,
    };
  },
  steps: {
    "pick-documents": { id: "pick-documents", run: runMemoryPickDocuments },
    process: { id: "process", run: runMemoryProcess },
    finalize: { id: "finalize", run: runMemoryFinalize },
  },
};

export type MemoryExtractionInput = z.infer<typeof inputSchema>;
