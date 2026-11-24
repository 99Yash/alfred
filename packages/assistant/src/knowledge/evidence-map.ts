/**
 * The compact evidence map (docs/theory/evidence-map.md §2 and §3): each user-scoped store, how far
 * back it reaches, what it does not hold, and which questions it answers. The prompt carries it, so
 * a gather starts knowing where evidence can be and spends no step to find out. Chat is the first
 * reader; the other gathers converge on it (§2, "One map, every reader").
 *
 * The compiler is the gate of §6:
 * - Each entry names its Drizzle tables. An entry with no table does not compile, and a table that
 *   the schema does not export cannot be named. The rendered names come from the tables.
 * - `UserScopedTable` excludes the observability stores, so naming one as a source does not compile.
 * - `defineEvidenceMap` rejects an entry whose prose names an observability table.
 */

import type * as schemas from "@alfred/db/schemas";
import type {
  account,
  apiCallLog,
  eventsOutbox,
  ingestionState,
  integrationCredentials,
  mcpApiKeyCredentials,
  mcpOauthCredentials,
  modelPrices,
} from "@alfred/db/schemas";
import {
  chatExchanges,
  chatMessages,
  documents,
  eventReceipts,
  integrationObjects,
  memoryChunks,
  observations,
  senderPriors,
  userFacts,
} from "@alfred/db/schemas";
import { getTableName, type Table } from "drizzle-orm";

/**
 * The machine's observability (§2, "The map is the user-scoped surface"): spend, prices, queue
 * internals, and the credential vault. The map never names them.
 */
type ObservabilityTable =
  | typeof apiCallLog
  | typeof modelPrices
  | typeof eventsOutbox
  | typeof ingestionState
  | typeof integrationCredentials
  | typeof mcpOauthCredentials
  | typeof mcpApiKeyCredentials
  | typeof account;

type ObservabilityTableName = ObservabilityTable["_"]["name"];

type SchemaTable = {
  [K in keyof typeof schemas]: (typeof schemas)[K] extends Table ? (typeof schemas)[K] : never;
}[keyof typeof schemas];

/** A table the map may name: one that the schema exports, minus the observability tables. */
type UserScopedTable = Exclude<SchemaTable, ObservabilityTable>;

/** The question groups of the probe table (§2, "What it answers"). */
type EvidenceQuestion = "did" | "usually" | "live" | "names" | "said";

const QUESTION_WORDS = {
  did: "what the user did",
  usually: "how the user usually acts",
  live: "what is live now",
  names: "things and names",
  said: "what the user said",
} as const satisfies Record<EvidenceQuestion, string>;

interface StoreEntry {
  /** The store in plain words. */
  readonly store: string;
  readonly tables: readonly [UserScopedTable, ...UserScopedTable[]];
  /** From when the store holds evidence, in the words of the source. */
  readonly reach: string;
  /** What the store does not hold. */
  readonly gaps: string | null;
  /** A retired store answers nothing: it is not evidence. */
  readonly answers: readonly [EvidenceQuestion, ...EvidenceQuestion[]] | "not evidence";
  /** What replaced the store, or what it replaces, and the ADR that decided it. */
  readonly lineage?: { readonly adr: `ADR-${number}`; readonly change: string };
}

/** `true` when some string in `T` contains the name of an observability table. */
type NamesObservability<T> = T extends string
  ? T extends `${string}${ObservabilityTableName}${string}`
    ? true
    : never
  : T extends Table
    ? never
    : T extends readonly unknown[]
      ? NamesObservability<T[number]>
      : T extends object
        ? { [K in keyof T]-?: NamesObservability<T[K]> }[keyof T]
        : never;

interface TheEvidenceMapNamesAnObservabilityStore {
  readonly "Remove api_call_log, model_prices, queue tables, and credential tables from the prose": never;
}

function defineEvidenceMap<const M extends readonly StoreEntry[]>(
  map: M &
    ([NamesObservability<M>] extends [never] ? unknown : TheEvidenceMapNamesAnObservabilityStore),
): M {
  return map;
}

const EVIDENCE_MAP = defineEvidenceMap([
  {
    store: "Mail",
    tables: [documents],
    reach:
      "the mail that Alfred ingested around and after the Gmail connect; older mail is only in Gmail, which holds mail from years before sign-in",
    gaps: null,
    answers: ["did", "said"],
  },
  {
    store: "Activity record",
    tables: [observations],
    reach: "from each integration connect",
    gaps: "no actor mark; acts and state changes, not each delivery (forty CI webhooks on one branch are one change)",
    answers: ["did", "usually"],
  },
  {
    store: "Deliveries",
    tables: [eventReceipts],
    reach: "every delivery since each integration connect, raw kinds kept (ADR-0097)",
    gaps: "no body (a webhook body is in `documents.raw`; a Gmail receipt never had one); no actor mark",
    answers: ["did"],
  },
  {
    store: "Object state",
    tables: [integrationObjects],
    reach: "from each integration connect",
    gaps: "lookup by exact id only",
    answers: ["did", "names"],
  },
  {
    store: "Chat turns",
    tables: [chatMessages, chatExchanges],
    reach: "from the first turn; an exchange is searchable a few minutes after its reply",
    gaps: "an Alfred reply is Alfred's own output, not evidence; a message with only attachments is not searchable",
    answers: ["said", "live"],
  },
  {
    store: "Memory facts",
    tables: [userFacts],
    reach: "from the first capture",
    gaps: "no check that a user claim quotes the user; a web page link keeps no text snapshot",
    answers: ["names", "said", "usually"],
    lineage: {
      adr: "ADR-0123",
      change:
        "each row is a claim that cites its evidence, author, and producer; name links are not built yet",
    },
  },
  {
    store: "Page snapshots",
    tables: [memoryChunks],
    reach: "from the cold-start research",
    gaps: "stored per run, not per claim",
    answers: ["usually", "names"],
  },
  {
    store: "Sender counts",
    tables: [senderPriors],
    reach: "from the first triage",
    gaps: "it counts Alfred's own triage labels, not what the user did",
    answers: "not evidence",
    lineage: { adr: "ADR-0121", change: "retired, with no successor store" },
  },
]);

function formatEntry(entry: StoreEntry): string {
  const tables = entry.tables.map((table) => `\`${getTableName(table)}\``).join(", ");
  const parts = [`- ${entry.store} (${tables}). Reach: ${entry.reach}.`];

  if (entry.gaps) parts.push(`Gaps: ${entry.gaps}.`);

  parts.push(
    entry.answers === "not evidence"
      ? "Not evidence."
      : `Answers: ${entry.answers.map((question) => QUESTION_WORDS[question]).join(", ")}.`,
  );

  if (entry.lineage) parts.push(`Lineage: ${entry.lineage.change} (${entry.lineage.adr}).`);

  return parts.join(" ");
}

/** Prompt block. Constant per process; chat pins it in run state with the self-identity block. */
export const EVIDENCE_MAP_GROUNDING = [
  "Where evidence lives. Each line is a store of the user's life: how far back it reaches, what it does not hold, and the questions it answers. Start a gather from this map; do not spend a step to find where evidence is. Cite the record that you read, never this map. A lineage names the ADR that decided it: read the ADR before you state why a store has its shape.",
  ...EVIDENCE_MAP.map(formatEntry),
].join("\n");
