/**
 * Migrate the v1 standing-instruction rows to three v2 instructions (ADR-0113, "Migration of v1
 * rows"; plan `docs/plans/standing-instructions-v2-step1.md`, PR 5).
 *
 * The live v1 rows come from two chat sentences: the investment sentence, and the Polylane and
 * Smallcase sentence. This script proposes three v2 instructions from all of the owner's words:
 *  1. `investment`: a scope for investment and stock-market mail, with no targets.
 *  2. `investment_exception`: `exceptionOf` the first one, for Income Tax Department and legal
 *     mail. It has no effects, so that it cancels every lowering effect of instruction 1 on mail
 *     that both match (plan decision 10).
 *  3. `polylane_smallcase`: a scope with a sender filter on the two named senders.
 * The owner reviews every v1 row and every instruction before anything is written. The plan file
 * holds the review, so a session that stops can resume.
 *
 * Every write goes through `saveStandingInstruction`, the capture operation of chat, so the
 * capture lock, the conflict gate, the observation log, and the set-revision trigger of migration
 * 0154 all run. The attribution is the owner (ADR-0115 `user_direct`): the source is
 * `{ kind: "user" }`, with the review and the owner's quoted words in its `meta`.
 *
 * The script reads the v1 rows from the database at run time. Bundled for prod. Dry by default.
 *
 *   # 1. Review (dry, no model call). Asks one question for each row on a terminal:
 *   node dist/scripts/backfills/migrate-standing-instructions-v2-committed.js
 *   # 2. Optional, model calls: the stored mail of each removed sender that the scope rejects:
 *   node dist/scripts/backfills/migrate-standing-instructions-v2-committed.js check-removed
 *   # 3. The rollout gate: write the candidate set, label it, then the paired replay:
 *   node dist/scripts/backfills/migrate-standing-instructions-v2-committed.js gate-candidates
 *   node dist/scripts/backfills/migrate-standing-instructions-v2-committed.js gate-check
 *   # 4. Commit (writes):
 *   node dist/scripts/backfills/migrate-standing-instructions-v2-committed.js --commit
 *
 * Flags: `--email=<user>` (default the owner), `--dir=<path>` (default
 * `<repo>/references/standing-instructions-v2`), `--fresh` (drop the saved review), `--limit=<n>`
 * and `--yes` for the commands that call a model.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { PRIORITY_CATEGORIES } from "@alfred/assistant/briefings";
import {
  listStandingInstructions,
  previewStandingInstructionValue,
  saveStandingInstruction,
  standingInstructionsOf,
  type ActiveStandingInstruction,
  type SaveStandingInstructionInput,
} from "@alfred/assistant/knowledge";
import { settings } from "@alfred/assistant/settings";
import { resolveTodosForGmailSource } from "@alfred/assistant/tasks";
import {
  classifyEmail,
  deriveEffectiveTriage,
  extractSenderContext,
  gatherObservations,
  loadTriageContext,
  previewStandingScopeMatches,
  threadsWhereInstructionBlocksTodo,
  type StandingScopePreviewState,
} from "@alfred/assistant/triage";
import { notSentGmailDocumentWhere } from "@alfred/assistant/triage/sent-mail";
import {
  emailDomain,
  normalizeEmailAddress,
  parseGmailDocumentMetadata,
  rememberInput,
  STANDING_INSTRUCTION_CAPTURE_EFFECT_KINDS,
  STANDING_INSTRUCTION_KEY,
  standingInstructionScopesIntersect,
  standingInstructionTargetSchema,
  standingInstructionValueSchema,
  standingInstructionValueV2Schema,
  targetMatchesSender,
  toMessage,
  triageCategorySchema,
  type MemorySource,
  type StandingInstructionTarget,
  type StandingInstructionValueV2,
  type TodoAttribution,
  type TriageCategory,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  apiCallLog,
  documents,
  emailTriage,
  user as userTable,
  userFacts,
} from "@alfred/db/schemas";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { closeScriptResources } from "../script-runtime";

// ─── Flags ──────────────────────────────────────────────────────────────────

function flag(name: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));

  return arg ? arg.slice(`--${name}=`.length) : null;
}

const COMMIT = process.argv.includes("--commit");

const FRESH = process.argv.includes("--fresh");

const YES = process.argv.includes("--yes");

const COMMAND = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "review";

const TARGET_EMAIL = flag("email") ?? "yashgouravkar@gmail.com";

/** `<repo>/references/standing-instructions-v2`, from `apps/server` or from the repo root. */
function defaultDir(): string {
  const cwd = process.cwd();
  const inServerApp = basename(cwd) === "server" && basename(dirname(cwd)) === "apps";

  return resolve(
    inServerApp ? resolve(cwd, "../..") : cwd,
    "references",
    "standing-instructions-v2",
  );
}

const DIR = resolve(flag("dir") ?? defaultDir());

const PLAN_PATH = resolve(DIR, "plan.json");

const LABELS_PATH = resolve(DIR, "gate-labels.json");

/** The hard cap of model calls for one command. `--limit` can lower it, never raise it. */
const MODEL_CALL_HARD_CAP = 400;

function callLimit(fallback: number): number {
  const raw = flag("limit");
  const parsed = raw === null ? fallback : Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error("--limit must be a positive integer");

  return Math.min(parsed, MODEL_CALL_HARD_CAP);
}

// ─── The owner's words (ADR-0113 "Migration of v1 rows"; owner decisions of 2026-10-30) ─────

const evidenceSchema = z.object({ date: z.string(), source: z.string(), words: z.string() });

type Evidence = z.infer<typeof evidenceSchema>;

const WORDS = {
  investmentJune: {
    date: "2026-06-08",
    source: "Claude session b3f0d89f",
    words:
      "Manufactured urgency should not be considered as a to do … we might as well place them in fyi.",
  },
  investmentSept8: {
    date: "2026-09-08",
    source: "Alfred chat",
    words:
      "please remember not to tag stocks related emails as urgent or if there's any meetings etc scheduled, none of my concern. i have invested some money but i am still 24 and have a job.",
  },
  investmentSept11: {
    date: "2026-09-11",
    source: "Alfred chat",
    words:
      "pls remember not to tag stocks/investments meetings related emails (i think you do already) unless they're urgent. i have passively invested in them and not even a great amount.",
  },
  investmentSept16: {
    date: "2026-09-16",
    source: "Claude session 7b88a731",
    words:
      "I had asked it to not surface these emails as important any investment related or banking or maybe investment stocks related stuff",
  },
  investmentOct30: {
    date: "2026-10-30",
    source: "Alfred chat",
    words:
      "investments and stocks related returns stuff are not important, unless it's from the income tax deptt. or some legal matter",
  },
  polylane: {
    date: "2026-09-26",
    source: "Alfred chat",
    words: "stop reminding me about connecting stuff to polylane, stop marking em urgent",
  },
  smallcase: {
    date: "2026-09-26",
    source: "Alfred chat",
    words: "same for smallcase rebalance updates. remove action items from this and polylane",
  },
} as const satisfies Record<string, Evidence>;

/** The owner's quoted words, one line, for the stored `phrasing`. */
function quote(...evidence: readonly Evidence[]): string {
  return evidence.map((e) => `${e.date}: "${e.words}"`).join(" ");
}

/** The owner dropped this 2026-09-11 directive edit on 2026-10-30. No stored directive may hold it. */
const DROPPED_DIRECTIVE_EDIT = /genuinely urgent/i;

// ─── The plan file ──────────────────────────────────────────────────────────

const GROUP_KEYS = ["investment", "polylane_smallcase"] as const;

const INSTRUCTION_KEYS = ["investment", "investment_exception", "polylane_smallcase"] as const;

const SENDER_RESULTS = ["remove", "target", "sender_filter"] as const;

type GroupKey = (typeof GROUP_KEYS)[number];

