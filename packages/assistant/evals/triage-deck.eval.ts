import path from "node:path";
import {
  parseGmailDocumentMetadata,
  readStoredStandingInstruction,
  type TriageCategory,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import type { ClassifyEmailArgs } from "@alfred/assistant/triage/classify";
import {
  standingInstructionsOf,
  type ActiveStandingInstruction,
} from "@alfred/assistant/knowledge/standing-instructions";
import { assembleObservations } from "@alfred/assistant/triage/observations";
import { extractSenderContext } from "@alfred/assistant/triage/sender-context";
import { DECK, type DeckCase, type DeckMail } from "./triage-deck/cases";
import { PROD_INSTRUCTION_ROWS } from "./triage-deck/instructions";
import { evalMailFacts } from "./lib/stored-mail";
import { classifyWithRetry, isEmptyOutput, isTransientOverload } from "./lib/triage-classify-retry";

/**
 * The ADR-0121 eval deck (`docs/plans/triage-theory-v1.md`, slice 0). It runs the real
 * `classifyEmail` on production mail with the input that prod gave it, and scores the label
 * against `docs/theory/triage.md`. Each later slice runs it before and after, and lands only
 * when no case gets worse. Run it alone:
 * `pnpm --filter @alfred/assistant exec evalite run triage-deck`.
 */

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

const USER = { name: "Yash", email: "yash@example.com" };

/**
 * Prod sends the newest cold-start research line. The repo is public, so the deck sends a
 * short line with the same kind of facts. Slice 4 replaces it with the triage profile.
 */
const USER_CONTEXT = {
  text: "Yash is a software engineer in India. He builds Alfred, a personal assistant, and other side projects on GitHub. He holds a small, passive stock portfolio.",
  recordedAt: new Date("2026-09-01T00:00:00Z"),
};

/** The prod instruction set. A row that does not parse is a deck fault, so it throws at load. */
const INSTRUCTIONS = standingInstructionsOf(
  PROD_INSTRUCTION_ROWS.map((row): ActiveStandingInstruction => {
    const value = readStoredStandingInstruction(row.value, row.factId);

    if (!value) throw new Error(`[triage-deck] instruction ${row.factId} does not parse`);

    return { factId: row.factId, value, validFrom: new Date(row.validFrom) };
  }),
);

function argsFor(c: DeckCase, mail: DeckMail, index: number): ClassifyEmailArgs {
  const sender = extractSenderContext({
    fromHeader: mail.from,
    subject: mail.subject,
    body: mail.body,
  }).context;

  const observations = assembleObservations({
    senderKey: mail.senderPrior?.key ?? null,
    senderPrior: mail.senderPrior
      ? { categoryCounts: mail.senderPrior.counts, lastCategory: null }
      : null,
    persona: "personal",
    thread: {
      lastUserReplyAt: null,
      newestDirection: mail.thread?.newestDirection ?? null,
      messageCount: mail.thread?.messageCount ?? 0,
      recentMessages: [],
    },
    knownContact: mail.knownContact ?? false,
    senderRelationship: mail.senderRelationship ?? null,
    senderKind: mail.senderKind
      ? {
          ...mail.senderKind,
          evidenceCodes: [...mail.senderKind.evidenceCodes],
          entityId: `ent_${c.label}`,
          displayName: mail.from,
        }
      : null,
    standingInstructions: INSTRUCTIONS.forMail({ sender: mail.from, accountId: null }),
    userContext: USER_CONTEXT,
    labelIds: mail.labelIds,
    mailFacts: evalMailFacts({
      from: mail.from,
      to: USER.email,
      labelIds: mail.labelIds,
      headers: mail.headers,
    }),
    signalText: [mail.from, mail.subject, mail.body, ...mail.labelIds].join("\n"),
  });

  return {
    identity: USER,
    // Prod runs with action items off, and the theory moves todos out of triage (slice 7).
    proposeTodo: false,
    document: {
      id: `deck_${c.label}_${index}`,
      title: mail.subject,
      content: mail.body,
      authoredAt: new Date(mail.authoredAt),
      metadata: parseGmailDocumentMetadata({
        from: mail.from,
        snippet: mail.body.slice(0, 160),
        labelIds: [...mail.labelIds],
      }),
    },
    senderContext: sender,
    observations,
    maxRetries: 1,
    hedgeDelayMs: 0,
  };
}

interface MailResult {
  subject: string;
  prodCategory: TriageCategory;
  /** Null when the provider failed every attempt. */
  category: TriageCategory | null;
  model: string;
  rationale: string;
}

interface TaskOutput {
  mails: MailResult[];
}

evalite<DeckCase, TaskOutput, DeckCase>("Triage deck (ADR-0121)", {
  data: () => DECK.map((c) => ({ input: c, expected: c })),
  task: async (input) => {
    serverEnv();
    const mails: MailResult[] = [];

    for (const [index, mail] of input.mails.entries()) {
      try {
        const { classification, model } = await classifyWithRetry(argsFor(input, mail, index));

        mails.push({
          subject: mail.subject,
          prodCategory: mail.prodCategory,
          category: classification.category,
          model,
          rationale: classification.rationale,
        });
      } catch (err) {
        // Never throw: a throw aborts the file and hangs the evalite reporter.
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

        const kind =
          isTransientOverload(err) || isEmptyOutput(err) ? "provider overload" : "classify error";

        console.warn(`[triage-deck] SKIP "${input.label}" #${index}: ${kind}: ${reason}`);

        mails.push({
          subject: mail.subject,
          prodCategory: mail.prodCategory,
          category: null,
          model: "(not classified)",
          rationale: `[skipped: ${kind}]`,
        });
      }
    }

    return { mails };
  },
  scorers: [
    {
      // The share of mails whose label is in the accept set. A skip counts as a miss.
      name: "Label",
      scorer: ({ output, expected }) => {
        const lines = output.mails.map((m) => {
          const ok = m.category !== null && expected.accept.includes(m.category);

          return {
            ok,
            line: `${ok ? "ok  " : "MISS"} ${m.category ?? "skipped"} (prod ${m.prodCategory}) via ${m.model}: ${m.subject}`,
          };
        });

        const hits = lines.filter((l) => l.ok).length;

        return {
          score: hits / lines.length,
          metadata: [
            `want ${expected.accept.join("/")}`,
            ...lines.map((l) => l.line),
            `why: ${expected.note}`,
          ].join("\n"),
        };
      },
    },
    {
      // The theory's consistency check: the same kind of mail from one sender keeps one label.
      name: "One label for the group",
      scorer: ({ output, expected }) => {
        if (!expected.oneKind) return { score: 1, metadata: "not one kind from one sender" };

        const labels = new Set(output.mails.map((m) => m.category ?? "skipped"));

        return {
          score: labels.size === 1 ? 1 : 0,
          metadata: `labels: ${[...labels].join(", ")}`,
        };
      },
    },
  ],
  trialCount: 1,
});
