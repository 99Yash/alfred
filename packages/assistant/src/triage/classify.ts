import {
  route,
  meteredGenerateObject,
  type LanguageModel,
  type MeteredGenerateObjectArgs,
} from "@alfred/ai";
import {
  TODO_DECISION_OUTCOMES,
  clamp01,
  collabActivitySchema,
  confidenceSchema,
  documentAskProposalSchema,
  sanitizeErrorMessage,
  sanitizeToolResult,
  type GmailDocumentMetadata,
  type TodoDecisionOutcome,
  type TriageInstructionEvaluation,
  type TriageModelVerdict,
  type TriageTodoDecision,
  type TriageTodoSuggestion,
  toMessage,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { NoObjectGeneratedError } from "ai";
import { selfIdentityGrounding } from "@alfred/assistant/settings";
import { TRIAGE_CATEGORIES, type TriageCategory } from "@alfred/integrations/google";
import { z } from "zod";
import type { MailFacts, MailRecipient } from "../knowledge";
import {
  TRIAGE_INSTRUCTION_MATCH_OUTPUT_TOKENS,
  TRIAGE_MAX_OUTPUT_TOKENS,
  TRIAGE_REQUEST_TIMEOUT_MS,
} from "./constants";
import {
  applyFloors,
  applyStandingInstructionEffects,
  matchesExposedSecret,
  type FloorAudits,
  type StandingFloorAudit,
  type StandingInstructionMatch,
} from "./floors";
import { createHedgeBudget, hedgeCeilingFor, runHedged, type HedgeBudget } from "./hedge";
import type { Observations } from "./observations";
import { MAX_RATIONALE_LEN, truncateRationale } from "./rationale";
import {
  buildStandingScopeBlock,
  readStandingScopeMatches,
  triageInstructionMatchOutputSchema,
  type StandingScopeCounter,
} from "./standing-scope";

// Defined in the leaf `rationale.ts` to avoid a `classify ↔ floors` cycle.
export { MAX_RATIONALE_LEN, truncateRationale };

/**
 * Email triage, cheap model always (ADR-0051): one cheap pass, then the
 * deterministic floors. The conflict re-ask (ADR-0051 §4b) is removed: its nets
 * fed the model's own labels back as evidence (theory principle 5).
 */

/** Which rubric test (rule 16) decided the todo call. In contracts so the row can store it. */
export { TODO_DECISION_OUTCOMES, type TodoDecisionOutcome };

/**
 * The classifier's answer (ADR-0121). The todo rubric left in slice 3; slice 7 returns todos
 * as a follow-up workflow with its own prompt. The todo fields below stay on the row type:
 * the standing instruction floor writes `todoDecision`, and stored rows keep them.
 */
export const triageClassificationSchema = z.object({
  category: z.enum(TRIAGE_CATEGORIES),
  /**
   * [0, 1]. Below 0.5 the label still applies but is flagged as "alfred wasn't sure".
   * Bare number because some providers reject numeric bounds; `defaultRunPass` clamps it.
   */
  confidence: confidenceSchema,
  rationale: z.string().min(1).max(MAX_RATIONALE_LEN),
  documentAsk: documentAskProposalSchema.nullable().optional(),
  /**
   * Collaboration-tool activity kind (#218); null for non-tracker mail. Its reader left in
   * slice 3 with the sender-kind floor, so the model no longer answers it on purpose.
   */
  collabActivity: collabActivitySchema.nullable().optional(),
});

const triageClassificationWithMatchesSchema = triageClassificationSchema.extend({
  // Optional, so an omitted list does not fail the parse. Each sent instruction then stays
  // `unknown`. Only an entry with an explicit decision gives a result (`readStandingScopeMatches`).
  instructionMatches: z.array(triageInstructionMatchOutputSchema).optional(),
});

/** Row- and floor-level todo fields. The model never emits them; the schema has no rubric. */
interface TriageRowTodos {
  /** A stored proposal from before the rubric left. New writes are always `null`. */
  todoSuggestion?: TriageTodoSuggestion | null | undefined;
  /** The standing floor or the old rubric wrote it. */
  todoDecision?: TriageTodoDecision | null | undefined;
}

/** A pass's answer, plus the todo fields the row and the floors carry. */
export type TriageClassifierOutput = z.infer<typeof triageClassificationWithMatchesSchema> &
  TriageRowTodos;

export type TriageClassification = TriageClassifierOutput;

/** One cheap-model pass. Tests inject it. */
export type RunPass = (input: {
  system: string;
  prompt: string;
  /** The prompt carries scoped instructions, so the pass asks for `instructionMatches`. */
  withInstructionMatches: boolean;
}) => Promise<TriageClassifierOutput>;

/** A pass plus the model id that served it. An injected pass serves as `injected`. */
type ServedPass = (
  input: Parameters<RunPass>[0],
) => Promise<{ classification: TriageClassifierOutput; modelId: string }>;

/** A served pass, and why its match list failed, if it did. */
interface ClassifyPassResult {
  served: Awaited<ReturnType<ServedPass>>;
  matchFailure: { message: string } | null;
}

export interface ClassifyEmailArgs {
  /** Metering only; never sent to the model. */
  userId?: string;
  /**
   * The only user identity the classifier gets. The "You" block uses it so a task
   * assigned to a named third party is not read as the user's task.
   */
  identity?: { name?: string | null; email?: string | null };
  /** The stored row. The floors read it; the prompt does not. */
  document: {
    id: string;
    title: string | null;
    content: string;
    authoredAt: Date | null;
    metadata: GmailDocumentMetadata;
  };
  /** The prompt's mail input, from the mail-facts reader only. The sender context lives in it. */
  mailFacts: MailFacts;
  /** Deterministic pre-model hints, never verdicts (ADR-0051 §4a). */
  observations: Observations;
  runId?: string;
  stepId?: string;
  idempotencyKey?: string;
  /** The eval lowers retries so a provider blip fails over fast and CI stays in budget. */
  maxRetries?: number;
  /** Hedge delay in ms; `0` disables. Unset reads `TRIAGE_CLASSIFY_HEDGE_MS`. */
  hedgeDelayMs?: number;
  /** Tests inject canned passes here. */
  runPass?: RunPass;
}

/** Why a second cheap pass would have fired (ADR-0051 §4b). The pass is removed. */
export interface TriageConflict {
  kind: "under_classification" | "over_classification" | "loop_state";
  /** Goes into the second-pass prompt and the audit. */
  message: string;
}

/** Stored in the `triage.classification` trace. */
export interface ClassifyAudit {
  firstPass: TriageClassification;
  /**
   * Null always: the conflict re-ask is removed (slice 1). The fields stay so the
   * `triage.classification` trace shape is stable for the stored rows before it.
   */
  conflict: TriageConflict | null;
  secondPass: TriageClassification | null;
  secondPassFailure: { message: string } | null;
  /** Per-floor audits from {@link applyFloors}, keyed by floor name. */
  floors: FloorAudits;
  /** The instruction floor after the system floors (ADR-0113). */
  standing: StandingClassifyAudit;
}

export interface StandingClassifyAudit {
  floor: StandingFloorAudit;
  counter: StandingScopeCounter;
  /**
   * The stored pass's output failed with the match list, so it ran again without it. Every
   * sent instruction is `unknown`. Null when the match list did not fail.
   */
  matchFailure: { message: string } | null;
  /**
   * Sent instructions with no result from the stored pass, so their state is `unknown`: the
   * model left them out or gave no valid decision, or the match list failed.
   */
  undecided: number;
}

/**
/**
 * The system prompt is the theory page (`docs/theory/triage.md`) in prompt form: the job, the
 * labels, precedence, the echoes, and the evidence principles. A past error becomes an eval
 * case, never a new prompt rule. The standing instructions arrive in the email block in
 * Yash's words. The triage profile joins here in slice 4.
 */
export const SYSTEM_PROMPT = `You triage Yash's email. For each email, decide what it costs Yash to ignore it, and answer with one label. Triage does nothing else. Yash reads the labels in the inbox list and never filters by them, so a loud label must be correct, and a quiet label must not attract the eye.

The labels, and what each means:

- urgent (loud): it costs Yash something today.
- action (loud): Yash must do something.
- reply (loud): a person waits for Yash's answer.
- meeting (quiet): a meeting with Yash that specific people arranged. Never a broadcast event.
- receipt (quiet): money moved, and nothing went wrong.
- fyi (quiet): useful to know. Nothing to do.
- done (quiet): the matter is finished. Nothing is left.
- news (quiet): something Yash subscribed to.
- promo (quiet): someone sells something.

Ask the loud question first. If the mail needs Yash, it gets a loud label, whatever kind of mail it is. Only a mail that needs nothing gets a quiet label. This is a hard rule, not a case-by-case judgment.

These cases are decided, not weighed:

- A failed payment, a card that expired, or a service that will stop is action, or urgent when access stops today. It is never receipt.
- A meeting is with Yash, arranged by specific people: confirmed, proposed, or arranged by a scheduling service for Yash and one person. An event with an open audience — a webinar, a seminar, a cohort session, a conference — is never meeting, even when Yash registered for it and the invite sits on his calendar. The other attendees decide, not the calendar object. Webinars, AGMs, e-voting notices, investor calls, and earnings calls are never meeting.
- An upsell is not a bill. Money is owed only on an existing paid relationship: a payment failed, a card declined, an invoice due, a subscription past due. "Upgrade your plan", "your trial is ending", "you hit your free quota" sell something; they are promo or fyi, never action and never urgent, however near their deadline sits — unless the service itself will stop, which is action. An engagement nudge — a game streak, an unread count, "N people viewed your profile" — sells engagement: nothing stops and nobody waits, so it is promo or fyi, never action, however near its deadline sits.
- The vendor's outage is not Yash's outage. A status or incident post for a service Yash only consumes is fyi while it lasts, and done when the same thread resolves it. An alert on Yash's own systems is judged by its real impact; a routine CI or deploy failure on his own projects is fyi, because he already sees it in the pull request.
- A task for someone else is not Yash's task. The "You (the user being triaged)" block says who the user is; the activity body and the thread say who owns the next action. A task created, filed, or opened is the start of work, never done.
- Mail that Yash already answered asks nothing of Yash. When the most recent message in the thread is Yash's own and it answers the ask, the label is done. But a trailing low-signal line — a bot saying "done", an acknowledgement — never buries an earlier open ask: read the thread, and judge what it still needs from Yash.

Echoes of Yash's own actions. A sign-in confirmation, a new-device notice, an OTP mail, and a backup-code mail are usually records of an act Yash did himself. Such a mail is an echo while the facts fit that act:

- An echo is fyi. It is never urgent and never action. Triage usually cannot see whether Yash did the act; that is the not-sure rule.
- An echo is an echo only while the facts fit an act Yash could have done himself: a service he uses, a device and place that fit his pattern, at an hour that fits his week. When the named facts together do not fit — an unfamiliar device in an unfamiliar place at an hour outside his pattern — the facts point to another person, and the loud question applies.
- Weigh the facts together: the service, and the device, place, and app the mail names; the account that got it, work or personal; the arrival time in Yash's zone, against his usual hours; and Yash's own acts near that time, when the evidence shows them.
- When the facts point to another person, the mail is a security notice, not an echo, and the loud question applies as for any other mail.
- No single fact decides a label. An odd hour alone does not make a mail loud. Name the facts that decided it.
- The "if you didn't do this, act immediately" line is boilerplate. It appears identically on a real echo and on a phish, so it carries no information and never raises a label on its own.
- What the mail asserts decides, not what it asks. An alert that names what someone SAW — an unrecognized device, an unfamiliar location, a scanner naming a committed key, a breach naming Yash's credential — carries information Yash does not have, and the loud question applies. The account's own vendor reporting an event on that account (a login link, a code, a password or passkey change, a 2FA or OAuth change) asserts only that an event happened; that is an echo.

When triage is not sure, the label is fyi. fyi never hides a mail and never raises a false alarm.

How to weigh the evidence. The evidence has no fixed rank. These principles decide:

- Yash's own words win over an inference.
- A specific item wins over a general one.
- A newer item wins over an older one. Instructions arrive with their dates, oldest first.
- Alfred's own past labels are never evidence. A system that learns from its own guesses repeats its errors. Judge the mail itself.

The evidence lines in the block below:

- From, To, and Cc mark Yash's own addresses with (you) and known contacts with (known contact). A direct ask from a person Yash corresponds with is more likely a real reply.
- Sender relationship describes the correspondence history with this sender: significance, reciprocity, and what either side is. "No prior contact on record" is a cold sender. reply needs a real person waiting on Yash — someone he corresponds with, or a known contact. Outbound, automated, or bulk cold mail stays quiet, however direct its ask reads.
- Sender kind names a confident non-person classification for the address (a group mailbox or an automated sender) when one exists. Its absence means no opinion. Never infer a person from a display name.
- Account persona frames what urgent and action mean for this account.
- Gmail signals (categories, important, starred) are Gmail's own priors. Weigh them when they agree with the mail.
- Content flags are cheap tells: unsubscribe, currency, security, calendar, investor notice, public event. They focus attention; they do not decide.
- Thread state and the recent messages show what the thread still needs. Classify the whole thread; the newest message rewrites the one label.
- The researched line about Yash is Alfred's own web research, not his words and not this mail. It is the weakest signal. It never decides a category on its own and never outranks the mail body.

Yash's standing instructions arrive in the block in his own words, each with its date, oldest first. Weigh them as evidence. An instruction that names one person is applied by code after you answer; answer the mail on its own merits.

Answer with exactly one label, a confidence, and a rationale. The confidence: 0.9 or above for an unambiguous mail, 0.7 to 0.9 when the category is clear with some overlap, 0.5 to 0.7 for an educated guess, and below 0.5 only when no label fits well. The rationale is one or two sentences grounded in concrete cues: quote the subject or body, and name the decisive evidence line. Never invent contact history, ownership, or relationship strength: call a sender known, strong, two-way, or cold only when the evidence lines say it.`;

function renderThreadObservation(obs: Observations): string[] {
  const lines: string[] = [];
  const t = obs.thread;

  if (t.messageCount > 0) {
    const replied = t.lastUserReplyAt
      ? `you last replied ${t.lastUserReplyAt.toISOString()}`
      : "you have not replied";

    lines.push(
      `Thread: ${t.messageCount} prior message(s); ${replied}; newest is ${t.newestDirection ?? "unknown"}`,
    );

    // Lets a trailing low-signal message see an earlier open ask in the thread.
    if (t.recentMessages.length) {
      lines.push(`Recent thread messages (newest first — the email below may be even newer):`);

      for (const m of t.recentMessages) {
        const who = m.direction === "sent" ? "you sent" : "received";
        lines.push(`  - [${who}] ${m.snippet}`);
      }
    }
  } else {
    lines.push(`Thread: new (no prior messages on file)`);
  }

  return lines;
}

/**
 * Prompt budget for the cold-start prior, in characters. Capped here at the
 * render site because `UserContextLine` is a public interface any caller can build.
 * A clipped line costs about 270 tokens; no prior costs 0.
 */
const USER_CONTEXT_LINE_MAX_CHARS = 600;

/**
 * Clip the prior and append `…[+N chars]` so the model never reads it as whole (ADR-0070).
 * {@link sanitizeErrorMessage} does the cut because a bare `slice` can split a surrogate pair.
 * N comes from the kept string, and the notice sits outside the cap.
 */
function clipUserContextLine(text: string): string {
  const bounded = sanitizeErrorMessage(text, USER_CONTEXT_LINE_MAX_CHARS);

  if (text.length <= USER_CONTEXT_LINE_MAX_CHARS) return bounded;

  const kept = bounded.trimEnd();

  return `${kept}…[+${text.length - kept.length} chars]`;
}

/**
 * Demotes the cold-start prior. It comes from Alfred's web research, not the user's
 * mail, so it is the weakest signal and may describe a different person.
 */
const USER_CONTEXT_HANDLING_RULE =
  "How to weigh that line: it is Alfred's own web research about the user, not the user's words and not this email, so it is the WEAKEST signal in this block. Use it only to judge whether this email touches the user's employer, studies, projects or public profiles. It never decides a category on its own, and it never outranks the email body.";

function renderObservations(obs: Observations): string {
  const lines: string[] = ["=== Observations (deterministic context — hints, not verdicts) ==="];

  // No standing-instruction line: the model classifies on its own evidence, and the
  // instruction floor applies the user's effects after it (ADR-0113).
  // Above the derived signals.
  // `senderExtractionEvent` mirrors this null check as `userContextPresent`. Change both together.
  if (obs.userContext) {
    lines.push(
      `What Alfred researched about the user (recorded ${obs.userContext.recordedAt.toISOString()}): ${clipUserContextLine(obs.userContext.text)}`,
      `  ${USER_CONTEXT_HANDLING_RULE}`,
    );
  }

  lines.push(`Account persona: ${obs.persona ?? "unknown"}`);

  lines.push(`Known contact: ${obs.knownContact ? "yes" : "no"}`);

  if (obs.senderRelationship) {
    lines.push(`Sender relationship: ${obs.senderRelationship}`);
  }

  if (obs.senderKind) {
    const evidence = obs.senderKind.evidenceCodes.length
      ? `; evidence=${obs.senderKind.evidenceCodes.join(",")}`
      : "";

    lines.push(
      `Sender kind: ${obs.senderKind.kind} (active projection confidence=${obs.senderKind.confidence.toFixed(2)}${evidence})`,
    );
  }

  const g = obs.gmail;
  lines.push(
    `Gmail signals: categories=[${g.categories.join(", ")}]; important=${g.important}; starred=${g.starred}; inbox=${g.inInbox}; spam=${g.spam}; trash=${g.trash}`,
  );

  const c = obs.content;
  lines.push(
    `Content flags: unsubscribe=${c.hasUnsubscribe}; currency=${c.hasCurrencyAmount}; security=${c.hasSecurityKeyword}; ` +
      `calendar=${c.hasCalendarInvite}; investorNotice=${c.hasInvestorNotice}; publicEvent=${c.hasPublicEventLanguage}`,
  );

  return lines.join("\n");
}

/** `Name <addr>`, or the bare address. The From, To, and Cc lines share it. */
function mailboxText(address: string, displayName: string | null): string {
  return displayName ? `${displayName} <${address}>` : address;
}

function recipientLine(label: string, list: readonly MailRecipient[] | null): string[] {
  if (list === null) return [];

  if (list.length === 0) return [`${label}: (empty)`];

  const entries = list.map((r) => {
    const mailbox = mailboxText(r.address, r.displayName);

    if (r.isUser) return `${mailbox} (you)`;

    return r.knownContact ? `${mailbox} (known contact)` : mailbox;
  });

  return [`${label}: ${entries.join(", ")}`];
}

/**
 * The mail-facts lines a triage prompt shows, each only when present. It shows neither the
 * authentication results nor the user's own replies (slice 3 decides those).
 */
export function triageEmailHeaderLines(facts: MailFacts): string[] {
  const { sender, stated } = facts;

  return [
    ...(sender.address ? [`From: ${mailboxText(sender.address, sender.displayName)}`] : []),
    ...(facts.replyTo ? [`Reply-To: ${facts.replyTo}`] : []),
    ...recipientLine("To", facts.to),
    ...recipientLine("Cc", facts.cc),
    ...(facts.receivedBy ? [`Received by: your account ${facts.receivedBy}`] : []),
    // `Date`, because the prompt rules name "the email's Date". It carries the year.
    ...(facts.arrivedAt
      ? [`Date: ${facts.arrivedAt.local} (${facts.arrivedAt.weekday}, ${facts.arrivedAt.timezone})`]
      : []),
    ...(stated.devices.length ? [`Device named in the mail: ${stated.devices.join("; ")}`] : []),
    ...(stated.places.length ? [`Place named in the mail: ${stated.places.join("; ")}`] : []),
    ...(stated.apps.length ? [`App named in the mail: ${stated.apps.join("; ")}`] : []),
    ...(facts.hasAttachments ? ["Attachments: yes"] : []),
  ];
}

function userPrompt(args: ClassifyEmailArgs, instructionSection: string | null): string {
  const lines: string[] = [];

  lines.push("=== SenderContext ===");
  lines.push(JSON.stringify(args.mailFacts.sender.parse.context));
  lines.push("");

  // For the ownership gate (rule 16a). Absent, the model guesses.
  const idName = args.identity?.name?.trim();
  const idEmail = args.identity?.email?.trim();

  if (idName || idEmail) {
    lines.push(
      `=== You (the user being triaged) ===\n${[idName, idEmail && `<${idEmail}>`].filter(Boolean).join(" ")}`,
    );
    lines.push("");
  }

  lines.push(renderObservations(args.observations));
  lines.push("");

  if (instructionSection) {
    lines.push(instructionSection);
    lines.push("");
  }

  lines.push(...triageEmailHeaderLines(args.mailFacts));
  lines.push("");

  lines.push("=== Subject — context, not proof of user ownership ===");
  lines.push(args.mailFacts.subject?.trim() || "(no subject)");
  lines.push("");
  lines.push("=== Body ===");
  lines.push(args.mailFacts.body);

  lines.push("");
  lines.push("=== Earlier thread context — use this to decide loop state and ownership ===");
  lines.push(...renderThreadObservation(args.observations));
  lines.push(
    "Final loop-state check: if the earlier context shows an unanswered user-owned assignment or ask, you MUST keep action or reply. A passive current message cannot demote that open loop.",
  );

  return lines.join("\n");
}

/** Lowercased subject + body + snippet for the floor predicates. */
function floorSignalText(document: ClassifyEmailArgs["document"]): string {
  const parts: string[] = [];

  if (document.title) parts.push(document.title);
  parts.push(document.content);
  const { snippet } = document.metadata;

  if (snippet) parts.push(snippet);

  return parts.join("\n").toLowerCase();
}

/**
 * The theory prompt plus Alfred's own identity from env. Without it, "<our hostname> was
 * granted access" reads as an unknown third party.
 */
function classifySystemPrompt(): string {
  return `${SYSTEM_PROMPT}\n\n${selfIdentityGrounding()}`;
}

export interface ClassifyEmailResult {
  /** The effective result: the model verdict with the user's instruction effects applied. */
  classification: TriageClassification;
  model: string;
  audit: ClassifyAudit;
  /** The `email_triage.model_verdict` column (ADR-0113). */
  modelVerdict: TriageModelVerdict;
  /** The `email_triage.instruction_evaluation` column. Null when the instruction read failed. */
  instructionEvaluation: TriageInstructionEvaluation | null;
}

/** One cheap pass, then the floors and the instruction floor. */
export async function classifyEmail(args: ClassifyEmailArgs): Promise<ClassifyEmailResult> {
  const injected = args.runPass;

  const runPass: ServedPass = injected
    ? async (input) => ({ classification: await injected(input), modelId: "injected" })
    : defaultRunPass(route("cheap").model(), args);

  const signalText = floorSignalText(args.document);
  const floorMatches = matchesExposedSecret(signalText);

  const standing = args.observations.standingInstructions;
  const scopeBlock = buildStandingScopeBlock(standing);

  /**
   * One pass. When its output fails with the match list (cut at the token limit, or a bad
   * shape), it runs again without the instruction section. The email verdict survives, and
   * each sent instruction stays `unknown`: ADR-0113 reads a match that fails or exceeds its
   * bound as `unknown`, and it never discards the verdict for it.
   */
  const runClassifyPass = async (): Promise<ClassifyPassResult> => {
    const run = (section: string | null) =>
      runPass({
        system: classifySystemPrompt(),
        prompt: userPrompt(args, section),
        withInstructionMatches: section !== null,
      });

    if (scopeBlock.section === null) return { served: await run(null), matchFailure: null };

    try {
      return { served: await run(scopeBlock.section), matchFailure: null };
    } catch (err) {
      if (!NoObjectGeneratedError.isInstance(err)) throw err;

      return { served: await run(null), matchFailure: { message: errorMessage(err) } };
    }
  };

  const first = await runClassifyPass();
  const firstPass = first.served.classification;

  // `instructionMatches` is not a classification field, so it leaves before the floors.
  const { instructionMatches: workingMatches, ...workingClassification } =
    first.served.classification;

  const floors = applyFloors(workingClassification, { signalText });

  // The stored model verdict: the system floors' output, before any instruction effect.
  const verdict = {
    category: floors.classification.category,
    documentAsk: floors.classification.documentAsk ?? null,
    todoSuggestion: floors.classification.todoSuggestion ?? null,
    todoDecision: floors.classification.todoDecision ?? null,
  };

  // Matches come from the pass whose classification the row stores.
  const scopeRead = readStandingScopeMatches(scopeBlock.sent, workingMatches);

  const targetMatches: StandingInstructionMatch[] =
    standing?.kind === "loaded"
      ? standing.targetHits.map(({ matchedVia, ...instruction }) => ({
          ...instruction,
          via: { kind: "target", targetKind: matchedVia },
        }))
      : [];

  const standingFloor = applyStandingInstructionEffects(verdict, {
    exposedSecret: floorMatches,
    matches: [...targetMatches, ...scopeRead.matches],
  });

  const effective = standingFloor.result;

  const classification: TriageClassification = {
    ...floors.classification,
    category: effective.category,
    documentAsk: effective.documentAsk,
    todoSuggestion: effective.todoSuggestion,
    todoDecision: effective.todoDecision ?? undefined,
    rationale: standingFloor.reason
      ? truncateRationale(`${floors.classification.rationale} ${standingFloor.reason}`)
      : floors.classification.rationale,
  };

  const standingApplied = standingFloor.audit.effects.some((effect) => effect.result === "applied");

  // Pass tags, then floor tags in sequence order. Query with `LIKE '%+kindfloor%'`, never equality.
  // The base names the leg whose classification the row stores.
  const model_id = [
    first.served.modelId,
    ...floors.modelIdTags,
    ...(first.matchFailure ? ["+match_failed"] : []),
    ...(standingApplied ? ["+standingfloor"] : []),
  ].join("");

  return {
    classification,
    model: model_id,
    audit: {
      firstPass,
      conflict: null,
      secondPass: null,
      secondPassFailure: null,
      floors: floors.audits,
      standing: {
        floor: standingFloor.audit,
        counter: scopeBlock.counter,
        matchFailure: first.matchFailure,
        undecided: scopeBlock.sent.length - scopeRead.scopes.length,
      },
    },
    modelVerdict: { ...verdict, exposedSecret: floorMatches },
    instructionEvaluation:
      standing?.kind === "loaded"
        ? { setRevision: standing.setRevision, scopes: scopeRead.scopes }
        : null,
  };
}

/** Process-wide hedge ceiling. Lazy, so importing never runs `serverEnv()`, which can throw. */
let _hedgeBudget: HedgeBudget | undefined;

function classifyHedgeBudget(): HedgeBudget {
  _hedgeBudget ??= createHedgeBudget(hedgeCeilingFor(serverEnv().AGENT_WORKER_CONCURRENCY));

  return _hedgeBudget;
}

/** One of two fixed schemas, so each request shape stays stable for the provider cache. */
function classifierOutputSchema(input: {
  withInstructionMatches: boolean;
}): z.ZodType<TriageClassifierOutput> {
  return input.withInstructionMatches
    ? triageClassificationWithMatchesSchema
    : triageClassificationSchema;
}

/**
 * The request one classify pass sends. `signal` is required: if it does not
 * reach the request, the hedge loser is never cancelled and silently bills twice.
 */
export function classifyCallOptions(input: {
  model: LanguageModel;
  instructions: string;
  prompt: string;
  signal: AbortSignal;
  maxRetries: number | undefined;
  withInstructionMatches: boolean;
}): MeteredGenerateObjectArgs<TriageClassifierOutput> {
  return {
    model: input.model,
    instructions: input.instructions,
    prompt: input.prompt,
    schema: classifierOutputSchema(input),
    temperature: 0,
    maxOutputTokens:
      TRIAGE_MAX_OUTPUT_TOKENS +
      (input.withInstructionMatches ? TRIAGE_INSTRUCTION_MATCH_OUTPUT_TOKENS : 0),
    // A hung call must not hold a worker slot. A total budget across retries,
    // so an expired timeout leaves nothing for `withFallback`.
    timeout: { totalMs: TRIAGE_REQUEST_TIMEOUT_MS },
    // Cancels the losing hedge. `withFallback` does not retry an abort on the fallback.
    abortSignal: input.signal,
    ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
  };
}

/**
 * The production pass runner, hedged (#436): a slow answer gets a twin call and
 * the first wins. {@link hedgeCeilingFor} caps it.
 */
function defaultRunPass(model: LanguageModel, args: ClassifyEmailArgs): ServedPass {
  return async ({ system, prompt, withInstructionMatches }) => {
    const delayMs = args.hedgeDelayMs ?? serverEnv().TRIAGE_CLASSIFY_HEDGE_MS;

    const result = await runHedged({
      delayMs,
      // With hedging off (the eval) there is nothing to budget, so skip `serverEnv()`.
      ...(delayMs > 0 ? { budget: classifyHedgeBudget() } : {}),
      run: ({ attempt, signal }) =>
        // oxlint-disable-next-line alfred/ai-call-needs-abort-signal -- `classifyCallOptions` sets `abortSignal` to the hedge signal.
        meteredGenerateObject<TriageClassifierOutput>(
          classifyCallOptions({
            model,
            instructions: system,
            prompt,
            signal,
            maxRetries: args.maxRetries,
            withInstructionMatches,
          }),
          {
            role: "triage",
            userId: args.userId,
            runId: args.runId,
            stepId: args.stepId,
            // One key per pass and per hedge draw: both draws are billed.
            idempotencyKey: args.idempotencyKey
              ? `${args.idempotencyKey}${attempt === 1 ? ":hedge" : ""}`
              : undefined,
            requestMeta: {
              purpose: "triage.classify",
              documentId: args.document.id,
              // Hedge cost = count of calls with `hedge: true`.
              hedge: attempt === 1,
            },
            name: "triage.classify",
          },
        ),
    });

    return {
      classification: normalizeClassifierOutput(result.output),
      // The hedge winner's served leg. The route model always names its primary.
      modelId: result.finalStep.response.modelId,
    };
  };
}

export function normalizeClassifierOutput<O extends TriageClassification>(output: O): O {
  // NUL and lone surrogates fail `text` and `jsonb`. Strip them here, so the stored model
  // verdict, the effective result, and the rationale all start clean.
  const object = sanitizeToolResult(output).value;

  return {
    ...object,
    confidence: clamp01(object.confidence),
    // The model may omit the key. Never throw: a first-pass throw buries the real answer as `fyi`.
    collabActivity: object.collabActivity ?? null,
    documentAsk: object.documentAsk ?? null,
  };
}

function errorMessage(err: unknown): string {
  return toMessage(err);
}

/** Failure-path category, so no message is left untriaged. */
export const DEFAULT_TRIAGE_CATEGORY: TriageCategory = "fyi";