type InstructionKey = (typeof INSTRUCTION_KEYS)[number];

/** `force_category` needs a category argument. This review does not offer it. */
const PLAN_EFFECT_KINDS = STANDING_INSTRUCTION_CAPTURE_EFFECT_KINDS.filter(
  (kind): kind is Exclude<typeof kind, "force_category"> => kind !== "force_category",
);

const effectPlanSchema = z.object({
  kind: z.enum(PLAN_EFFECT_KINDS),
  /** The owner's words that ask for the effect. Empty for an effect the owner added. */
  because: z.array(evidenceSchema),
  ownerAdded: z.boolean(),
});

type EffectPlan = z.infer<typeof effectPlanSchema>;

const instructionPlanSchema = z.object({
  key: z.enum(INSTRUCTION_KEYS),
  phrasing: z.string().min(1),
  directive: z.string().min(1),
  scope: z.string().min(1),
  effects: z.array(effectPlanSchema),
  /** Null: every mailbox. */
  accountId: z.string().nullable(),
  /** All of the owner's words about this instruction, for the attribution record. */
  evidence: z.array(evidenceSchema),
  /** Why the effects are what they are, shown at review. */
  note: z.string(),
  confirmed: z.boolean(),
});

type InstructionPlan = z.infer<typeof instructionPlanSchema>;

const rowPlanSchema = z.object({
  factId: z.string().min(1),
  target: standingInstructionTargetSchema,
  storedPhrasing: z.string(),
  /** Who wrote the v1 row: the chat run, or the 2026-10-16 backfill. */
  writtenBy: z.string(),
  writtenOn: z.string(),
  group: z.enum(GROUP_KEYS).nullable(),
  result: z.enum(SENDER_RESULTS),
  why: z.string(),
  confirmed: z.boolean(),
});

type RowPlan = z.infer<typeof rowPlanSchema>;

const planSchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1),
  userEmail: z.string().min(1),
  createdAt: z.string(),
  /** Set when the owner confirmed every row and every instruction. */
  reviewedAt: z.string().nullable(),
  rows: z.array(rowPlanSchema),
  instructions: z.array(instructionPlanSchema),
});

type Plan = z.infer<typeof planSchema>;

const POLYLANE_SMALLCASE_SENDERS = new Set([
  "mail@mail.polylane.com",
  "notifications@smallcase.com",
]);

/** Brokers, depositories, exchanges, and registrars of the investment sentence. */
const INVESTMENT_DOMAINS = [
  "zerodha.net",
  "zerodha.com",
  "nse.co.in",
  "bseindia.in",
  "cdslindia.co.in",
  "nsdl.com",
  "mpms.mufg.com",
];

function targetSender(target: StandingInstructionTarget): string {
  return target.kind === "sender_email" ? target.email : target.domain;
}

function targetDomain(target: StandingInstructionTarget): string | null {
  return target.kind === "sender_domain" ? target.domain : emailDomain(target.email);
}

function underDomain(domain: string | null, parents: readonly string[]): boolean {
  return domain !== null && parents.some((p) => domain === p || domain.endsWith(`.${p}`));
}

function proposeRow(
  row: Omit<RowPlan, "group" | "result" | "why" | "confirmed">,
): Pick<RowPlan, "group" | "result" | "why"> {
  const sender = targetSender(row.target);

  if (row.target.kind === "sender_email" && POLYLANE_SMALLCASE_SENDERS.has(sender)) {
    return {
      group: "polylane_smallcase",
      result: "sender_filter",
      why:
        "The 2026-09-26 words name this sender. The owner chose a scoped instruction with a " +
        "sender filter on 2026-10-30, not a sender-wide target.",
    };
  }

  if (underDomain(targetDomain(row.target), INVESTMENT_DOMAINS)) {
    const misfiled = row.storedPhrasing.toLowerCase().startsWith("same for smallcase")
      ? " The 2026-10-16 backfill (#1229) stored the Smallcase words on this row by mistake: " +
        "this sender is a registrar, so it belongs to the investment instruction."
      : "";

    return {
      group: "investment",
      result: "remove",
      why:
        "An investment sender (broker, depository, exchange, or registrar). The words name a " +
        `class, so the scope decides and the sender is removed (ADR-0113).${misfiled}`,
    };
  }

  return {
    group: null,
    result: "remove",
    why: "Not a known sender of either sentence. Choose a group before the commit.",
  };
}

function effect(kind: EffectPlan["kind"], ...because: Evidence[]): EffectPlan {
  return { kind, because, ownerAdded: false };
}

function proposeInstructions(accountIdOf: (group: GroupKey) => string | null): InstructionPlan[] {
  const w = WORDS;

  return [
    {
      key: "investment",
      phrasing: quote(w.investmentSept8, w.investmentOct30),
      directive:
        "Investment and stock-market mail is low priority for the user: do not mark it urgent " +
        "or action needed, do not suggest a todo for it, do not treat its meeting or e-voting " +
        "notices as the user's concern, and keep it out of the briefing priority.",
      scope:
        "Investment and stock-market mail: brokers, depositories, exchanges, registrars and " +
        "transfer agents (for example KFintech, CAMS, MUFG Intime), mutual funds, dividend and " +
        "TDS notices, AGM and e-voting notices, statements, and contract notes. Not bank mail, " +
        "such as bank fraud, security, or login alerts.",
      effects: [
        effect(
          "demote_demand",
          { ...w.investmentSept8, words: "not to tag stocks related emails as urgent" },
          { ...w.investmentJune, words: "we might as well place them in fyi" },
          { ...w.investmentOct30, words: "are not important" },
        ),
        effect(
          "block_todo_suggestion",
          {
            ...w.investmentJune,
            words: "Manufactured urgency should not be considered as a to do",
          },
          { ...w.investmentOct30, words: "are not important" },
        ),
        effect(
          "demote_meeting",
          {
            ...w.investmentSept8,
            words: "if there's any meetings etc scheduled, none of my concern",
          },
          { ...w.investmentSept11, words: "not to tag stocks/investments meetings related emails" },
        ),
        effect(
          "exclude_briefing_priority",
          { ...w.investmentSept16, words: "to not surface these emails as important" },
          { ...w.investmentOct30, words: "are not important" },
        ),
      ],
      accountId: accountIdOf("investment"),
      evidence: [
        w.investmentJune,
        w.investmentSept8,
        w.investmentSept11,
        w.investmentSept16,
        w.investmentOct30,
      ],
      note:
        "The owner dropped the 2026-09-11 'genuinely urgent' escape on 2026-10-30, and the " +
        "scope leaves banking out. A calendar event is not mail, so the meeting words are not " +
        "enforced for it.",
      confirmed: false,
    },
    {
      key: "investment_exception",
      // The match prompt shows `phrasing` as the user's words, so it holds only the exception
      // clause. The full sentence leads with the investment clause; it stays in `evidence`.
      phrasing: quote({
        ...w.investmentOct30,
        words: "unless it's from the income tax deptt. or some legal matter",
      }),
      directive:
        "Investment mail from the Income Tax Department, or investment mail about a legal " +
        "matter, keeps its normal priority.",
      scope:
        "Investment or stock-market mail that comes from the Income Tax Department or that is " +
        "about a legal case or legal notice to the user, but not a routine AGM, e-voting, or " +
        "dividend notice.",
      effects: [],
      accountId: accountIdOf("investment"),
      evidence: [w.investmentOct30],
      note:
        "No effects on purpose. On mail that both match, a matched exception cancels each " +
        "lowering effect of instruction 1 on any cover (plan decision 10, " +
        "`exceptionCancels` in triage/floors/standing.ts). The mail keeps its model verdict. " +
        "The words hold only the exception clause, because the match prompt shows them; the " +
        "full 2026-10-30 sentence is the evidence in the source meta.",
      confirmed: false,
    },
    {
      key: "polylane_smallcase",
      phrasing: quote(w.polylane, w.smallcase),
      directive:
        "Polylane reminders to connect integrations or tools, and Smallcase rebalance updates, " +
        "are not urgent or action needed: suggest no todo for them and keep them out of the " +
        "briefing priority.",
      scope:
        "Polylane mail that asks the user to connect integrations or tools, and Smallcase " +
        "rebalance updates.",
      effects: [
        effect(
          "demote_demand",
          { ...w.polylane, words: "stop marking em urgent" },
          { ...w.smallcase, words: "remove action items from this and polylane" },
        ),
        effect("block_todo_suggestion", {
          ...w.smallcase,
          words: "remove action items from this and polylane",
        }),
        effect("exclude_briefing_priority", {
          ...w.polylane,
          words: "stop reminding me about connecting stuff to polylane",
        }),
      ],
      accountId: accountIdOf("polylane_smallcase"),
      evidence: [w.polylane, w.smallcase],
      note:
        "Scoped, not sender-wide: other Polylane or Smallcase mail keeps its model verdict. " +
        "No block_reply_draft: the words do not ask for it.",
      confirmed: false,
    },
  ];
}

