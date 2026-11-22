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
  instructionsInWordsOf,
  type InstructionsInWordsRead,
} from "@alfred/assistant/knowledge/instructions-in-words";
import type { ActiveStandingInstruction } from "@alfred/assistant/knowledge/standing-instructions";
import { assembleObservations } from "@alfred/assistant/triage/observations";
import { triageOutOfScope, type TriageOutOfScope } from "@alfred/assistant/triage/scope";
import { DECK, type DeckCase, type DeckMail } from "./triage-deck/cases";
import { PROD_INSTRUCTION_ROWS } from "./triage-deck/instructions";
import type { MailFacts } from "@alfred/assistant/knowledge/mail-facts";
import { evalMailFacts } from "./lib/stored-mail";
import {
  classifyFailureOf,
  classifyWithRetry,
  type ClassifyFailure,
  type ClassifyFailureKind,
} from "./lib/triage-classify-retry";

/**
 * The ADR-0121 eval deck (`docs/plans/triage-theory-v1.md`, slice 0). It runs the real
 * `classifyEmail` on production mail with the input that prod gave it, and scores the label
 * against `docs/theory/triage.md`. Each later slice runs it before and after, and lands only
 * when no case gets worse. `Coverage` and `Provider failures` sit next to `Label`, so a
 * provider outage reads as weather, not as a model regression. `Classify failures` counts the
 * answers that the schema refused: a fault, never weather. A case with no verdict scores 0 on
 * `Label`, because it proves nothing. Each case runs three times,
 * and the runner reports each trial on its own: a case regressed only when every trial
 * misses it. Run it alone:
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

/**
 * The prod instruction set in words, as prod reads it (slice 4a): every mail gets the same list.
 * A row that does not parse is a deck fault, so it throws at load.
 */
const INSTRUCTIONS: InstructionsInWordsRead = {
  kind: "loaded",
  instructions: instructionsInWordsOf(
    PROD_INSTRUCTION_ROWS.map((row): ActiveStandingInstruction => {
      const value = readStoredStandingInstruction(row.value, row.factId);

      if (!value) throw new Error(`[triage-deck] instruction ${row.factId} does not parse`);

      return { factId: row.factId, value, validFrom: new Date(row.validFrom) };
    }),
  ),
};

/**
 * `DECK_CASES=label1,label2` runs only those cases, to test a change narrowly. Unset runs the
 * whole deck; a label that matches no case throws, so a typo cannot pass as a clean run.
 */
const DECK_RUN = deckRun(process.env["DECK_CASES"]); // drift-ok: an operator filter for a local eval run, not app config

function deckRun(filter: string | undefined): readonly DeckCase[] {
  if (!filter) return DECK;

  const labels = new Set(filter.split(",").map((label) => label.trim()));
  const unknown = [...labels].filter((label) => !DECK.some((c) => c.label === label));

  if (unknown.length > 0) throw new Error(`[triage-deck] no case: ${unknown.join(", ")}`);

  return DECK.filter((c) => labels.has(c.label));
}

/** A control case names a case of the deck. A name that matches no case is a deck fault. */
for (const c of DECK) {
  if (c.controlOf !== undefined && !DECK.some((other) => other.label === c.controlOf)) {
    throw new Error(`[triage-deck] ${c.label} is the control of no case: ${c.controlOf}`);
  }
}

/** The read of a user who has no standing instruction. */
const NO_INSTRUCTIONS: InstructionsInWordsRead = { kind: "loaded", instructions: [] };

/**
 * `DECK_INSTRUCTIONS=none` sends no standing instruction with any mail of the run, to see what
 * the words change: run the same cases with it and without it. Unset sends the prod set.
 */
const DECK_INSTRUCTIONS = deckInstructions(process.env["DECK_INSTRUCTIONS"]); // drift-ok: an operator switch for a local eval run, not app config

function deckInstructions(value: string | undefined): "prod" | "none" {
  if (value === undefined || value === "") return "prod";

  if (value === "none") return "none";

  throw new Error(`[triage-deck] DECK_INSTRUCTIONS must be "none" or unset, not "${value}"`);
}

/** A control case and a run with `DECK_INSTRUCTIONS=none` get no instruction. */
function instructionsFor(c: DeckCase): InstructionsInWordsRead {
  return c.controlOf !== undefined || DECK_INSTRUCTIONS === "none" ? NO_INSTRUCTIONS : INSTRUCTIONS;
}

function deckMailId(c: DeckCase, index: number): string {
  return `deck_${c.label}_${index}`;
}

