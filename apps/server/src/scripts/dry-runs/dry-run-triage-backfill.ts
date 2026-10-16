/**
 * Read-only: re-classify the source email of every agent todo with the current
 * prompt, and print KILL (the todo would not be minted now) or KEEP with the new
 * title and category. Writes no todo or triage state, but each classify logs an
 * `api_call_log` cost row.
 *
 * The todo decision replays a live reply re-eval run (`reason: "reply"`, `force`):
 * the thread's newest inbound document, the whole-thread closure read, the
 * `block_todo_suggestion` standing instruction, the structural gate and the
 * `actionItems` flag, in the order and with the read-failure policy of
 * `runEmailTriageClassify` (`packages/assistant/src/triage/workflow-operations.ts`).
 *
 * Run:  pnpm --filter server tsx --env-file=.env src/scripts/dry-runs/dry-run-triage-backfill.ts
 */
import { senderSuppressions } from "@alfred/assistant/knowledge";
import { resolveFeatureFlags, resolveTimezone } from "@alfred/assistant/settings";
import {
  classifyEmail,
  extractSenderContext,
  gatherObservations,
  loadTriageContext,
  readGmailThreadClosure,
  resolveTodoSuggestion,
  todoSuppressionReason,
} from "@alfred/assistant/triage";
import { notSentGmailDocumentWhere } from "@alfred/assistant/triage/sent-mail";
import { userRepliedAfterMessage } from "@alfred/assistant/triage/thread-state";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, todos, user as userTable } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";

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
      ? // SAFETY: todos.sources holds { provider, kind, id } entries.
        (t.sources as Array<{ provider: string; kind: string; id: string }>).find(
          (s) => s.provider === "gmail" && s.kind === "thread",
        )
      : undefined;

    const header = `[${t.email}] "${t.name}" (${t.status})`;

    if (!src) {
      console.log(`? ${header}\n    no gmail-thread source — skipped\n`);
      unresolved++;
      continue;
    }

    // Thread id to its newest inbound document. Prod never triages sent mail, and
    // a reply re-eval re-keys on the newest inbound document.
    const docRow = (
      await db()
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.userId, t.userId),
            eq(documents.sourceThreadId, src.id),
            eq(documents.source, "gmail"),
            notSentGmailDocumentWhere(),
          ),
        )
        .orderBy(desc(documents.authoredAt))
        .limit(1)
    )[0];

    if (!docRow) {
      console.log(
        `? ${header}\n    source thread ${src.id} has no local inbound document — skipped\n`,
      );
      unresolved++;
      continue;
    }

    // Prod skips the run before any model cost when both flags are off.
    const flags = await resolveFeatureFlags(t.userId);

    if (!flags.emailTagging && !flags.actionItems) {
      killed++;
      console.log(`✗ KILL ${header}\n    → triage-disabled (tagging + action-items off)\n`);
      continue;
    }

    const ctxData = await loadTriageContext(docRow.id, t.userId);

    if (!ctxData) {
      console.log(`? ${header}\n    document gone — skipped\n`);
      unresolved++;
      continue;
    }

    const scResult = extractSenderContext({
      fromHeader: ctxData.document.metadata.from ?? null,
      subject: ctxData.document.title,
      body: ctxData.document.content,
    });

    const senderContext = scResult.context;

    const observations = await gatherObservations({
      userId: t.userId,
      documentId: docRow.id,
      sourceThreadId: src.id,
      document: ctxData.document,
      accountId: ctxData.document.accountId,
      persona: ctxData.persona,
      senderContext,
      senderAddress: scResult.senderAddress,
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

    // Like prod: keep only what `resolveTodoSuggestion` and the structural suppressor keep.
    const resolved = resolveTodoSuggestion(
      classification,
      ctxData.document.authoredAt
        ? { sentAt: ctxData.document.authoredAt, timezone: await resolveTimezone(t.userId) }
        : null,
    );

    // Like prod's reply run: read the whole thread. A failed read fails open, so
    // the todo stays mintable.
    let documentRepliedAfter = false;
    let closureNote = "";

    try {
      const closure = await readGmailThreadClosure({ userId: t.userId, sourceThreadId: src.id });
      documentRepliedAfter = userRepliedAfterMessage(
        closure.lastUserReplyAt,
        ctxData.document.authoredAt,
      );
    } catch (err) {
      closureNote = ` | closure read failed (treated as not-replied): ${toMessage(err)}`;
    }

    // Like prod: read the standing instruction only for a proposed todo. A failed
    // read fails closed and suppresses the todo.
    let standingSuppression: string | null = null;

    if (resolved) {
      const suppressions = await senderSuppressions({
        userId: t.userId,
        onReadFailure: "report",
      });

      const outcome = suppressions.match(
        {
          sender: scResult.senderAddress ?? ctxData.document.metadata.from ?? null,
          accountId: ctxData.document.accountId,
        },
        "block_todo_suggestion",
      );

      if (outcome.kind === "suppressed") {
        standingSuppression =
          `standing_instruction effect=${outcome.match.effect} ` +
          `fact=${outcome.match.factId} sender=${outcome.match.matchedEmail}`;
      }

      if (outcome.kind === "read_failed") {
        standingSuppression = `standing_instruction_read_failed: ${toMessage(outcome.error)}`;
      }
    }

    const suppression = resolved
      ? todoSuppressionReason({
          sender: ctxData.document.metadata.from ?? null,
          subject: ctxData.document.title,
          // The text prod's todo gate reads, not the wider classify signal text.
          signalText: [
            ctxData.document.title,
            ctxData.document.content,
            ctxData.document.metadata.snippet ?? null,
          ]
            .filter(Boolean)
            .join("\n"),
          collabActivity: classification.collabActivity ?? null,
          category: classification.category,
          isColdContact: observations.senderRelationshipIsCold,
          userRepliedAfterMessage: documentRepliedAfter,
        })
      : null;

    // Prod's precedence: standing instruction, its read failure, the structural
    // gate, then the action-items flag.
    let killReason: string | null = null;

    if (!resolved) killReason = `${decision}${note}`;
    else if (standingSuppression) killReason = `suppressed: ${standingSuppression}`;
    else if (suppression) killReason = `suppressed: ${suppression}`;
    else if (!flags.actionItems) killReason = "action-items flag off";

    if (resolved && killReason == null) {
      kept++;
      console.log(
        `✓ KEEP ${header}\n    → cat=${cat} | ${author} | new title: "${resolved.name}"${closureNote}\n`,
      );
    } else {
      killed++;
      console.log(`✗ KILL ${header}\n    → cat=${cat} | ${author} | ${killReason}${closureNote}\n`);
    }
  }

  console.log(
    `\n# Summary: ${kept} kept, ${killed} killed, ${unresolved} unresolved (no local source)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exit(1);
  });