// ─── Reads ──────────────────────────────────────────────────────────────────

interface V1Row {
  factId: string;
  target: StandingInstructionTarget;
  phrasing: string;
  writtenBy: string;
  writtenOn: string;
}

const sourceSchema = z
  .object({
    kind: z.string().optional(),
    meta: z
      .object({
        runId: z.string().optional(),
        via: z.string().optional(),
        issue: z.number().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

function describeSource(source: unknown): string {
  const parsed = sourceSchema.safeParse(source);

  if (!parsed.success) return "unknown";

  const meta = parsed.data.meta;

  if (meta?.via === "backfill") return `backfill #${meta.issue ?? "?"}`;

  return meta?.runId ? `chat run ${meta.runId}` : (parsed.data.kind ?? "unknown");
}

function activeInstructionWhere(userId: string) {
  return and(
    eq(userFacts.userId, userId),
    eq(userFacts.key, STANDING_INSTRUCTION_KEY),
    eq(userFacts.status, "confirmed"),
    isNull(userFacts.validUntil),
  );
}

/** Every live v1 row, read at run time. */
async function readV1Rows(userId: string): Promise<V1Row[]> {
  const rows = await db()
    .select({
      id: userFacts.id,
      value: userFacts.value,
      source: userFacts.source,
      validFrom: userFacts.validFrom,
    })
    .from(userFacts)
    .where(activeInstructionWhere(userId))
    .orderBy(desc(userFacts.validFrom));

  return rows.flatMap((row): V1Row[] => {
    const v1 = standingInstructionValueSchema.safeParse(row.value);

    if (!v1.success) return [];

    return [
      {
        factId: row.id,
        target: v1.data.target,
        phrasing: v1.data.phrasing,
        writtenBy: describeSource(row.source),
        writtenOn: row.validFrom.toISOString().slice(0, 10),
      },
    ];
  });
}

const MIGRATION_KEY = "adr-0113-v1-to-v2";

const migrationMetaSchema = z
  .object({ meta: z.object({ migration: z.string(), group: z.enum(INSTRUCTION_KEYS) }).loose() })
  .loose();

interface MigratedInstruction {
  factId: string;
  value: StandingInstructionValueV2;
}

/**
 * The active v2 rows that an earlier run of this script wrote, by key. The source `meta` marks
 * them, so a rerun after a partial write revises the same instruction and never adds a second.
 */
async function readMigratedInstructions(
  userId: string,
): Promise<Map<InstructionKey, MigratedInstruction>> {
  const rows = await db()
    .select({ id: userFacts.id, value: userFacts.value, source: userFacts.source })
    .from(userFacts)
    .where(
      and(
        activeInstructionWhere(userId),
        sql`${userFacts.source}->'meta'->>'migration' = ${MIGRATION_KEY}`,
      ),
    );

  const out = new Map<InstructionKey, MigratedInstruction>();

  for (const row of rows) {
    const meta = migrationMetaSchema.safeParse(row.source);
    const value = standingInstructionValueV2Schema.safeParse(row.value);

    if (!meta.success || !value.success) continue;

    if (out.has(meta.data.meta.group)) {
      throw new Error(
        `two active migrated instructions for ${meta.data.meta.group}; resolve by hand first`,
      );
    }

    out.set(meta.data.meta.group, { factId: row.id, value: value.data });
  }

  return out;
}

async function findUser(): Promise<{ id: string; email: string }> {
  const [u] = await db()
    .select({ id: userTable.id, email: userTable.email })
    .from(userTable)
    .where(eq(userTable.email, TARGET_EMAIL))
    .limit(1);

  if (!u) throw new Error(`no user row for ${TARGET_EMAIL}`);

  return u;
}

// ─── The plan: build, load, save ────────────────────────────────────────────

/** One mailbox when every row of the group agrees on it, else every mailbox. */
function commonAccountId(rows: readonly V1Row[], group: GroupKey): string | null {
  const ids = new Set(
    rows
      .filter((row) => proposeRow(rowBase(row)).group === group)
      .map((row) => row.target.accountId),
  );

  const [only] = ids;

  return ids.size === 1 && only !== undefined ? only : null;
}

function rowBase(row: V1Row): Omit<RowPlan, "group" | "result" | "why" | "confirmed"> {
  return {
    factId: row.factId,
    target: row.target,
    storedPhrasing: row.phrasing,
    writtenBy: row.writtenBy,
    writtenOn: row.writtenOn,
  };
}

async function loadPlan(): Promise<Plan | null> {
  const raw = await readFile(PLAN_PATH, "utf8").catch(() => null);

  if (raw === null) return null;

  return planSchema.parse(JSON.parse(raw));
}

async function savePlan(plan: Plan): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(PLAN_PATH, `${JSON.stringify(plan, null, 2)}\n`);
}

/**
 * The saved review, with each v1 row that is live now. A saved decision stays for a row that is
 * still live; a new row gets a proposal; a row that is gone drops, unless an earlier commit
 * closed it, which the commit checks.
 */
function mergePlan(
  saved: Plan | null,
  user: { id: string; email: string },
  live: readonly V1Row[],
): Plan {
  const savedRows = new Map(saved?.rows.map((row) => [row.factId, row]));

  const rows = live.map((row): RowPlan => {
    const kept = savedRows.get(row.factId);

    return kept ?? { ...rowBase(row), ...proposeRow(rowBase(row)), confirmed: false };
  });

  // Rows an earlier partial commit closed stay in the plan, so a rerun still closes nothing new.
  const closed = saved?.rows.filter((row) => !live.some((l) => l.factId === row.factId)) ?? [];

  return {
    version: 1,
    userId: user.id,
    userEmail: user.email,
    createdAt: saved?.createdAt ?? new Date().toISOString(),
    reviewedAt: rows.every((row) => savedRows.get(row.factId)?.confirmed === true)
      ? (saved?.reviewedAt ?? null)
      : null,
    rows: [...rows, ...closed],
    instructions:
      saved?.instructions ?? proposeInstructions((group) => commonAccountId(live, group)),
  };
}

function instructionOf(plan: Plan, key: InstructionKey): InstructionPlan {
  const found = plan.instructions.find((instruction) => instruction.key === key);

  if (!found) throw new Error(`the plan has no ${key} instruction`);

  return found;
}

/** The capture input of one instruction, parsed by the `system.remember` schema. */
function captureInput(
  plan: Plan,
  key: InstructionKey,
  extra: Pick<
    SaveStandingInstructionInput,
    "instructionId" | "expectedRevision" | "exceptionOf" | "replaces" | "coexistsWith"
  >,
): { ok: true; input: SaveStandingInstructionInput } | { ok: false; message: string } {
  const instruction = instructionOf(plan, key);
  const group = key === "investment_exception" ? null : key;

  const senders = (result: RowPlan["result"]) =>
    plan.rows
      .filter((row) => row.group === group && row.result === result)
      .map((row) => targetSender(row.target));

  const targets = senders("target");
  const senderFilter = senders("sender_filter");

  const parsed = rememberInput.safeParse({
    kind: "standing_instruction",
    phrasing: instruction.phrasing,
    directive: instruction.directive,
    scope: instruction.scope,
    ...(targets.length > 0 ? { targets } : {}),
    ...(senderFilter.length > 0 ? { senderFilter } : {}),
    effects: instruction.effects.map((e) => e.kind),
    ...(instruction.accountId === null ? {} : { accountId: instruction.accountId }),
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((i) => i.message).join("; ") };
  }

  const { kind: _kind, ...input } = parsed.data;

  return { ok: true, input };
}

const PREVIEW_IDS = {
  investment: "preview_investment",
  investment_exception: "preview_investment_exception",
  polylane_smallcase: "preview_polylane_smallcase",
} as const satisfies Record<InstructionKey, string>;

/** The values capture would store, with preview ids, for a match over stored mail. */
function previewInstructions(plan: Plan): ActiveStandingInstruction[] {
  const now = Date.now();

  return INSTRUCTION_KEYS.map((key, index) => {
    const built = captureInput(
      plan,
      key,
      key === "investment_exception" ? { exceptionOf: PREVIEW_IDS.investment } : {},
    );

    if (!built.ok) throw new Error(`${key}: ${built.message}`);

    const preview = previewStandingInstructionValue(built.input, PREVIEW_IDS[key]);

    if (!preview.ok) throw new Error(`${key}: ${preview.message}`);

    // Oldest first in plan order, so the later write wins a conflict as it would after commit.
    return { factId: `preview:${key}`, value: preview.value, validFrom: new Date(now + index) };
  });
}

function keyOfPreviewId(id: string): InstructionKey | null {
  return INSTRUCTION_KEYS.find((key) => PREVIEW_IDS[key] === id) ?? null;
}

// ─── Printing ───────────────────────────────────────────────────────────────

function printRow(row: RowPlan, index: number, total: number): void {
  const mailbox = row.target.accountId ?? "every mailbox";

  console.log(
    `\n[${index + 1}/${total}] ${row.factId}  ${row.target.kind}  ${targetSender(row.target)}  (${mailbox})`,
  );
  console.log(`  stored words: "${row.storedPhrasing}"`);
  console.log(`  written by:   ${row.writtenBy} on ${row.writtenOn}`);
  console.log(
    `  group: ${row.group ?? "NONE"}   sender result: ${row.result}${row.confirmed ? "   (confirmed)" : ""}`,
  );
  console.log(`  why: ${row.why}`);
}

function printInstruction(plan: Plan, instruction: InstructionPlan): void {
  const n = INSTRUCTION_KEYS.indexOf(instruction.key) + 1;
  const group = instruction.key === "investment_exception" ? null : instruction.key;

  const named = (result: RowPlan["result"]) =>
    plan.rows
      .filter((row) => row.group === group && row.result === result)
      .map((row) => targetSender(row.target));

  console.log(
    `\n=== Instruction ${n}: ${instruction.key}${instruction.confirmed ? " (confirmed)" : ""} ===`,
  );
  console.log(`  words:        ${instruction.phrasing}`);
  console.log(`  directive:    ${instruction.directive}`);
  console.log(`  scope:        ${instruction.scope}`);
  console.log(`  targets:      ${named("target").join(", ") || "none"}`);
  console.log(`  senderFilter: ${named("sender_filter").join(", ") || "none"}`);
  console.log(`  mailbox:      ${instruction.accountId ?? "every mailbox"}`);

  if (instruction.key === "investment_exception") {
    console.log("  exceptionOf:  instruction 1 (investment)");
  }

  console.log(`  effects:${instruction.effects.length === 0 ? " none" : ""}`);

  for (const [i, e] of instruction.effects.entries()) {
    const why = e.ownerAdded
      ? "added by the owner"
      : e.because.map((b) => `"${b.words}" (${b.date}, ${b.source})`).join("; ");

    console.log(`    ${i + 1}. ${e.kind}: ${why}`);
  }

  console.log(`  note: ${instruction.note}`);
  console.log("  evidence:");

  for (const e of instruction.evidence) console.log(`    ${e.date} (${e.source}): "${e.words}"`);
}

function printPlan(plan: Plan): void {
  console.log(`# Plan ${PLAN_PATH}`);
  console.log(`# user=${plan.userEmail} reviewedAt=${plan.reviewedAt ?? "not yet"}`);
  console.log(
    "# Decided by the owner on 2026-10-30: banking is outside the investment scope, and the " +
      `2026-09-11 directive edit ("If a message is genuinely urgent … it may be surfaced") is dropped.`,
  );

  for (const instruction of plan.instructions) printInstruction(plan, instruction);

  for (const [index, row] of plan.rows.entries()) printRow(row, index, plan.rows.length);
}

/** Every reason the plan cannot be committed. Empty when it can. */
function planProblems(plan: Plan): string[] {
  const problems: string[] = [];

  for (const row of plan.rows) {
    if (!row.confirmed) problems.push(`${row.factId}: not confirmed`);

    if (row.group === null) problems.push(`${row.factId}: no group`);
  }

  for (const instruction of plan.instructions) {
    if (!instruction.confirmed) problems.push(`${instruction.key}: not confirmed`);

    if (DROPPED_DIRECTIVE_EDIT.test(instruction.directive)) {
      problems.push(`${instruction.key}: the directive holds the dropped 'genuinely urgent' edit`);
    }
  }

  for (const key of INSTRUCTION_KEYS) {
    const built = captureInput(
      plan,
      key,
      key === "investment_exception" ? { exceptionOf: "x" } : {},
    );

    if (!built.ok) problems.push(`${key}: ${built.message}`);
  }

  if (plan.reviewedAt === null) problems.push("the review is not finished");

  return problems;
}

// ─── Interactive review ─────────────────────────────────────────────────────

const interactive = process.stdin.isTTY && process.stdout.isTTY;

async function ask(rl: Interface, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
}

/** Returns false when the owner chose to save and stop. */
async function reviewRow(rl: Interface, plan: Plan, row: RowPlan, index: number): Promise<boolean> {
  for (;;) {
    printRow(row, index, plan.rows.length);

    const answer = await ask(
      rl,
      "  Enter = confirm. g = switch group. r = remove. t = target. f = sender filter. q = save and stop: ",
    );

    switch (answer) {
      case "":
        if (row.group === null) {
          console.log("  ! choose a group first (g)");
          continue;
        }

        row.confirmed = true;

        return true;
      case "q":
        return false;
      case "g":
        row.group = row.group === "investment" ? "polylane_smallcase" : "investment";
        row.why = `Group set by the owner at review. ${row.why}`;
        break;
      case "r":
      case "t":
      case "f":
        row.result = answer === "r" ? "remove" : answer === "t" ? "target" : "sender_filter";

        if (answer === "t") {
          console.log(
            "  ! A target is sender-wide. Use it only if the owner's words name this sender (ADR-0113).",
          );
        }

        break;
      default:
        console.log("  ! unknown answer");
    }

    row.confirmed = false;
  }
}

async function reviewInstruction(
  rl: Interface,
  plan: Plan,
  instruction: InstructionPlan,
): Promise<boolean> {
  for (;;) {
    printInstruction(plan, instruction);

    const answer = await ask(
      rl,
      "  Enter = confirm. s = new scope. w = new directive. d<N> = drop effect N. a = add an effect. q = save and stop: ",
    );

    if (answer === "") {
      if (DROPPED_DIRECTIVE_EDIT.test(instruction.directive)) {
        console.log("  ! the directive holds the dropped 'genuinely urgent' edit");
        continue;
      }

      instruction.confirmed = true;

      return true;
    }

    if (answer === "q") return false;

    instruction.confirmed = false;

    if (answer === "s" || answer === "w") {
      const text = await ask(rl, "  one line: ");

      if (text.length === 0) continue;

      if (answer === "s") instruction.scope = text;
      else instruction.directive = text;

      continue;
    }

    const drop = /^d(\d+)$/.exec(answer);

    if (drop) {
      const position = Number.parseInt(drop[1] ?? "", 10) - 1;

      if (position >= 0 && position < instruction.effects.length) {
        instruction.effects.splice(position, 1);
      }

      continue;
    }

    if (answer === "a") {
      const missing = PLAN_EFFECT_KINDS.filter(
        (kind) => !instruction.effects.some((e) => e.kind === kind),
      );

      console.log(`  effects you can add: ${missing.join(", ")}`);

      const kind = z.enum(PLAN_EFFECT_KINDS).safeParse(await ask(rl, "  effect: "));

      if (kind.success && missing.includes(kind.data)) {
        instruction.effects.push({ kind: kind.data, because: [], ownerAdded: true });
      }

      continue;
    }

    console.log("  ! unknown answer");
  }
}

async function review(plan: Plan): Promise<void> {
  if (!interactive) {
    printPlan(plan);
    console.log(
      `\n# Not a terminal: the plan is saved at ${PLAN_PATH}. Run again in a terminal to review ` +
        "each row, or edit the file and set `confirmed` and `reviewedAt` by hand.",
    );

    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log(
      "# Decided by the owner on 2026-10-30: banking is outside the investment scope, and the " +
        "2026-09-11 'genuinely urgent' directive edit is dropped.",
    );

    for (const instruction of plan.instructions) {
      if (instruction.confirmed) continue;

      const go = await reviewInstruction(rl, plan, instruction);

      await savePlan(plan);

      if (!go) return;
    }

    for (const [index, row] of plan.rows.entries()) {
      if (row.confirmed) continue;

      const go = await reviewRow(rl, plan, row, index);

      await savePlan(plan);

      if (!go) return;
    }

    const all =
      plan.rows.every((row) => row.confirmed) && plan.instructions.every((i) => i.confirmed);

    if (all) {
      plan.reviewedAt = new Date().toISOString();
      await savePlan(plan);
      console.log(`\n# Review finished at ${plan.reviewedAt}.`);
    }
  } finally {
    rl.close();
  }
}

// ─── Model-call commands: cost and consent ─────────────────────────────────

/** The mean cost of recent calls with one of these purposes, or null with no history. */
async function meanCallCost(purposes: readonly string[]): Promise<number | null> {
  const recent = db()
    .select({ cost: apiCallLog.costUsd })
    .from(apiCallLog)
    .where(inArray(sql<string>`${apiCallLog.requestMeta}->>'purpose'`, [...purposes]))
    .orderBy(desc(apiCallLog.id))
    .limit(200)
    .as("recent");

  const [row] = await db()
    .select({ mean: sql<string | null>`avg(${recent.cost})` })
    .from(recent);

  const mean = row?.mean ? Number(row.mean) : null;

  return mean !== null && Number.isFinite(mean) ? mean : null;
}

async function consent(what: string, calls: number, purposes: readonly string[]): Promise<boolean> {
  const mean = await meanCallCost(purposes);

  const estimate =
    mean === null
      ? "no cost history for these calls"
      : `about $${(mean * calls).toFixed(4)} (mean of recent ${purposes.join(", ")} calls)`;

  console.log(
    `# ${what}: at most ${calls} cheap-model call(s), hard cap ${MODEL_CALL_HARD_CAP}. Estimate: ${estimate}.`,
  );

  if (YES) return true;

  if (!interactive) {
    console.log("# Not a terminal: pass --yes to accept the cost.");

    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return (await ask(rl, "# Continue? (y/N): ")).toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

// ─── Stored mail ───────────────────────────────────────────────────────────

interface StoredMail {
  documentId: string;
  sourceThreadId: string | null;
  sender: string | null;
  accountId: string | null;
  subject: string;
  authoredAt: Date | null;
  storedCategory: TriageCategory | null;
}

/** Inbound Gmail mail of the user, newest first, with the stored category of its own row. */
async function readStoredMail(userId: string, since: Date | null): Promise<StoredMail[]> {
  const rows = await db()
    .select({
      documentId: documents.id,
      sourceThreadId: documents.sourceThreadId,
      accountId: documents.accountId,
      metadata: documents.metadata,
      title: documents.title,
      authoredAt: documents.authoredAt,
      triageDocumentId: emailTriage.documentId,
      category: emailTriage.category,
    })
    .from(documents)
    .leftJoin(
      emailTriage,
      and(
        eq(emailTriage.userId, documents.userId),
        eq(emailTriage.sourceThreadId, documents.sourceThreadId),
      ),
    )
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        notSentGmailDocumentWhere(),
        ...(since ? [gte(documents.ingestedAt, since)] : []),
      ),
    )
    .orderBy(desc(documents.authoredAt), desc(documents.id));

  return rows.map((row) => ({
    documentId: row.documentId,
    sourceThreadId: row.sourceThreadId,
    sender: normalizeEmailAddress(parseGmailDocumentMetadata(row.metadata).from ?? null),
    accountId: row.accountId,
    subject: (row.title ?? "(no subject)").replace(/\s+/g, " ").slice(0, 90),
    authoredAt: row.authoredAt,
    storedCategory: row.triageDocumentId === row.documentId ? row.category : null,
  }));
}

function day(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "----------";
}

// ─── check-removed ─────────────────────────────────────────────────────────

function describePreview(state: StandingScopePreviewState | undefined): string {
  if (!state) return "unknown";

  switch (state.state) {
    case "matched":
      return `matched (covers ${state.covers}: ${state.reason})`;
    case "not_matched":
    case "target":
    case "not_candidate":
    case "unknown":
      return state.state;
    default: {
      const exhaustive: never = state;

      return String(exhaustive);
    }
  }
}

/**
 * Before commit (ADR-0113): for each removed sender, the stored mail from it that the proposed
 * scope rejects. A `covers part` match counts too, because a lowering effect needs full cover.
 */
async function checkRemoved(plan: Plan): Promise<void> {
  const removed = plan.rows.filter((row) => row.result === "remove" && row.group !== null);
  const perSender = Number.parseInt(flag("per-sender") ?? "10", 10);
  const limit = callLimit(120);
  const mail = await readStoredMail(plan.userId, null);

  const bySender = removed.map((row) => ({
    row,
    mail: mail
      .filter((m) => m.sender !== null && targetMatchesSender(row.target, m.sender, m.accountId))
      .slice(0, perSender),
  }));

  const documentIds = [...new Set(bySender.flatMap((s) => s.mail.map((m) => m.documentId)))].slice(
    0,
    limit,
  );

  console.log(
    `# ${removed.length} removed sender(s); ${documentIds.length} stored mail(s) to check (at most ${perSender} per sender).`,
  );

  if (documentIds.length === 0) return;

  if (!(await consent("check-removed", documentIds.length, ["triage.standing_rematch"]))) return;

  const previews = await previewStandingScopeMatches({
    userId: plan.userId,
    documentIds,
    instructions: previewInstructions(plan),
  });

  const byDocument = new Map(previews.map((p) => [p.documentId, p]));
  const report: unknown[] = [];

  for (const { row, mail: senderMail } of bySender) {
    const group = row.group;

    if (group === null) continue;

    console.log(`\n## ${targetSender(row.target)} → ${group} (${senderMail.length} stored mail)`);

    let kept = 0;

    for (const m of senderMail) {
      const preview = byDocument.get(m.documentId);

      if (!preview) continue;

      const own = preview.results.find((r) => keyOfPreviewId(r.instructionId) === group);

      const exception = preview.results.find(
        (r) => keyOfPreviewId(r.instructionId) === "investment_exception",
      );

      const lowered = own?.state === "matched" && own.covers === "all";
      const cancelled = group === "investment" && lowered && exception?.state === "matched";

      report.push({
        sender: targetSender(row.target),
        group,
        documentId: m.documentId,
        date: day(m.authoredAt),
        subject: m.subject,
        storedCategory: m.storedCategory,
        result: describePreview(own),
        exception: group === "investment" ? describePreview(exception) : null,
        error: preview.error,
      });

      if (lowered && !cancelled) {
        kept += 1;
        continue;
      }

      const why = cancelled
        ? `matched, but the exception cancels it: ${describePreview(exception)}`
        : `${describePreview(own)}${preview.error ? ` (call failed: ${preview.error})` : ""}`;

      console.log(`  ${day(m.authoredAt)}  ${m.storedCategory ?? "-"}  ${why}  ${m.subject}`);
    }

    console.log(`  → the instruction still lowers ${kept} of ${senderMail.length}.`);
  }

  await mkdir(DIR, { recursive: true });
  const path = resolve(DIR, `check-removed-${Date.now()}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n# Wrote ${path}`);
}

// ─── The rollout gate ──────────────────────────────────────────────────────

/** Senders that v1 missed (ADR-0113 fault 1). Selection only: they never define a label. */
const MISSED_INVESTMENT_DOMAINS = ["camsonline.com", "cdslstatement.com", "kfintech.com"];

const INVESTMENT_WORDS =
  /\b(dividend|e-?voting|agm|annual general meeting|contract note|demat|mutual fund|folio|tds|shareholder|holding statement|ipo|nav)\b/i;

const BANK_WORDS = /\b(bank|otp|login|sign-?in|fraud|debited|credited|upi|credit card)\b/i;

const TAX_LEGAL_WORDS = /\b(income tax|itr|26as|notice u\/s|legal|court|summons|arbitration)\b/i;

const labelSchema = z.object({
  /** The instructions that must match. `[]` means none may match. */
  expectedMatches: z.array(z.enum(INSTRUCTION_KEYS)),
  /** Unrelated mail: the model verdict must not move between the baseline and the candidate. */
  unrelated: z.boolean(),
  /** The effective category, or `any`. */
  expectedCategory: z.union([triageCategorySchema, z.literal("any")]),
  expectedTodo: z.enum(["none", "any"]),
  expectedBriefing: z.enum(["out_of_priority", "in_priority", "any"]),
  expectedReplyDraft: z.enum(["blocked", "allowed", "any"]),
});

const gateCaseSchema = z.object({
  documentId: z.string().min(1),
  sender: z.string().nullable(),
  date: z.string(),
  subject: z.string(),
  storedCategory: z.string().nullable(),
  selectedBecause: z.array(z.string()),
  /** The owner writes it. Null: not labeled yet. */
  label: labelSchema.nullable(),
});

const gateFileSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  userId: z.string(),
  help: z.array(z.string()),
  cases: z.array(gateCaseSchema),
});

type GateCase = z.infer<typeof gateCaseSchema>;

const LABEL_HELP = [
  "Label each case by hand from the mail itself. Never copy a label from a candidate run.",
  "Set `label` to an object: expectedMatches (a list of investment, investment_exception, polylane_smallcase),",
  "unrelated (true when no instruction is about the mail), expectedCategory (a triage category or any),",
  "expectedTodo (none or any), expectedBriefing (out_of_priority, in_priority, or any),",
  "expectedReplyDraft (blocked, allowed, or any). Delete a case to leave it out of the gate.",
  "Add cases by hand for the ADR product cases that this set does not hold.",
];

/** Writes the candidate labeled set. No model call, and every `label` is null. */
async function gateCandidates(plan: Plan): Promise<void> {
  const days = Number.parseInt(flag("days") ?? "120", 10);
  const perGroup = Number.parseInt(flag("per-group") ?? "25", 10);
  const since = new Date(Date.now() - days * 24 * 3_600_000);
  const mail = await readStoredMail(plan.userId, since);
  const v1Targets = plan.rows.map((row) => row.target);

  const groups = new Map<string, StoredMail[]>();
  const reasons = new Map<string, string[]>();

  const add = (reason: string, m: StoredMail) => {
    const list = groups.get(reason) ?? [];

    if (list.length >= perGroup) return;

    list.push(m);
    groups.set(reason, list);
    reasons.set(m.documentId, [...(reasons.get(m.documentId) ?? []), reason]);
  };

  for (const m of mail) {
    const domain = m.sender ? emailDomain(m.sender) : null;

    const v1 =
      m.sender !== null &&
      v1Targets.some((t) => targetMatchesSender(t, m.sender ?? "", m.accountId));

    if (m.sender !== null && POLYLANE_SMALLCASE_SENDERS.has(m.sender))
      add("polylane_smallcase_sender", m);
    else if (v1) add("v1_investment_sender", m);
    else if (underDomain(domain, MISSED_INVESTMENT_DOMAINS)) add("sender_v1_missed", m);
    else if (INVESTMENT_WORDS.test(m.subject)) add("investment_words", m);

    if (underDomain(domain, ["incometax.gov.in"]) || TAX_LEGAL_WORDS.test(m.subject)) {
      add("tax_or_legal_probe", m);
    }

    if (BANK_WORDS.test(m.subject)) add("bank_probe", m);
  }

  // Unrelated mail: the newest mail that no rule above selected.
  for (const m of mail) {
    if (!reasons.has(m.documentId)) add("unrelated_sample", m);
  }

  const cases: GateCase[] = mail
    .filter((m) => reasons.has(m.documentId))
    .map((m) => ({
      documentId: m.documentId,
      sender: m.sender,
      date: day(m.authoredAt),
      subject: m.subject,
      storedCategory: m.storedCategory,
      selectedBecause: reasons.get(m.documentId) ?? [],
      label: null,
    }));

  const existing = await readFile(LABELS_PATH, "utf8").catch(() => null);

  if (existing !== null && !FRESH) {
    console.log(`# ${LABELS_PATH} exists. Pass --fresh to replace it (the labels in it are lost).`);

    return;
  }

  await mkdir(DIR, { recursive: true });
  await writeFile(
    LABELS_PATH,
    `${JSON.stringify(
      gateFileSchema.parse({
        version: 1,
        generatedAt: new Date().toISOString(),
        userId: plan.userId,
        help: LABEL_HELP,
        cases,
      }),
      null,
      2,
    )}\n`,
  );

  console.log(`# Wrote ${cases.length} candidate case(s) to ${LABELS_PATH}`);

  for (const [reason, list] of groups) console.log(`  ${reason}: ${list.length}`);

  console.log("\n" + LABEL_HELP.join("\n"));
}

interface GateRun {
  modelCategory: TriageCategory;
  category: TriageCategory;
  matched: InstructionKey[];
  todo: boolean;
  briefingExcluded: boolean;
  replyDraftBlocked: boolean;
}

/**
 * The paired replay of one labeled mail: the baseline with the stored instruction set, and the
 * candidate with the v1 rows of the plan replaced by the proposed instructions. Writes nothing.
 */
async function replayCase(
  plan: Plan,
  documentId: string,
  candidateSet: ReturnType<typeof standingInstructionsOf>,
): Promise<{ baseline: GateRun; candidate: GateRun }> {
  const ctx = await loadTriageContext(documentId, plan.userId);

  if (!ctx) throw new Error("document is gone");

  const [doc] = await db()
    .select({ sourceThreadId: documents.sourceThreadId })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!doc?.sourceThreadId) throw new Error("document has no thread");

  const sender = extractSenderContext({
    fromHeader: ctx.document.metadata.from ?? null,
    subject: ctx.document.title,
    body: ctx.document.content,
  });

  const { observations } = await gatherObservations({
    userId: plan.userId,
    settings: settings({ userId: plan.userId }),
    documentId,
    sourceThreadId: doc.sourceThreadId,
    document: ctx.document,
    accountId: ctx.document.accountId,
    persona: ctx.persona,
    senderContext: sender.context,
    senderAddress: sender.senderAddress,
  });

  const candidateMail = candidateSet.forMail({
    sender: ctx.document.metadata.from ?? null,
    accountId: ctx.document.accountId,
  });

  const run = async (standing: typeof observations.standingInstructions): Promise<GateRun> => {
    const result = await classifyEmail({
      userId: plan.userId,
      identity: ctx.identity,
      document: {
        id: ctx.document.id,
        title: ctx.document.title,
        content: ctx.document.content,
        authoredAt: ctx.document.authoredAt,
        metadata: ctx.document.metadata,
      },
      senderContext: sender.context,
      observations: { ...observations, standingInstructions: standing },
      maxRetries: 1,
      hedgeDelayMs: 0,
    });

    const effective =
      standing?.kind === "loaded"
        ? deriveEffectiveTriage({
            triage: {
              documentId,
              category: result.classification.category,
              documentAsk: result.classification.documentAsk ?? null,
              todoSuggestion: result.classification.todoSuggestion ?? null,
              todoDecision: result.classification.todoDecision ?? null,
              modelVerdict: result.modelVerdict,
              instructionEvaluation: result.instructionEvaluation,
            },
            documentId,
            instructions: standing,
          })
        : null;

    return {
      modelCategory: result.modelVerdict.category,
      category: effective?.result?.category ?? result.classification.category,
      matched: (effective?.matches ?? []).flatMap((m) => {
        const key = keyOfPreviewId(m.value.instructionId);

        return key ? [key] : [];
      }),
      todo: (effective?.result?.todoSuggestion ?? result.classification.todoSuggestion) != null,
      briefingExcluded: effective?.briefingPriority?.effect === "exclude_briefing_priority",
      replyDraftBlocked: effective?.replyDraftBlockedBy != null,
    };
  };

  return {
    baseline: await run(observations.standingInstructions),
    candidate: await run(candidateMail),
  };
}

