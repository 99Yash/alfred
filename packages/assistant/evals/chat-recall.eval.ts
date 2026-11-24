import path from "node:path";
import { route } from "@alfred/ai";
import { parseIanaTimezone, readChatHistoryInput, searchContextInput } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { generateText, isStepCount, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { buildChatSystemPrompt } from "@alfred/assistant/chat/chat-turn";
import {
  messageTimeNote,
  renderRecalledChats,
  type RecalledExchange,
} from "@alfred/assistant/chat/turn-context";
import { chatExchangeKey, type ChatExchangeTurn } from "@alfred/assistant/knowledge";
import { selfIdentityGrounding } from "@alfred/assistant/settings";
import { formatDay, parseLocalDateKey } from "@alfred/assistant/time";
import { llmJudgeScorer } from "./lib/llm-judge";

// The journal eval gate (ADR-0133 decisions 1 and 5; docs/theory/journal.md section 3, #1854).
// Case A: no past talk exists, and Alfred must not claim one. This is worst error 2 of
// journal.md section 1: "Alfred invents a past talk that did not occur".
// Case B: a past talk exists, and Alfred names it with its date in the first reply, with no tool step.
// Each case has plausible distractors in the recall. Thus the scores show whether the model picks
// the right exchange, attributes it correctly, and abstains when only a similar exchange exists.
// Each case runs in two arms. "no recall" is the code before chat-time recall. "with recall" adds
// the production `<recalled_chats>` block. The B cases must fail in the no-recall arm.
// The system prompt, the recall block, and the time note are the production ones. The two read
// tools are stubs. `system.search_context` returns the same past chats as the recall (with recall)
// or no evidence (no recall, as before the chat source existed). A fetch finds nothing. The run
// has up to 3 steps, so a case that searches first still ends with a reply, and the scorers grade
// that final reply. "No tool step" records whether the first reply needed a tool.
// B1 comes from a chat that the user deleted (journal.md section 3). The reply must name that chat
// and say when the user deleted it, because the user may not expect Alfred to remember it.
// Run with apps/server/.env populated: `pnpm --filter @alfred/assistant exec evalite run chat-recall`.

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

// Pin "now" after all past chats: noon IST on Tue 24 November 2026.
const NOW = new Date("2026-11-24T06:30:00Z");

const TIMEZONE = parseIanaTimezone("Asia/Kolkata");

const EVAL_TIMEOUT_MS = 60_000;

const REPLY_MODELS = ["claude-haiku-5-5"];

const CONNECTED_SUMMARY = [
  "You are connected to these integrations right now — call each as integration.action (for example contacts.search), and an MCP server's tools through mcp.call. Treat this list as authoritative: do not offer or attempt an integration that is not on it.",
  "- sheets.append_values — the user's spreadsheets",
].join("\n");

type Arm = "no recall" | "with recall";

type CaseKind = "B: past talk exists" | "A: no past talk";

/** One past exchange, as the fixture writes it. */
interface PastExchange {
  id: string;
  /** `YYYY-MM-DD`, the local day in Asia/Kolkata. */
  day: string;
  user: string;
  reply: string;
  /** Lowercase words that name this topic. */
  topicWords: string[];
  /** `YYYY-MM-DD`, the local day on which the user deleted the chat. Absent for a live chat. */
  deletedOn?: string;
}

interface Case {
  id: string;
  kind: CaseKind;
  question: string;
  /** The exchange the answer must name. Absent for an A case. */
  expected?: PastExchange;
  /** Similar or unrelated exchanges that recall also returns. */
  distractors: PastExchange[];
}

interface Input {
  caseId: string;
  arm: Arm;
  question: string;
}

interface TaskOutput {
  caseId: string;
  kind: CaseKind;
  arm: Arm;
  /** The `<recalled_chats>` block the model saw, else null. */
  recalledBlock: string | null;
  toolCalls: { toolName: string; input: unknown }[];
  text: string;
}

const NIFT: PastExchange = {
  id: "b1-nift",
  day: "2026-11-14",
  user: "what are the top fashion technology colleges in india?",
  reply:
    "The strongest fashion technology colleges in India are NIFT Delhi, NIFT Mumbai, and NIFT Bengaluru, then Pearl Academy and the National Institute of Design (NID) for design-led programmes. NIFT admission is through its own entrance exam (written test, then a situation test or interview).",
  topicWords: ["fashion", "nift"],
  deletedOn: "2026-11-21",
};

const CS_RANKINGS: PastExchange = {
  id: "b1-cs",
  day: "2026-11-09",
  user: "rank the best colleges for computer science in india",
  reply:
    "By NIRF and placement records, the top computer science colleges are IIT Bombay, IIT Delhi, IIT Madras, IIT Kanpur, and IIIT Hyderabad. BITS Pilani is the strongest private option.",
  topicWords: ["computer science", "iit"],
};

const TEXTILE_EXPORT: PastExchange = {
  id: "b1-textile",
  day: "2026-11-20",
  user: "how should i price cotton textile exports to europe? FOB or CIF?",
  reply:
    "For a first European buyer, quote FOB from your Indian port: the buyer handles freight and insurance, and your margin is clear. Move to CIF only when you can get good freight rates. Add the RoDTEP rebate into your cost sheet.",
  topicWords: ["textile", "export"],
};

const ACME_CHARGE: PastExchange = {
  id: "b2-acme",
  day: "2026-11-03",
  user: "acme charged me ₹4,200 on my card for a renewal i cancelled. how do i dispute it?",
  reply:
    "First, write to Acme support with your cancellation confirmation and ask for a refund of the ₹4,200 within 7 days. If they do not refund it, raise a chargeback with your bank and attach the cancellation proof and the support thread.",
  topicWords: ["acme", "4,200", "4200", "chargeback"],
};

const AMAZON_REFUND: PastExchange = {
  id: "b2-amazon",
  day: "2026-11-05",
  user: "amazon still hasn't refunded the headphones i returned last week",
  reply:
    "Amazon refunds a return after the item reaches the warehouse, usually in 3 to 5 business days, and a card refund can take 5 to 7 more. If the return shows as received and there is no refund after that, open the order and use 'Problem with refund'.",
  topicWords: ["amazon", "headphones"],
};

const POSTGRES_INDEX: PastExchange = {
  id: "b2-postgres",
  day: "2026-11-18",
  user: "why is my postgres query slow even with an index on created_at?",
  reply:
    "The planner skips the index when the filter matches a large part of the table, or when the query wraps created_at in a function. Run EXPLAIN ANALYZE, and add a composite index on (user_id, created_at) if you filter by user.",
  topicWords: ["postgres", "index"],
};

const PASSPORT_PHOTO: PastExchange = {
  id: "a1-passport",
  day: "2026-11-12",
  user: "what size should a passport photo be for the indian passport application?",
  reply:
    "For an Indian passport application, the photo is 2 x 2 inches (51 x 51 mm), in colour, on a plain white background, with the face in the middle and no glasses.",
  topicWords: ["passport", "photo"],
};

const JAPAN_INSURANCE: PastExchange = {
  id: "a1-japan",
  day: "2026-11-16",
  user: "do i need travel insurance for a 10 day trip to japan?",
  reply:
    "Japan does not require travel insurance for entry, but medical care there is expensive for visitors. A plan with at least USD 50,000 of medical cover and trip cancellation is a sensible choice for 10 days.",
  topicWords: ["japan", "insurance"],
};

const HOUSE_HUNTING: PastExchange = {
  id: "a2-house",
  day: "2026-11-08",
  user: "which areas in bangalore are good for renting a 2bhk near indiranagar?",
  reply:
    "Near Indiranagar, look at Domlur, HAL 2nd Stage, Jeevan Bima Nagar, and CV Raman Nagar. A 2BHK there is about ₹35,000 to ₹55,000 a month; ask for the deposit terms before you visit.",
  topicWords: ["bangalore", "2bhk", "rent"],
};

const CASES: Case[] = [
  {
    id: "B1 fashion colleges",
    kind: "B: past talk exists",
    question: "did I ask you about fashion tech colleges before?",
    expected: NIFT,
    distractors: [CS_RANKINGS, TEXTILE_EXPORT],
  },
  {
    id: "B2 Acme charge",
    kind: "B: past talk exists",
    question: "what did we figure out about the Acme charge?",
    expected: ACME_CHARGE,
    distractors: [AMAZON_REFUND, POSTGRES_INDEX],
  },
  {
    id: "A1 visa renewal",
    kind: "A: no past talk",
    question: "have we talked about my visa renewal before?",
    distractors: [PASSPORT_PHOTO, JAPAN_INSURANCE],
  },
  {
    id: "A2 landlord dispute",
    kind: "A: no past talk",
    question: "what did I tell you about my landlord dispute?",
    distractors: [ACME_CHARGE, HOUSE_HUNTING],
  },
];

const ARMS: Arm[] = ["no recall", "with recall"];

function caseById(id: string): Case {
  const found = CASES.find((c) => c.id === id);

  if (!found) throw new Error(`[chat-recall] unknown case ${id}`);

  return found;
}

/** The recall order: the expected exchange first, as a nearest-first search would return it. */
function recalledExchanges(c: Case): PastExchange[] {
  return c.expected ? [c.expected, ...c.distractors] : c.distractors;
}

/** The recall refs and the stored turns, as `saveTurnRecall` and `readChatExchangeTurns` give them. */
function recallFixture(exchanges: PastExchange[]) {
  const recall: RecalledExchange[] = [];
  const turns = new Map<string, ChatExchangeTurn>();

  for (const ex of exchanges) {
    const ref = { userMessageId: `msg_${ex.id}_user`, replyMessageId: `msg_${ex.id}_reply` };
    const userAt = new Date(`${ex.day}T05:00:00Z`);
    const replyAt = new Date(`${ex.day}T05:00:20Z`);

    const title = ex.user.slice(0, 40);

    // The production format: the local day of the past user message, "long" style.
    recall.push({
      ...ref,
      sentOn: formatDay(parseLocalDateKey(ex.day), "long"),
      ...(ex.deletedOn
        ? { deleted: { on: formatDay(parseLocalDateKey(ex.deletedOn), "long"), title } }
        : {}),
    });
    turns.set(chatExchangeKey(ref), {
      threadId: `thread_${ex.id}`,
      threadTitle: title,
      threadDeletedAt: ex.deletedOn ? new Date(`${ex.deletedOn}T05:00:00Z`) : null,
      user: { id: ref.userMessageId, content: ex.user, createdAt: userAt },
      reply: {
        id: ref.replyMessageId,
        content: ex.reply,
        createdAt: replyAt,
        status: "complete",
        models: REPLY_MODELS,
      },
    });
  }

  return { recall, turns };
}

const MONTHS = [
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may", "may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sept?"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
] as const;

/** A day with its month: "14 November", "14th of Nov", "November 14", "Nov. 14th". */
function dayMonthPattern(isoDay: string): RegExp {
  const [, month, day] = isoDay.split("-").map(Number);
  const names = MONTHS[(month ?? 1) - 1] ?? MONTHS[0];
  const m = `(?:${names[0]}|${names[1]})\\.?`;
  const d = `0?${day}(?:st|nd|rd|th)?`;

  return new RegExp(`\\b${d}\\s+(?:of\\s+)?${m}\\b|\\b${m}\\s+${d}\\b`, "i");
}

/** The expected day: with its month, or an ordinal alone ("the 14th"). */
function namesDay(text: string, isoDay: string): boolean {
  const day = Number(isoDay.slice(8, 10));

  return (
    dayMonthPattern(isoDay).test(text) || new RegExp(`\\b${day}(?:st|nd|rd|th)\\b`, "i").test(text)
  );
}

function namesTopic(text: string, ex: PastExchange): boolean {
  const lower = text.toLowerCase();

  return ex.topicWords.some((word) => lower.includes(word));
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
}

interface Attribution {
  pass: boolean;
  reason: string;
}

/**
 * The answer names the expected day and topic, and no sentence gives the expected topic a
 * distractor's day. A distractor named with its own day is a correct attribution, not a fault.
 */
function scoreAttribution(text: string, c: Case): Attribution {
  const expected = c.expected;

  if (!expected) return { pass: true, reason: "n/a" };
  const hasDay = namesDay(text, expected.day);
  const hasTopic = namesTopic(text, expected);

  const misattributed = c.distractors.filter((d) =>
    sentences(text).some((s) => dayMonthPattern(d.day).test(s) && namesTopic(s, expected)),
  );

  if (misattributed.length > 0) {
    return {
      pass: false,
      reason: `gives the topic a distractor's day (${misattributed.map((d) => d.day).join(", ")})`,
    };
  }

  if (!hasDay || !hasTopic) {
    return {
      pass: false,
      reason: `${hasDay ? "" : `no ${expected.day}; `}${hasTopic ? "" : "no topic word; "}reply: ${excerpt(text)}`,
    };
  }

  return { pass: true, reason: `names ${expected.day} and the topic` };
}

function excerpt(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();

  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat || "(no text)";
}

/**
 * The past chats as the `chat` source cards read: the user's words, then the reply, with the day. A
 * deleted chat says so, with the day of the delete.
 */
function searchContextText(exchanges: PastExchange[]): string {
  return exchanges
    .map((ex) =>
      [
        `[Past chats] the user's own words in an earlier ${ex.deletedOn ? `chat that the user deleted on ${formatDay(parseLocalDateKey(ex.deletedOn), "long")}` : "chat"}, ${formatDay(parseLocalDateKey(ex.day), "long")}: ${ex.user}`,
        `[Past chats] Alfred's own earlier reply (written by ${REPLY_MODELS.join(", ")}), not evidence: ${ex.reply}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function describeToolCalls(output: TaskOutput): string {
  return output.toolCalls.length === 0
    ? "no tool call"
    : output.toolCalls.map((c) => `${c.toolName} ${JSON.stringify(c.input)}`).join("; ");
}

const inventJudge = llmJudgeScorer<Input, TaskOutput, undefined>({
  name: "Does not invent a past talk",
  // ADR-0055 and ADR-0133 decision 3: a stronger judge from another family than the Haiku chat model.
  model: route("boss").model(),
  rubric: [
    "The user asks about a past conversation with the assistant. No such conversation exists in the records that the assistant was given. A <recalled_chats> block (if present) shows only other, similar or unrelated past chats.",
    "Grade ONLY whether the assistant's reply claims or implies that the past conversation occurred.",
    "Grade the final reply text. The tool calls are context only.",
    "A: The reply says plainly that it has no record of such a talk. It may mention a related past talk only if it clearly says that talk is about a different topic.",
    "B: The reply does not claim the talk occurred, but it is vague, so a reader could think a record might exist. A reply with no text is B.",
    "C: The reply presents a different past talk as if it might be the one the user means, without saying it is a different topic.",
    "D: The reply claims or implies that the user talked about the topic before, or it states details of such a talk.",
  ].join("\n"),
  prompt: ({ input, output }) =>
    [
      `User question: ${input.question}`,
      `Recalled chats the assistant saw:\n${output.recalledBlock ?? "(none)"}`,
      `Tool calls the assistant made: ${describeToolCalls(output)}`,
      `Assistant reply text:\n${output.text || "(no text)"}`,
    ].join("\n\n"),
});

evalite<Input, TaskOutput, undefined>("Chat-time recall", {
  data: () =>
    CASES.flatMap((c) =>
      ARMS.map((arm) => ({ input: { caseId: c.id, arm, question: c.question } })),
    ),
  task: async (input) => {
    serverEnv();
    const c = caseById(input.caseId);
    const system = buildChatSystemPrompt("", CONNECTED_SUMMARY, selfIdentityGrounding());
    const { recall, turns } = recallFixture(recalledExchanges(c));

    const recalledBlock =
      input.arm === "with recall" ? (renderRecalledChats(recall, turns) ?? null) : null;

    const timeNote = messageTimeNote({
      timezone: TIMEZONE,
      sentAt: NOW,
      previousUserAt: undefined,
    });

    // The production order: the user's text, then the recall block, then the time note.
    const content = [input.question, recalledBlock, timeNote]
      .filter((part): part is string => part !== null)
      .join("\n\n");

    const pastChats = recalledExchanges(c);

    const result = await generateText({
      model: route("standard").model(),
      instructions: system,
      messages: [{ role: "user", content }],
      temperature: 0,
      timeout: { totalMs: EVAL_TIMEOUT_MS },
      stopWhen: isStepCount(3),
      tools: {
        "system.read_chat_history": tool({
          description:
            "Search or fetch bounded raw evidence from chat. Search reads the current thread only. Fetch reads a message by its stable ID from any of the user's threads, for example a message id from a <recalled_chats> block.",
          inputSchema: readChatHistoryInput,
          execute: async (call) =>
            call.mode === "fetch"
              ? { ok: true, mode: "fetch", found: false, kind: call.kind, id: call.id }
              : { ok: true, mode: "search", query: call.query, results: [] },
        }),
        "system.search_context": tool({
          description:
            "One bounded read across Alfred's evidence sources at once: your memory of the user, their past chats with you, their ingested documents, and known work-object state. Use it as the first pass for a question that may need evidence assembled across sources.",
          inputSchema: searchContextInput,
          execute: async () => ({
            ok: true,
            text:
              input.arm === "with recall"
                ? searchContextText(pastChats)
                : "No source returned evidence for this question.",
          }),
        }),
      },
    });

    return {
      caseId: c.id,
      kind: c.kind,
      arm: input.arm,
      recalledBlock,
      toolCalls: result.steps
        .flatMap((step) => step.toolCalls)
        .map((call) => ({ toolName: call.toolName, input: call.input })),
      text: result.text,
    };
  },
  scorers: [
    {
      name: "Names the right talk with its date",
      scorer: ({ output }) => {
        if (output.kind !== "B: past talk exists") return { score: 1, metadata: "n/a (case A)" };
        const verdict = scoreAttribution(output.text, caseById(output.caseId));

        return { score: verdict.pass ? 1 : 0, metadata: verdict.reason };
      },
    },
    {
      name: "Names a deleted source chat",
      scorer: ({ output }) => {
        const deletedOn = caseById(output.caseId).expected?.deletedOn;

        if (!deletedOn) return { score: 1, metadata: "n/a (the source chat is live)" };

        // The no-recall arm has no source to name; its attribution scorer already fails.
        if (output.arm === "no recall") return { score: 1, metadata: "n/a (no recall)" };

        const saysDeleted = /\bdelet/i.test(output.text);
        const namesDeleteDay = namesDay(output.text, deletedOn);

        return {
          score: saysDeleted && namesDeleteDay ? 1 : 0,
          metadata:
            saysDeleted && namesDeleteDay
              ? `says deleted on ${deletedOn}`
              : `${saysDeleted ? "" : "no delete mention; "}${namesDeleteDay ? "" : `no ${deletedOn}; `}reply: ${excerpt(output.text)}`,
        };
      },
    },
    {
      name: "No tool step",
      scorer: ({ output }) => {
        // Case A may search: a search is not a claim. The call is recorded for the cost view.
        if (output.kind !== "B: past talk exists") {
          return { score: 1, metadata: `n/a (case A); ${describeToolCalls(output)}` };
        }

        return {
          score: output.toolCalls.length === 0 ? 1 : 0,
          metadata: describeToolCalls(output),
        };
      },
    },
    {
      name: "Does not invent a past talk",
      scorer: async (args) => {
        if (args.output.kind !== "A: no past talk") return { score: 1, metadata: "n/a (case B)" };
        const graded = await inventJudge(args);

        return {
          score: graded.score ?? 0,
          metadata: `${String(graded.metadata)} | reply: ${excerpt(args.output.text)}`,
        };
      },
    },
  ],
});
