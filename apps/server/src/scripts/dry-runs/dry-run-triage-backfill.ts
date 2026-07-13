/**
 * Dry-run triage backfill (ADR-0050/0051 amendment 2026-06-09) — READ-ONLY.
 *
 * Re-classifies the SOURCE EMAIL of every agent-authored todo with the NEW
 * stringency prompt and diffs against the live state, in two buckets:
 *   - KILLS  — a currently-suggested/done agent todo the new bar would drop.
 *   - KEEPS  — still proposed; shows the new (terser) title + category.
 * Plus a category line per row so AGM/ceremonial → fyi flips are visible.
 *
 * Writes NOTHING to `todos` or `email_triage`. (It does emit an `api_call_log`
 * cost row per classify via the metered model call — that's cost attribution,
 * not state under test.)
 *
 * Run:  pnpm --filter server tsx --env-file=.env src/scripts/dry-runs/dry-run-triage-backfill.ts
 */
import {
  assembleObservations,
  classifyEmail,
  extractSenderContext,
  getSenderPrior,
  getThreadState,
  isKnownContact,
  resolveSenderKind,
  resolveSenderRelationship,
  loadTriageContext,
  resolveTodoSuggestion,
  senderKeyFor,
  todoSuppressionReason,
} from "@alfred/api/backend";
import { toStringArray, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, todos, user as userTable } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";

function metaStr(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" ? v : null;
}

async function main() {
  const rows = await db()
    .select({
      id: todos.id,
      userId: todos.userId,
      email: userTable.email,
      status: todos.status,
      name: todos.name,
      sources: todos.sources,
    })
    .from(todos)
    .leftJoin(userTable, eq(userTable.id, todos.userId))
    .where(eq(todos.createdBy, "agent"))
    .orderBy(desc(todos.createdAt));

  console.log(`# Dry-run over ${rows.length} agent todos (READ-ONLY)\n`);
  let killed = 0;
  let kept = 0;
  let unresolved = 0;

  for (const t of rows) {
    const src = Array.isArray(t.sources)
      ? (t.sources as Array<{ provider: string; kind: string; id: string }>).find(
          (s) => s.provider === "gmail" && s.kind === "thread",
        )
      : undefined;
    const header = `[${t.email}] "${t.name}" (${t.status})`;
    if (!src) {
      console.log(`? ${header}\n    no gmail-thread source — skipped\n`);
      unresolved++;
      continue;
    }

    // thread id → newest document for that thread
    const docRow = (
      await db()
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.userId, t.userId),
            eq(documents.sourceThreadId, src.id),
            eq(documents.source, "gmail"),
          ),
        )
        .orderBy(desc(documents.authoredAt))
        .limit(1)
    )[0];
    if (!docRow) {
      console.log(`? ${header}\n    source thread ${src.id} not in local documents — skipped\n`);
      unresolved++;
      continue;
    }

    const ctxData = await loadTriageContext(docRow.id, t.userId);
    if (!ctxData) {
      console.log(`? ${header}\n    document gone — skipped\n`);
      unresolved++;
      continue;
    }

    const scResult = extractSenderContext({
      fromHeader: metaStr(ctxData.document.metadata, "from"),
      subject: ctxData.document.title,
      body: ctxData.document.content,
    });
    const senderContext = scResult.context;
    const senderKey = senderKeyFor(senderContext, scResult.senderAddress);
    const meta = ctxData.document.metadata;
    const labelIds = toStringArray(meta.labelIds);
    const isHumanSender = senderContext.effectiveAuthor === "person";
    const [senderPrior, thread, senderKind] = await Promise.all([
      senderKey ? getSenderPrior(t.userId, senderKey).catch(() => null) : Promise.resolve(null),
      getThreadState({
        userId: t.userId,
        sourceThreadId: src.id,
        excludeDocumentId: docRow.id,
      }).catch(() => ({
        lastUserReplyAt: null,
        newestDirection: null,
        messageCount: 0,
        recentMessages: [],
      })),
      resolveSenderKind(t.userId, scResult.senderAddress),
    ]);
    const usePersonTreatment = isHumanSender && senderKind == null;
    const [knownContact, senderRelationship] = await Promise.all([
      usePersonTreatment && scResult.senderAddress
        ? isKnownContact(t.userId, scResult.senderAddress).catch(() => false)
        : Promise.resolve(false),
      resolveSenderRelationship({
        userId: t.userId,
        senderAddress: scResult.senderAddress,
        isHumanSender: usePersonTreatment,
      }).catch(() => null),
    ]);
    const signalText = [
      metaStr(meta, "from"),
      metaStr(meta, "to"),
      metaStr(meta, "cc"),
      metaStr(meta, "snippet"),
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
      senderRelationship,
      senderKind,
      labelIds,
      signalText,
    });

    let classification;
    try {
      ({ classification } = await classifyEmail({
        userId: t.userId,
        document: {
          id: ctxData.document.id,
          title: ctxData.document.title,
          content: ctxData.document.content,
          authoredAt: ctxData.document.authoredAt,
          metadata: ctxData.document.metadata,
        },
        senderContext,
        observations,
        identity: ctxData.identity,
      }));
    } catch (err) {
      console.log(`! ${header}\n    classify error (skipped): ${toMessage(err)}\n`);
      unresolved++;
      continue;
    }

    const decision = classification.todoDecision?.outcome ?? "(none)";
    const note = classification.todoDecision?.note ? ` — ${classification.todoDecision.note}` : "";
    const cat = classification.category;
    const author = `author=${senderContext.effectiveAuthor}${senderContext.botSlug ? `/${senderContext.botSlug}` : ""}`;
    // Mirror production: the rail only mints what `resolveTodoSuggestion` keeps
    // (proposed outcome + todo-eligible category) AND survives the structural
    // suppressor (GitHub PR-review thread / Alfred's own approval mail).
    const resolved = resolveTodoSuggestion(classification, ctxData.document.authoredAt);
    const suppression = resolved
      ? todoSuppressionReason({
          sender: metaStr(ctxData.document.metadata, "from"),
          subject: ctxData.document.title,
          signalText,
          collabActivity: classification.collabActivity ?? null,
        })
      : null;
    if (resolved && !suppression) {
      kept++;
      console.log(
        `✓ KEEP ${header}\n    → cat=${cat} | ${author} | new title: "${resolved.name}"\n`,
      );
    } else {
      killed++;
      const why = suppression ? `suppressed: ${suppression}` : `${decision}${note}`;
      console.log(`✗ KILL ${header}\n    → cat=${cat} | ${author} | ${why}\n`);
    }
  }

  console.log(
    `\n# Summary: ${kept} kept, ${killed} killed, ${unresolved} unresolved (no local source)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // Log only the message — serializing the full Error can leak DATABASE_URL,
    // query state, and connection credentials into CI / shared-machine logs.
    console.error(toMessage(e));
    process.exit(1);
  });
