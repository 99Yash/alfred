/**
 * Read-only: re-classify the source email of every agent todo with the current
 * prompt, and print KILL (the todo would not be minted now) or KEEP with the new
 * title and category. Writes no todo or triage state, but each classify logs an
 * `api_call_log` cost row.
 *
 * Run:  pnpm --filter server tsx --env-file=.env src/scripts/dry-runs/dry-run-triage-backfill.ts
 */
import {
  classifyEmail,
  extractSenderContext,
  gatherObservations,
  loadTriageContext,
  resolveTodoSuggestion,
  todoSuppressionReason,
} from "@alfred/assistant/triage";
import { resolveTimezone } from "@alfred/assistant/settings";
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

    // thread id to its newest document
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
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exit(1);
  });