const PRIORITY: ReadonlySet<string> = new Set(PRIORITY_CATEGORIES);

function gateFailures(
  label: z.infer<typeof labelSchema>,
  pair: { baseline: GateRun; candidate: GateRun },
): string[] {
  const { baseline, candidate } = pair;
  const failures: string[] = [];
  const expected = [...label.expectedMatches].sort().join(",");
  const got = [...new Set(candidate.matched)].sort().join(",");

  if (expected !== got) failures.push(`matches: expected [${expected}] got [${got}]`);

  if (label.unrelated && baseline.modelCategory !== candidate.modelCategory) {
    failures.push(`model verdict moved: ${baseline.modelCategory} → ${candidate.modelCategory}`);
  }

  if (label.expectedCategory !== "any" && label.expectedCategory !== candidate.category) {
    failures.push(`category: expected ${label.expectedCategory} got ${candidate.category}`);
  }

  if (label.expectedTodo === "none" && candidate.todo) failures.push("todo: expected none");

  const inPriority = PRIORITY.has(candidate.category) && !candidate.briefingExcluded;

  if (
    label.expectedBriefing !== "any" &&
    (label.expectedBriefing === "in_priority") !== inPriority
  ) {
    failures.push(`briefing: expected ${label.expectedBriefing}`);
  }

  if (
    label.expectedReplyDraft !== "any" &&
    (label.expectedReplyDraft === "blocked") !== candidate.replyDraftBlocked
  ) {
    failures.push(`reply draft: expected ${label.expectedReplyDraft}`);
  }

  return failures;
}

