/**
 * Paired real-email replay for triage prompt changes — READ-ONLY.
 *
 * Unlike `packages/ai/src/scripts/replay-diff.ts`, this compares the structured
 * output of the single-step triage classifier. It never prints or writes email
 * content. Snapshot files contain document ids only so a candidate run can use
 * the exact same rows; keep them outside the repository.
 *
 * Snapshot a baseline classifier:
 *   pnpm --filter server tsx --env-file=.env \
 *     src/scripts/dry-runs/triage-prompt-replay.ts snapshot \
 *     --classifier /path/to/baseline/packages/assistant/src/triage/classify.ts \
 *     --output /tmp/triage-baseline.json --limit 20
 *
 * Replay those rows with the current classifier and compare:
 *   pnpm --filter server tsx --env-file=.env \
 *     src/scripts/dry-runs/triage-prompt-replay.ts snapshot \
 *     --cases-from /tmp/triage-baseline.json \
 *     --output /tmp/triage-candidate.json
 *   pnpm --filter server tsx --env-file=.env \
 *     src/scripts/dry-runs/triage-prompt-replay.ts compare \
 *     /tmp/triage-baseline.json /tmp/triage-candidate.json
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  assembleObservations,
  classifyEmail as currentClassifyEmail,
  extractSenderContext,
  getSenderPrior,
  getThreadState,
  isKnownContact,
  loadTriageContext,
  resolveSenderKind,
  resolveSenderRelationship,
  senderKeyFor,
  triageClassificationSchema,
  type ClassifyEmailArgs,
  type TriageClassification,
} from "@alfred/assistant/triage";
import { notSentGmailDocumentWhere } from "@alfred/assistant/triage/sent-mail";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const replayResultSchema = z.object({
  documentId: z.string().min(1),
  caseKey: z.string().min(1),
  category: z.string().nullable(),
  collabActivity: z.string().nullable(),
  todoOutcome: z.string().nullable(),
  wouldProposeTodo: z.boolean(),
  rationaleHash: z.string().nullable(),
  rationaleLength: z.number().int().nonnegative().nullable(),
  error: z.boolean(),
});

const replaySnapshotSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  classifier: z.string(),
  results: z.array(replayResultSchema),
});
const classifierModuleSchema = z
  .object({
    classifyEmail: z.function({ input: [z.unknown()], output: z.unknown() }),
  })
  .passthrough();
const classifierOutputSchema = z
  .object({
    classification: triageClassificationSchema,
  })
  .passthrough();

type ReplaySnapshot = z.infer<typeof replaySnapshotSchema>;
type ReplayResult = z.infer<typeof replayResultSchema>;
type ClassifyEmail = (args: ClassifyEmailArgs) => Promise<{ classification: TriageClassification }>;

interface SnapshotOptions {
  classifierPath: string | null;
  outputPath: string;
  casesFromPath: string | null;
  limit: number;
}

function option(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

function snapshotOptions(args: readonly string[]): SnapshotOptions {
  const outputPath = option(args, "--output");
  if (!outputPath) throw new Error("snapshot requires --output <path>");
  const rawLimit = option(args, "--limit");
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return {
    classifierPath: option(args, "--classifier"),
    outputPath,
    casesFromPath: option(args, "--cases-from"),
    limit,
  };
}

async function readSnapshot(path: string): Promise<ReplaySnapshot> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return replaySnapshotSchema.parse(raw);
}

async function loadClassifier(path: string | null): Promise<ClassifyEmail> {
  if (!path) return currentClassifyEmail;
  const module: unknown = await import(pathToFileURL(path).href);
  const parsed = classifierModuleSchema.parse(module);
  return async (args) => classifierOutputSchema.parse(await parsed.classifyEmail(args));
}

async function selectDocumentIds(options: SnapshotOptions): Promise<string[]> {
  if (options.casesFromPath) {
    const prior = await readSnapshot(options.casesFromPath);
    return prior.results.map((result) => result.documentId);
  }
  const rows = await db()
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.source, "gmail"),
        isNotNull(documents.sourceThreadId),
        notSentGmailDocumentWhere(),
      ),
    )
    .orderBy(desc(documents.authoredAt), desc(documents.id))
    .limit(options.limit);
  return rows.map((row) => row.id);
}

async function replayDocument(
  documentId: string,
  classifyEmail: ClassifyEmail,
): Promise<ReplayResult> {
  const selected = (
    await db()
      .select({ userId: documents.userId, sourceThreadId: documents.sourceThreadId })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.source, "gmail")))
      .limit(1)
  )[0];
  const caseKey = createHash("sha256").update(documentId).digest("hex").slice(0, 16);
  if (!selected?.sourceThreadId) return failedResult(documentId, caseKey);

  const ctxData = await loadTriageContext(documentId, selected.userId);
  if (!ctxData) return failedResult(documentId, caseKey);
  const sender = extractSenderContext({
    fromHeader: ctxData.document.metadata.from ?? null,
    subject: ctxData.document.title,
    body: ctxData.document.content,
  });
  const senderKey = senderKeyFor(sender.context, sender.senderAddress);
  const isHumanSender = sender.context.effectiveAuthor === "person";
  const [senderPrior, thread, senderKind] = await Promise.all([
    senderKey
      ? getSenderPrior(selected.userId, senderKey).catch(() => null)
      : Promise.resolve(null),
    getThreadState({
      userId: selected.userId,
      sourceThreadId: selected.sourceThreadId,
      excludeDocumentId: documentId,
    }).catch(() => ({
      lastUserReplyAt: null,
      newestDirection: null,
      messageCount: 0,
      recentMessages: [],
    })),
    resolveSenderKind(selected.userId, sender.senderAddress).catch(() => null),
  ]);
  const usePersonTreatment = isHumanSender && senderKind == null;
  const [knownContact, relationship] = await Promise.all([
    usePersonTreatment && sender.senderAddress
      ? isKnownContact(selected.userId, sender.senderAddress).catch(() => false)
      : Promise.resolve(false),
    resolveSenderRelationship({
      userId: selected.userId,
      senderAddress: sender.senderAddress,
      isHumanSender: usePersonTreatment,
    }).catch(() => ({ descriptor: null, isColdContact: false })),
  ]);
  const meta = ctxData.document.metadata;
  const labelIds = meta.labelIds ?? [];
  const signalText = [
    meta.from,
    meta.to,
    meta.cc,
    meta.snippet,
    ctxData.document.title,
    ctxData.document.content,
    ...labelIds,
  ]
    .filter(Boolean)
    .join("\n");
  const observations = assembleObservations({
    senderKey,
    senderPrior,
    persona: ctxData.persona,
    thread,
    knownContact,
    senderRelationship: relationship.descriptor,
    senderRelationshipIsCold: relationship.isColdContact,
    senderKind,
    labelIds,
    signalText,
  });

  try {
    const { classification } = await classifyEmail({
      userId: selected.userId,
      document: {
        id: ctxData.document.id,
        title: ctxData.document.title,
        content: ctxData.document.content,
        authoredAt: ctxData.document.authoredAt,
        metadata: ctxData.document.metadata,
      },
      senderContext: sender.context,
      observations,
      identity: ctxData.identity,
      maxRetries: 1,
      hedgeDelayMs: 0,
    });
    const rationale = classification.rationale.trim();
    return {
      documentId,
      caseKey,
      category: classification.category,
      collabActivity: classification.collabActivity ?? null,
      todoOutcome: classification.todoDecision?.outcome ?? null,
      wouldProposeTodo:
        classification.todoDecision?.outcome === "proposed" &&
        classification.todoSuggestion != null,
      rationaleHash: createHash("sha256").update(rationale).digest("hex"),
      rationaleLength: rationale.length,
      error: false,
    };
  } catch {
    return failedResult(documentId, caseKey);
  }
}

function failedResult(documentId: string, caseKey: string): ReplayResult {
  return {
    documentId,
    caseKey,
    category: null,
    collabActivity: null,
    todoOutcome: null,
    wouldProposeTodo: false,
    rationaleHash: null,
    rationaleLength: null,
    error: true,
  };
}

async function snapshot(args: readonly string[]): Promise<void> {
  const options = snapshotOptions(args);
  const classifyEmail = await loadClassifier(options.classifierPath);
  const documentIds = await selectDocumentIds(options);
  const results: ReplayResult[] = [];
  for (const [index, documentId] of documentIds.entries()) {
    const result = await replayDocument(documentId, classifyEmail);
    results.push(result);
    console.log(
      `${index + 1}/${documentIds.length} ${result.caseKey} ${result.error ? "ERROR" : "ok"}`,
    );
  }
  const output: ReplaySnapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    classifier: options.classifierPath ?? "current",
    results,
  };
  await writeFile(options.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`wrote ${results.length} content-free result(s) to ${options.outputPath}`);
}

function changedFields(baseline: ReplayResult, candidate: ReplayResult): string[] {
  const fields: string[] = [];
  if (baseline.category !== candidate.category) fields.push("category");
  if (baseline.collabActivity !== candidate.collabActivity) fields.push("collabActivity");
  if (baseline.todoOutcome !== candidate.todoOutcome) fields.push("todoOutcome");
  if (baseline.wouldProposeTodo !== candidate.wouldProposeTodo) fields.push("wouldProposeTodo");
  if (baseline.rationaleHash !== candidate.rationaleHash) fields.push("rationaleHash");
  if (baseline.rationaleLength !== candidate.rationaleLength) fields.push("rationaleLength");
  if (baseline.error !== candidate.error) fields.push("error");
  return fields;
}

function structuredFieldsChanged(baseline: ReplayResult, candidate: ReplayResult): string[] {
  return changedFields(baseline, candidate).filter(
    (field) => field !== "rationaleHash" && field !== "rationaleLength",
  );
}

async function compare(args: readonly string[]): Promise<void> {
  const [baselinePath, candidatePath] = args;
  if (!baselinePath || !candidatePath) {
    throw new Error("compare requires <baseline.json> <candidate.json>");
  }
  const [baseline, candidate] = await Promise.all([
    readSnapshot(baselinePath),
    readSnapshot(candidatePath),
  ]);
  const candidateByKey = new Map(candidate.results.map((result) => [result.caseKey, result]));
  let structuredChanged = 0;
  let rationaleChanged = 0;
  let missing = 0;
  let errors = 0;
  for (const base of baseline.results) {
    const next = candidateByKey.get(base.caseKey);
    if (!next) {
      missing++;
      console.log(`${base.caseKey} missing from candidate`);
      continue;
    }
    if (base.error || next.error) errors++;
    const structuredFields = structuredFieldsChanged(base, next);
    if (structuredFields.length > 0) {
      structuredChanged++;
      console.log(`${base.caseKey} structured change: ${structuredFields.join(", ")}`);
    }
    if (
      base.rationaleHash !== next.rationaleHash ||
      base.rationaleLength !== next.rationaleLength
    ) {
      rationaleChanged++;
    }
  }
  console.log(
    `summary: ${baseline.results.length} paired, ${structuredChanged} structured change(s), ` +
      `${rationaleChanged} rationale change(s), ${missing} missing, ${errors} error pair(s)`,
  );
  if (missing > 0 || errors > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "snapshot") return snapshot(args);
  if (command === "compare") return compare(args);
  throw new Error("usage: triage-prompt-replay.ts snapshot|compare ...");
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error: unknown) => {
    console.error(toMessage(error));
    process.exit(1);
  });
