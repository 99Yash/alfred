/**
 * Read-only: re-classify the source email of every agent todo with the current
 * prompt, and print KILL (the todo would not be minted now) or KEEP with the new
 * title and category. Writes no todo or triage state, but each classify logs an
 * `api_call_log` cost row.
 *
 * The todo decision replays a live reply re-eval run (`reason: "reply"`, `force`)
 * on the thread's newest inbound document. It calls `decideTriageTodo`, the
 * function the live classify step calls, so the reads, their order, their
 * read-failure policy and the precedence are the live ones.
 *
 * Run:  pnpm --filter server tsx --env-file=.env src/scripts/dry-runs/dry-run-triage-backfill.ts
 */
import { settings } from "@alfred/assistant/settings";
import {
  classifyEmail,
  decideTriageTodo,
  extractSenderContext,
  gatherObservations,
  loadTriageContext,
  type TriageTodoDecision,
} from "@alfred/assistant/triage";
import { notSentGmailDocumentWhere } from "@alfred/assistant/triage/sent-mail";
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

    // One bind per thread, like the live classify step. Prod skips the run before any
    // model cost when both flags are off.
    const userSettings = settings({ userId: t.userId });
    const flags = await userSettings.flags();

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
      settings: userSettings,
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

    // A live reply run on a fresh classify row. Its cold-contact input is the
    // gathered observation, as on the live non-reuse path.
    const { outcome, closure } = await decideTriageTodo({
      userId: t.userId,
      settings: userSettings,
      sourceThreadId: src.id,
      reason: "reply",
      classification,
      document: ctxData.document,
      senderAddress: scResult.senderAddress,
      isColdContact: observations.senderRelationshipIsCold,
      actionItemsEnabled: flags.actionItems,
    });

    const closureNote =
      closure.kind === "read_failed"
        ? ` | closure read failed (treated as not-replied): ${toMessage(closure.error)}`
        : "";

    if (outcome.kind === "mint") {
      kept++;
      console.log(
        `✓ KEEP ${header}\n    → cat=${cat} | ${author} | new title: "${outcome.todo.name}"${closureNote}\n`,
      );
    } else {
      killed++;
      console.log(
        `✗ KILL ${header}\n    → cat=${cat} | ${author} | ${killReason(outcome, `${decision}${note}`)}${closureNote}\n`,
      );
    }
  }

  console.log(
    `\n# Summary: ${kept} kept, ${killed} killed, ${unresolved} unresolved (no local source)`,
  );
}

function killReason(
  outcome: Exclude<TriageTodoDecision["outcome"], { kind: "mint" }>,
  modelDecision: string,
): string {
  if (outcome.kind === "none") return modelDecision;

  const { suppression } = outcome;

  switch (suppression.kind) {
    case "standing_instruction":
      return (
        `suppressed: standing_instruction effect=${suppression.match.effect} ` +
        `fact=${suppression.match.factId} sender=${suppression.match.matchedEmail}`
      );
    case "standing_instruction_read_failed":
      return `suppressed: standing_instruction_read_failed: ${toMessage(suppression.error)}`;
    case "gate":
      return `suppressed: ${suppression.reason}`;
    case "action_items_off":
      return "action-items flag off";
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exit(1);
  });