async function gateCheck(plan: Plan): Promise<void> {
  const raw = await readFile(LABELS_PATH, "utf8").catch(() => null);

  if (raw === null) {
    console.log(`# No ${LABELS_PATH}. Run gate-candidates and label it first.`);

    return;
  }

  const file = gateFileSchema.parse(JSON.parse(raw));
  const unlabeled = file.cases.filter((c) => c.label === null);

  if (unlabeled.length > 0) {
    console.log(
      `# ${unlabeled.length} case(s) have no label. Label or delete them before the gate runs: ` +
        "the labels must exist before the candidate runs (ADR-0113, Rollout gate).",
    );

    return;
  }

  const cases = file.cases.slice(0, callLimit(150));

  // Two classify calls for each case, and a second pass when a pass conflicts.
  if (
    !(await consent("gate-check", cases.length * 2, [
      "triage.classify",
      "triage.classify.second_pass",
    ]))
  ) {
    return;
  }

  const planFactIds = new Set(plan.rows.map((row) => row.factId));
  const { instructions: stored } = await listStandingInstructions(plan.userId);

  const candidateSet = standingInstructionsOf([
    ...stored
      .filter((s) => !planFactIds.has(s.factId))
      .map((s) => ({ factId: s.factId, value: s.instruction, validFrom: s.validFrom })),
    ...previewInstructions(plan),
  ]);

  let passed = 0;
  const results: unknown[] = [];

  for (const [index, c] of cases.entries()) {
    const label = c.label;

    if (label === null) continue;

    try {
      const pair = await replayCase(plan, c.documentId, candidateSet);
      const failures = gateFailures(label, pair);

      if (failures.length === 0) passed += 1;

      results.push({ ...c, ...pair, failures });
      console.log(
        `${index + 1}/${cases.length} ${failures.length === 0 ? "PASS" : "FAIL"} ${c.date} ${c.subject}${failures.length ? `\n    ${failures.join("\n    ")}` : ""}`,
      );
    } catch (err) {
      results.push({ ...c, error: toMessage(err) });
      console.log(`${index + 1}/${cases.length} ERROR ${c.date} ${c.subject}: ${toMessage(err)}`);
    }
  }

  const path = resolve(DIR, `gate-check-${Date.now()}.json`);
  await writeFile(path, `${JSON.stringify(results, null, 2)}\n`);
  console.log(
    `\n# Gate: ${passed}/${cases.length} passed. ${passed === cases.length ? "The gate passes." : "The gate FAILS."} Wrote ${path}`,
  );
}