/** Every mail fact comes from the prod reader over a stored Gmail message. */
function deckMailFacts(c: DeckCase, mail: DeckMail, index: number): MailFacts {
  return evalMailFacts({
    id: deckMailId(c, index),
    from: mail.from,
    subject: mail.subject,
    body: mail.body,
    authoredAt: new Date(mail.authoredAt),
    labelIds: mail.labelIds,
    headers: mail.headers,
    history: mail.history,
    ownReplies: mail.ownReplies?.map((reply) => ({ at: new Date(reply.at), text: reply.text })),
  });
}

function argsFor(
  c: DeckCase,
  mail: DeckMail,
  index: number,
  mailFacts: MailFacts,
): ClassifyEmailArgs {
  const id = deckMailId(c, index);

  const observations = assembleObservations({
    persona: "personal",
    thread: {
      lastUserReplyAt: mail.thread?.lastUserReplyAt ? new Date(mail.thread.lastUserReplyAt) : null,
      newestDirection: mail.thread?.newestDirection ?? null,
      messageCount: mail.thread?.messageCount ?? 0,
      recentMessages: (mail.thread?.recentMessages ?? []).map((message) => ({
        direction: message.direction,
        authoredAt: new Date(message.authoredAt),
        snippet: message.snippet,
      })),
    },
    standingInstructions: instructionsFor(c),
    userContext: USER_CONTEXT,
    labelIds: mailFacts.labelIds,
    signalText: [mail.from, mail.subject, mail.body, ...mail.labelIds].join("\n"),
  });

  return {
    identity: USER,
    // The floors read this row; the prompt reads `mailFacts`.
    document: {
      id,
      title: mail.subject,
      content: mail.body,
      authoredAt: new Date(mail.authoredAt),
      metadata: parseGmailDocumentMetadata({
        from: mail.from,
        snippet: mail.body.slice(0, 160),
        labelIds: [...mail.labelIds],
      }),
    },
    mailFacts,
    observations,
    maxRetries: 1,
    hedgeDelayMs: 0,
  };
}

interface MailResult {
  subject: string;
  prodCategory: TriageCategory;
  /** Null when every attempt failed (see `failure`), or when triage skipped the mail. */
  category: TriageCategory | null;
  /** The case's scope for the mail and the scope that `triageOutOfScope` gave. */
  scope: { expected: TriageOutOfScope | null; actual: TriageOutOfScope | null };
  model: string;
  rationale: string;
  /** Why the mail got no label. Null when it got a verdict. */
  failure: ClassifyFailure | null;
}

/** A mail with a verdict: the scope skipped it before a call, or the model gave a label. */
function hasVerdict(m: MailResult): boolean {
  return m.scope.actual !== null || m.category !== null;
}

/** The mail's result as the scorers print it: the skip, the label, or the failure kind. */
function resultOf(m: MailResult): string {
  if (m.scope.actual) return `skip (${m.scope.actual})`;

  return m.category ?? `failed (${m.failure?.kind ?? "error"})`;
}

/** Provider weather: the provider was out of capacity, or sent nothing back. */
const WEATHER: readonly ClassifyFailureKind[] = ["capacity", "no_output"];

function failedWith(output: TaskOutput, kinds: readonly ClassifyFailureKind[]): MailResult[] {
  return output.mails.filter((m) => m.failure !== null && kinds.includes(m.failure.kind));
}

interface TaskOutput {
  mails: MailResult[];
}