// ─── Commit ────────────────────────────────────────────────────────────────

const REPLACES_PER_CALL = 20;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];

  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));

  return out;
}

function migrationSource(plan: Plan, key: InstructionKey): MemorySource {
  const instruction = instructionOf(plan, key);

  return {
    kind: "user",
    meta: {
      via: "migration_script",
      migration: MIGRATION_KEY,
      group: key,
      // ADR-0115: the owner wrote it, at the keyboard, through this script's review.
      actor: "user",
      authority: "user_direct",
      review: "owner review in migrate-standing-instructions-v2-committed",
      reviewedAt: plan.reviewedAt ?? "",
      evidence: instruction.evidence.map((e) => ({ ...e })),
    },
  };
}

/**
 * Save one instruction through the capture operation. A migrated instruction that an earlier run
 * stored is revised in place: the same content returns `already_exists` and writes nothing.
 */
async function saveOne(args: {
  plan: Plan;
  key: InstructionKey;
  existing: MigratedInstruction | undefined;
  liveV1: readonly V1Row[];
  exceptionOf?: string;
  replaces?: string[];
}): Promise<StandingInstructionValueV2> {
  const { plan, key, existing } = args;
  const replaces = new Set(args.replaces);

  const draft = captureInput(
    plan,
    key,
    args.exceptionOf === undefined ? {} : { exceptionOf: args.exceptionOf },
  );

  if (!draft.ok) throw new Error(`${key}: ${draft.message}`);

  // A live v1 row that shares a sender with this instruction and that this call does not close.
  const preview = previewStandingInstructionValue(draft.input, "conflict_probe");

  if (!preview.ok) throw new Error(`${key}: ${preview.message}`);

  const named = [...preview.value.targets, ...(preview.value.senderFilter ?? [])];

  const coexistsWith = args.liveV1
    .filter(
      (row) =>
        !replaces.has(row.factId) &&
        named.some((of) => standingInstructionScopesIntersect({ of, relativeTo: row.target })),
    )
    .map((row) => row.factId);

  if (coexistsWith.length > REPLACES_PER_CALL) {
    throw new Error(`${key}: ${coexistsWith.length} related v1 rows; capture takes at most 20`);
  }

  const built = captureInput(plan, key, {
    ...(existing
      ? { instructionId: existing.value.instructionId, expectedRevision: existing.value.revision }
      : {}),
    ...(args.exceptionOf === undefined ? {} : { exceptionOf: args.exceptionOf }),
    ...(replaces.size > 0 ? { replaces: [...replaces] } : {}),
    ...(coexistsWith.length > 0 ? { coexistsWith } : {}),
  });

  if (!built.ok) throw new Error(`${key}: ${built.message}`);

  const result = await saveStandingInstruction({
    userId: plan.userId,
    input: built.input,
    source: migrationSource(plan, key),
  });

  if (!result.ok) {
    throw new Error(`${key}: ${result.status}: ${JSON.stringify(result)}`);
  }

  console.log(
    `  ${key}: ${result.status} fact=${result.factId} id=${result.instruction.instructionId} r${result.instruction.revision}` +
      `${replaces.size > 0 ? ` replaces=${replaces.size}` : ""}${result.relatedCount > 0 ? ` related=${result.relatedCount}` : ""}`,
  );

  return result.instruction;
}

/**
 * The todo sweep of chat capture, for an instruction with targets that blocks todos. The owner
 * is the actor. A default plan has no targets, so this does nothing.
 */
async function sweepTodos(userId: string, instruction: StandingInstructionValueV2): Promise<void> {
  const [first, ...rest] = instruction.targets;

  if (!first || !instruction.effects.some((e) => e.kind === "block_todo_suggestion")) return;

  const attribution: TodoAttribution = {
    actor: "user",
    authority: "user_direct",
    authorityRef: null,
    cause: "sender_suppressed",
    note: "ADR-0113 v1 migration: owner review in the migration script",
  };

  const result = await resolveTodosForGmailSource(
    { userId, targets: [first, ...rest] },
    attribution,
    {
      admitThreads: (sourceThreadIds) =>
        threadsWhereInstructionBlocksTodo({
          userId,
          instructionId: instruction.instructionId,
          sourceThreadIds,
        }),
    },
  );

  console.log(
    `  todo sweep ${instruction.instructionId}: ${result.ok ? `${result.status} ${result.dismissedCount}` : result.status}`,
  );
}

async function commit(plan: Plan): Promise<void> {
  const problems = planProblems(plan);

  if (problems.length > 0) {
    console.log(`# Commit refused. ${problems.length} problem(s):`);

    for (const p of problems) console.log(`  - ${p}`);

    return;
  }

  const live = await readV1Rows(plan.userId);
  const planIds = new Set(plan.rows.map((row) => row.factId));
  const unplanned = live.filter((row) => !planIds.has(row.factId));

  if (unplanned.length > 0) {
    console.log(
      `# Commit refused: ${unplanned.length} live v1 row(s) are not in the plan. Run the review again.`,
    );

    return;
  }

  const migrated = await readMigratedInstructions(plan.userId);
  const liveIds = new Set(live.map((row) => row.factId));
  const closedEarlier = plan.rows.filter((row) => !liveIds.has(row.factId));

  for (const row of closedEarlier) {
    if (row.group === null || !migrated.has(row.group)) {
      console.log(
        `# Commit refused: ${row.factId} is closed, but no migrated ${row.group ?? "?"} instruction exists. Someone else changed it.`,
      );

      return;
    }
  }

  printPlan(plan);

  if (!interactive && !YES) {
    console.log("\n# Not a terminal: pass --yes with --commit to write. Nothing written.");

    return;
  }

  if (interactive && !YES) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      if ((await ask(rl, "\n# Type 'commit' to write these instructions: ")) !== "commit") {
        console.log("# Nothing written.");

        return;
      }
    } finally {
      rl.close();
    }
  }

  const rowsOf = (group: GroupKey) =>
    plan.rows.filter((row) => row.group === group).map((row) => row.factId);

  console.log("\n# Writing");

  // 1. The investment instruction, beside the v1 rows. They close in step 4, after the exception
  //    exists, so a stop between steps never leaves the investment scope without its exception.
  const investment = await saveOne({
    plan,
    key: "investment",
    existing: migrated.get("investment"),
    liveV1: live,
  });

  // 2. The exception.
  await saveOne({
    plan,
    key: "investment_exception",
    existing: migrated.get("investment_exception"),
    liveV1: live,
    exceptionOf: investment.instructionId,
  });

  // 3. Polylane and Smallcase, which closes its own v1 rows in the same transaction.
  const polylane = await saveOne({
    plan,
    key: "polylane_smallcase",
    existing: migrated.get("polylane_smallcase"),
    liveV1: live,
    replaces: rowsOf("polylane_smallcase"),
  });

  // 4. The same investment content again: capture finds the duplicate and closes the rows.
  let current = investment;

  for (const replaces of chunks(rowsOf("investment"), REPLACES_PER_CALL)) {
    current = await saveOne({
      plan,
      key: "investment",
      existing: { factId: "", value: current },
      liveV1: await readV1Rows(plan.userId),
      replaces,
    });
  }

  await sweepTodos(plan.userId, current);
  await sweepTodos(plan.userId, polylane);

  const left = await readV1Rows(plan.userId);
  const stillLive = left.filter((row) => planIds.has(row.factId));

  console.log(
    stillLive.length === 0
      ? `\n# Done. No planned v1 row is live. ${left.length} other v1 row(s) are live.`
      : `\n# NOT DONE: ${stillLive.length} planned v1 row(s) are still live. Run --commit again.`,
  );
  console.log(
    "# The re-match sweep (every 60 s) brings the last 48 hours of mail up to the new set.",
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = COMMIT ? "COMMIT" : "DRY";

  console.log(
    `# ADR-0113 v1 → v2 migration — command=${COMMIT ? "commit" : COMMAND} mode=${mode} user=${TARGET_EMAIL}`,
  );

  const user = await findUser();
  const live = await readV1Rows(user.id);
  const saved = FRESH && COMMAND === "review" ? null : await loadPlan();

  if (saved && saved.userId !== user.id) throw new Error(`${PLAN_PATH} belongs to another user`);

  if (live.length === 0 && saved === null) {
    console.log("# No live v1 row and no saved plan: nothing to migrate.");

    return;
  }

  const plan = mergePlan(saved, user, live);

  console.log(
    `# ${live.length} live v1 row(s); ${plan.rows.length - live.length} closed by an earlier commit.`,
  );

  if (COMMIT) {
    await commit(plan);

    return;
  }

  await savePlan(plan);

  switch (COMMAND) {
    case "review":
      await review(plan);
      break;
    case "check-removed":
      await checkRemoved(plan);
      break;
    case "gate-candidates":
      await gateCandidates(plan);
      break;
    case "gate-check":
      await gateCheck(plan);
      break;
    default:
      throw new Error(`unknown command ${COMMAND}`);
  }

  const problems = planProblems(plan);

  console.log(
    problems.length === 0
      ? "\n# The plan is ready. Commit with --commit."
      : `\n# ${problems.length} item(s) left before a commit. Run the review again to finish.`,
  );
}

try {
  await main();
} catch (e) {
  // Message only: a serialized Error can leak DATABASE_URL.
  console.error(toMessage(e));
  process.exitCode = 1;
} finally {
  await closeScriptResources();
}