evalite<DeckCase, TaskOutput, DeckCase>("Triage deck (ADR-0121)", {
  data: () => DECK_RUN.map((c) => ({ input: c, expected: c })),
  task: async (input) => {
    serverEnv();
    const mails: MailResult[] = [];

    for (const [index, mail] of input.mails.entries()) {
      const mailFacts = deckMailFacts(input, mail, index);
      const scope = { expected: mail.outOfScope ?? null, actual: triageOutOfScope(mailFacts) };

      // Slice 2a: triage skips the mail before any model call, as the classify step does.
      if (scope.actual !== null) {
        mails.push({
          subject: mail.subject,
          prodCategory: mail.prodCategory,
          category: null,
          scope,
          model: "(skipped: out of scope)",
          rationale: "",
          failure: null,
        });
        continue;
      }

      try {
        const { classification, model } = await classifyWithRetry(
          argsFor(input, mail, index, mailFacts),
        );

        mails.push({
          subject: mail.subject,
          prodCategory: mail.prodCategory,
          category: classification.category,
          scope,
          model,
          rationale: classification.rationale,
          failure: null,
        });
      } catch (err) {
        // Never throw: a throw aborts the file and hangs the evalite reporter.
        const failure = classifyFailureOf(err);

        console.warn(
          `[triage-deck] FAILED "${input.label}" #${index}: ${failure.kind}: ${failure.detail}`,
        );

        mails.push({
          subject: mail.subject,
          prodCategory: mail.prodCategory,
          category: null,
          scope,
          model: "(not classified)",
          rationale: `[failed: ${failure.kind}]`,
          failure,
        });
      }
    }

    return { mails };
  },
  scorers: [
    {
      // The share of mails that got any verdict: a scope skip, or a model label. A
      // provider failure is not a verdict, so an outage reads here first.
      name: "Coverage",
      scorer: ({ output }) => {
        const verdicts = output.mails.filter(hasVerdict).length;

        return {
          score: output.mails.length === 0 ? 1 : verdicts / output.mails.length,
          metadata: `${verdicts}/${output.mails.length} mails got a verdict (a skip counts)`,
        };
      },
    },
    {
      // The count of mails whose every attempt failed for provider weather: no capacity,
      // or nothing came back. The score is a count, not a share. An outage reads here,
      // not as a model regression.
      name: "Provider failures",
      scorer: ({ output }) => {
        const failed = failedWith(output, WEATHER);

        return {
          score: failed.length,
          metadata:
            failed.length === 0
              ? "no provider failures"
              : failed.map((m) => `${resultOf(m)}: ${m.subject}`).join("\n"),
        };
      },
    },
    {
      // The count of mails whose every attempt failed for a reason that is not weather:
      // the schema refused the model's answer, or the call threw. The score is a count.
      // This is a fault to fix, so it never reads as weather.
      name: "Classify failures",
      scorer: ({ output }) => {
        const failed = failedWith(output, ["schema_rejection", "error"]);

        return {
          score: failed.length,
          metadata:
            failed.length === 0
              ? "no classify failures"
              : failed.map((m) => `${resultOf(m)}: ${m.subject}\n${m.failure?.detail}`).join("\n"),
        };
      },
    },
    {
      // The label accuracy over the mails that got a verdict only. A skip where the
      // case expects one is correct (slice 2a). A failed mail is out of the score; a
      // case with no verdict at all scores 0, because it proves nothing. Each trial
      // scores on its own, so a case regressed only when every trial misses it; one
      // miss in one trial is run-to-run variance.
      name: "Label",
      scorer: ({ output, expected }) => {
        const scored = output.mails.filter(hasVerdict);

        if (scored.length === 0) {
          return {
            score: 0,
            metadata: `no coverage: no mail got a verdict, so the case proves nothing (${output.mails.map(resultOf).join(", ")}); read Provider failures and Classify failures`,
          };
        }

        const lines = scored.map((m) => {
          const ok =
            m.scope.expected !== null
              ? m.scope.actual === m.scope.expected
              : m.scope.actual === null &&
                m.category !== null &&
                expected.accept.includes(m.category);

          const result = resultOf(m);

          const want = m.scope.expected ? ` want skip (${m.scope.expected})` : "";

          return {
            ok,
            line: `${ok ? "ok  " : "MISS"} ${result}${want} (prod ${m.prodCategory}) via ${m.model}: ${m.subject}`,
          };
        });

        const hits = lines.filter((l) => l.ok).length;

        return {
          score: hits / scored.length,
          metadata: [
            `want ${expected.accept.join("/")}`,
            `hit ${hits}/${scored.length} scored mails (of ${output.mails.length} mails)`,
            ...lines.map((l) => l.line),
            `why: ${expected.note}`,
          ].join("\n"),
        };
      },
    },
    {
      // The theory's consistency check: the same kind of mail from one sender keeps one
      // label. Only verdict mails are in the group; a provider failure is not a label.
      name: "One label for the group",
      scorer: ({ output, expected }) => {
        if (!expected.oneKind) return { score: 1, metadata: "not one kind from one sender" };

        const verdicts = output.mails.filter(hasVerdict);

        if (verdicts.length === 0) {
          return { score: 0, metadata: "no coverage: no verdict, so no group to check" };
        }

        const labels = new Set(verdicts.map(resultOf));

        return {
          score: labels.size === 1 ? 1 : 0,
          metadata: `labels: ${[...labels].join(", ")}`,
        };
      },
    },
  ],
  // Three trials of each case, because one classify call is not stable near a label
  // boundary (the 2026-11-07 baselines: 67% and 70% on the same deck). The runner
  // scores each trial on its own and reports one result per trial, so read a case
  // across its trials: a case regressed only when every trial misses it.
  trialCount: 3,
});
