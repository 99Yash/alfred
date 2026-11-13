/**
 * Tool input schemas, plus result shapes that web or model code depends on.
 * The dispatcher parses with them and the web approval view derives its form
 * from them (`tool-fields.ts`).
 *
 * Numbers use `z.coerce.number()`: models often send `pull_number: "305"`.
 * The JSON schema the model sees is still `{type:"integer"}`.
 */

import { z } from "zod";
import {
  activateWorkflowInputSchema,
  authorWorkflowInputSchema,
  authorableWorkflowDefinitionSchema,
  workflowCapabilityDisplaySchema,
  workflowRequiredCapabilitySchema,
} from "./agent";
import {
  ARTIFACT_EDITS_MAX,
  ARTIFACT_SECTION_MAX_CHARS,
  artifactFormatSchema,
  artifactKindSchema,
  artifactPageSchema,
  artifactTextEditSchema,
} from "./artifacts";
import { contextSearchRequestSchema } from "./context-search";
import { isRecord } from "./guards";
import { LOADABLE_INTEGRATION_SLUGS } from "./integrations/slugs";
import { safeJsonParse } from "./json";
import { mcpCallInput, mcpToolInspectInputSchema, mcpToolSearchInputSchema } from "./mcp";
import { restPassthroughRequestSchema } from "./passthrough";
import { STANDING_INSTRUCTION_CAPTURE_EFFECT_KINDS } from "./standing-instructions";
import { LIVE_TODO_STATUSES, TODO_STATUSES, todoSourceSchema } from "./todos";
import { triageCategorySchema } from "./triage";
import type { ToolName } from "./tools";

/** Zod's email check emits lookahead, which OpenAI rejects in tool parameters. */
const MODEL_TOOL_EMAIL_PATTERN =
  /^[A-Za-z0-9_'+-]+(?:\.[A-Za-z0-9_'+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

function modelToolEmail() {
  return z.string().regex(MODEL_TOOL_EMAIL_PATTERN, "Invalid email address");
}

/**
 * Input tolerance runs in two layers before strict validation:
 * 1. Dispatch `normalizeToolInputKeys`: lossless case and `_`/`-` key fixes for all tools.
 * 2. The per-tool preprocess wrappers in this file (aliases, blank fields, JSON-string
 *    arrays, scalar recipients).
 * `z.toJSONSchema(schema, { io: "input" })` unwraps them, so the model and the
 * approval view see only the canonical fields.
 */

/** Same canon as dispatch's `normalizeToolInputKeys`: lowercase, no `_` or `-`. */
export const canonicalParamKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, "");

/** Accept `query` for `q` and the reverse: models mix up the two across tools. */
function withQueryAlias<S extends z.ZodType>(canonical: "q" | "query", schema: S) {
  const alias = canonical === "q" ? "query" : "q";

  return z.preprocess((value) => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a `z.preprocess` callback on raw model input; the string arm is the alias check inside the owning schema.
    if (isRecord(value) && typeof value[alias] === "string") {
      const rest = { ...value };

      if (!(canonical in rest)) rest[canonical] = rest[alias];
      delete rest[alias];

      return rest;
    }

    return value;
  }, schema);
}

/**
 * Rename curated 1:1 synonyms (`body` to `bodyText`, `limit` to `perPage`). The
 * alias is always removed; if the canonical key is also set, the canonical wins.
 * Matches the alias case-insensitively: dispatch only normalizes toward accepted
 * keys, so `Limit` would get through. Targets must be the object's own keys.
 */
function withKeyAliases<S extends z.ZodObject>(
  aliases: Record<string, keyof S["shape"] & string>,
  schema: S,
) {
  return z.preprocess((value) => {
    if (!isRecord(value)) return value;
    let next = value;

    for (const [alias, canonical] of Object.entries(aliases)) {
      const key =
        alias in next
          ? alias
          : Object.keys(next).find((k) => canonicalParamKey(k) === canonicalParamKey(alias));

      if (key === undefined) continue;

      if (next === value) next = { ...value };

      // Fold into the canonical field when absent; else the canonical wins.
      if (!(canonical in next)) next[canonical] = next[key];
      delete next[key];
    }

    return next;
  }, schema);
}

/**
 * Treat a blank string as omitted: models send `query: ""` to skip an optional
 * field. Wrapped at the object level, because a field-level preprocess would
 * mark the field required in the JSON schema. Do not use it on a required field.
 */
function blankFieldToOmitted<S extends z.ZodType>(fields: readonly string[], schema: S) {
  return z.preprocess((value) => {
    if (!isRecord(value)) return value;
    let next = value;

    for (const field of fields) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a `z.preprocess` callback on raw model input; the string arm is the blank-field check inside the owning schema.
      if (typeof next[field] === "string" && next[field].trim() === "") {
        if (next === value) next = { ...value };
        delete next[field];
      }
    }

    return next;
  }, schema);
}

/**
 * Parse JSON-string arrays (`values: "[[\"a\"]]"`) into arrays. Models do this,
 * and a sheets call once failed four times, then claimed success. A string that
 * is not a JSON array is left for strict validation.
 */
export function coerceJsonArrayFields<S extends z.ZodType>(fields: readonly string[], schema: S) {
  return z.preprocess((value) => {
    if (!isRecord(value)) return value;
    let next = value;

    for (const field of fields) {
      const raw = next[field];

      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a `z.preprocess` callback on raw model input; a non-string field goes to strict validation unchanged.
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();

      if (!trimmed.startsWith("[")) continue;

      // Malformed JSON parses to `null`, so the raw string goes on to strict validation.
      const parsed = safeJsonParse(trimmed);

      if (Array.isArray(parsed)) {
        if (next === value) next = { ...value };
        next[field] = parsed;
      }
    }

    return next;
  }, schema);
}

/* ── calendar ─────────────────────────────────────────────────────────── */

export const CALENDAR_RESPONSES = ["accepted", "declined", "tentative"] as const;

export type CalendarResponse = (typeof CALENDAR_RESPONSES)[number];

/** True when Google Calendar will notify external attendees. */
export function calendarCreateEventSendsInvitations(input: {
  readonly attendees?: readonly string[] | undefined;
}): boolean {
  return (input.attendees?.length ?? 0) > 0;
}

/* ── gmail ────────────────────────────────────────────────────────────── */

/**
 * Wrap a bare recipient string (`to: "a@b.com"`) in an array. Runs after
 * `coerceJsonArrayFields`, so a `[`-prefixed string is a bad JSON array and is
 * left to fail. No trim: this fixes shape, not content. Recipients only.
 */
const GMAIL_RECIPIENT_FIELDS = ["to", "cc", "bcc"] as const;

// oxlint-disable-next-line anti-slop/no-unknown-returns -- a `z.preprocess` callback takes and returns raw model input; the owning schema parses the result.
function wrapScalarRecipients(value: unknown): unknown {
  if (!isRecord(value)) return value;
  let next = value;

  for (const field of GMAIL_RECIPIENT_FIELDS) {
    const raw = next[field];

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a `z.preprocess` callback on raw model input; a non-string field goes to strict validation unchanged.
    if (typeof raw !== "string") continue;

    if (raw.trim().startsWith("[")) continue;

    if (next === value) next = { ...value };
    next[field] = [raw];
  }

  return next;
}

export const gmailSendDraftInput = coerceJsonArrayFields(
  GMAIL_RECIPIENT_FIELDS,
  z.preprocess(
    wrapScalarRecipients,
    withKeyAliases(
      { body: "bodyText" },
      z
        .object({
          to: z.array(modelToolEmail()).min(1).max(25),
          cc: z.array(modelToolEmail()).max(25).optional(),
          bcc: z.array(modelToolEmail()).max(25).optional(),
          subject: z
            .string()
            .min(1)
            .max(1000)
            .refine((s) => !/[\r\n]/.test(s), {
              message: "subject must not contain line breaks",
            }),
          bodyText: z.string().min(1).max(50_000),
          /** Shown on the approval card so the user can confirm the thread. */
          threadId: z.string().optional(),
        })
        .strict(),
    ),
  ),
);

export type GmailSendDraftInput = z.infer<typeof gmailSendDraftInput>;

/* ── sheets ───────────────────────────────────────────────────────────── */

/** `null` is a blank cell. */
const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const cellGrid = z
  .array(z.array(cellValue))
  .min(1)
  .describe("Row-major grid of cell values. Each inner array is one row.");

const valueInputOption = z
  .enum(["RAW", "USER_ENTERED"])
  .default("USER_ENTERED")
  .describe(
    "How values are interpreted: RAW stores verbatim; USER_ENTERED parses formulas/dates as if typed in the UI.",
  );

const a1Range = z
  .string()
  .min(1)
  .max(500)
  .describe("A1 notation, e.g. `Sheet1!A1:C10` (or `Sheet1!A1` to anchor an append).");

const spreadsheetId = z.string().min(1).max(200).describe("The target spreadsheet's id.");

export const sheetsAppendValuesInput = coerceJsonArrayFields(
  ["values"],
  z
    .object({
      spreadsheetId,
      range: a1Range,
      values: cellGrid,
      valueInputOption,
    })
    .strict(),
);

/* ── contacts ─────────────────────────────────────────────────────────── */

/**
 * `saved` is the user's address book. `other` is Google's "Other contacts": people
 * the user emailed but never saved. The People API keeps them in separate collections.
 */
export const CONTACT_SOURCES = ["saved", "other"] as const;

export type ContactSource = (typeof CONTACT_SOURCES)[number];

/** People API caps a contact search page at 30. */
const CONTACTS_SEARCH_MAX_RESULTS = 30;

/** People API allows 1,000; a smaller page keeps the result inside the model budget. */
const CONTACTS_LIST_MAX_PAGE = 100;

const CONTACTS_LIST_DEFAULT_PAGE = 50;

export const contactsSearchInput = withQueryAlias(
  "query",
  z
    .object({
      query: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "A name, email, or phone number (saved contacts also match an organization). Matches a prefix of each word, not a substring.",
        ),
      source: z
        .enum(["all", ...CONTACT_SOURCES])
        .default("all")
        .catch("all")
        .describe(
          "`saved` searches the address book, `other` searches people the user emailed but never saved, `all` searches both.",
        ),
      maxResults: z.coerce
        .number()
        .int()
        .min(1)
        .max(CONTACTS_SEARCH_MAX_RESULTS)
        .default(10)
        .catch(10)
        .describe(`Cap on results from each source (max ${CONTACTS_SEARCH_MAX_RESULTS}).`),
    })
    .strict(),
);

export const contactsListInput = z
  .object({
    source: z
      .enum(CONTACT_SOURCES)
      .default("saved")
      .catch("saved")
      .describe("`saved` lists the address book, `other` lists people the user emailed."),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(CONTACTS_LIST_MAX_PAGE)
      .default(CONTACTS_LIST_DEFAULT_PAGE)
      .catch(CONTACTS_LIST_DEFAULT_PAGE)
      .describe(`Contacts per page (max ${CONTACTS_LIST_MAX_PAGE}).`),
    pageToken: z
      .string()
      .optional()
      .describe(
        "Cursor from a previous page's nextPageToken. Send the same `source` and `pageSize` as that page.",
      ),
  })
  .strict();

export const contactsGetInput = z
  .object({
    resourceName: z
      .string()
      .regex(/^people\/c\d+$/, "A saved contact's resourceName, e.g. `people/c123`.")
      .describe(
        "A saved contact's `resourceName` (`people/…`) from contacts.search or contacts.list. Other contacts have no detail read.",
      ),
  })
  .strict();

/**
 * The shared REST passthrough request for every REST integration (ADR-0074).
 * Not `.strict()`: a write method should reach the read gate, which explains the rejection.
 */
export const restPassthroughInput = restPassthroughRequestSchema;

/* ── vercel ───────────────────────────────────────────────────────────── */

export const vercelListProjectsInput = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20).catch(20),
  })
  .strict();

export const vercelListDeploymentsInput = z
  .object({
    projectId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Optional Vercel project id or name to scope deployments to."),
    limit: z.coerce.number().int().min(1).max(20).default(10).catch(10),
  })
  .strict();

export const vercelRedeployInput = z
  .object({
    deploymentId: z.string().min(1).max(200).describe("Id of the existing deployment to redeploy."),
    name: z
      .string()
      .min(1)
      .max(200)
      .describe("Project name the deployment belongs to (Vercel requires it on redeploy)."),
    target: z
      .enum(["production", "preview"])
      .optional()
      .describe("Deployment target. Omit to keep the original deployment's target."),
  })
  .strict();

/* ── system ───────────────────────────────────────────────────────────── */

export const searchToolsInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .describe("Capability to find, such as 'read a calendar event' or an exact tool name."),
    limit: z.coerce.number().int().min(1).max(10).default(5).catch(5),
  })
  .strict();

export const loadToolInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("Exact qualified tool name returned by search_tools."),
  })
  .strict();

export const currentTimeInput = z.object({}).strict();

export const authorWorkflowInput = coerceJsonArrayFields(
  ["capabilities", "assumptions", "externalEffects"],
  authorWorkflowInputSchema,
);

export const recoverWorkflowInput = z
  .object({
    workflowId: z.string().min(1).max(200),
    revisionId: z.string().min(1).max(200),
  })
  .strict();

// The model copies these names from the server's proposal, so the full tool-name
// enum is not repeated here. `activateWorkflowDefinition` still parses strictly.
const copiedWorkflowCapabilitySchema = workflowRequiredCapabilitySchema.extend({
  tool: z.string().min(1).max(200),
});

const copiedWorkflowDefinitionSchema = authorableWorkflowDefinitionSchema.extend({
  allowedTools: z.array(z.string().min(1).max(200)).max(100),
  requiredCapabilities: z.array(copiedWorkflowCapabilitySchema).max(50),
});

const copiedWorkflowCapabilityDisplaySchema = workflowCapabilityDisplaySchema.extend({
  tool: z.string().min(1).max(200),
});

export const activateWorkflowInput = coerceJsonArrayFields(
  ["resolvedAccounts", "resolvedCapabilities"],
  activateWorkflowInputSchema.extend({
    definition: copiedWorkflowDefinitionSchema,
    resolvedCapabilities: z.array(copiedWorkflowCapabilityDisplaySchema).meta({ readOnly: true }),
    authoringProposal: z.unknown().meta({ readOnly: true }),
  }),
);

const scratchKey = z.string().min(1).max(240);

export const readScratchInput = z.object({ key: scratchKey }).strict();

export const writeScratchInput = z
  .object({
    key: scratchKey,
    value: z.unknown(),
  })
  .strict();

export const promoteScratchInput = z
  .object({
    fromKey: scratchKey,
    toKey: scratchKey,
  })
  .strict();

export const readUserContextInput = coerceJsonArrayFields(
  ["include"],
  blankFieldToOmitted(
    ["query"],
    z
      .object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Optional short natural-language focus, e.g. the person, project, preference, or relationship the user referenced.",
          ),
        include: z
          .array(
            z.enum([
              "profile",
              "integrations",
              "facts",
              "preferences",
              "entities",
              "relationships",
              "recent_memory",
            ]),
          )
          .max(7)
          .optional()
          .describe(
            "Optional section hints. The result is still bounded and may include adjacent context needed for provenance.",
          ),
        subjectEmail: z
          .string()
          .trim()
          .toLowerCase()
          .regex(MODEL_TOOL_EMAIL_PATTERN, "Invalid email address")
          .max(320)
          .optional()
          .describe("Optional person/contact email to focus on."),
      })
      .strict(),
  ),
);

// Tool `input_schema` needs a top-level `type: "object"`, and a union serializes
// to a typeless `oneOf`. So one object, `mode` as the discriminant, refinements.
export const readChatHistoryInput = z
  .object({
    mode: z
      .enum(["search", "fetch"])
      .describe(
        "`search` runs a keyword lookup across this thread's messages; `fetch` pulls one item by id.",
      ),
    query: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("Required for `search`: the keyword query. Omit for `fetch`."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("`search` only: max results to return (1-10, default 5)."),
    kind: z
      .enum(["message", "tool_call", "attachment"])
      .optional()
      .describe("Required for `fetch`: which kind of item `id` refers to. Omit for `search`."),
    id: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .optional()
      .describe("Required for `fetch`: the id of the message, tool call, or attachment."),
  })
  .strict()
  .refine((v) => v.mode !== "search" || v.query !== undefined, {
    message: "query is required when mode is 'search'",
    path: ["query"],
  })
  .refine((v) => v.mode !== "fetch" || (v.kind !== undefined && v.id !== undefined), {
    message: "kind and id are required when mode is 'fetch'",
    path: ["kind"],
  });

const instructionLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), { message: "must be single-line" });

const instructionSenders = z.array(z.string().trim().toLowerCase().min(1).max(320)).min(1).max(50);

const instructionIds = z.array(z.string().min(1).max(100)).min(1).max(20).optional();

/**
 * A v2 standing instruction (ADR-0113). The tool stages a card that the user confirms, also
 * under full autonomy, so the card is the one-line confirmation. Code mints the instruction id
 * and builds the stored targets; a domain must belong to one organization.
 */
export const rememberInput = coerceJsonArrayFields(
  ["targets", "senderFilter", "effects", "replaces", "coexistsWith"],
  z
    .object({
      kind: z.literal("standing_instruction").describe("Persist one standing instruction."),
      instructionId: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Set only to revise an instruction that `list_instructions` shows with schemaVersion 2. " +
            "The revision replaces every field below. Omit to store a new instruction.",
        ),
      expectedRevision: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Required with `instructionId`: the `revision` that `list_instructions` shows for it. " +
            "If the instruction changed since then, nothing is stored.",
        ),
      phrasing: instructionLine(1_000).describe("The user's own words, verbatim."),
      directive: instructionLine(1_000).describe(
        "One resolved sentence that says what Alfred does, for later model readers.",
      ),
      scope: instructionLine(500)
        .optional()
        .describe(
          "Plain text for the class of mail the words name, for example 'stock, demat, and " +
            "registrar notices'. Triage matches it by meaning, so a new sender is covered. Omit " +
            "when the words name only senders.",
        ),
      targets: instructionSenders
        .optional()
        .describe(
          "Sender addresses or bare domains that the user's words NAME, each for the whole " +
            "sender. Never a list you chose from past mail: a class of mail goes in `scope`.",
        ),
      senderFilter: instructionSenders
        .optional()
        .describe(
          "Addresses or domains that the words name to narrow `scope` (both must hold). Needs " +
            "`scope`. Never matches alone.",
        ),
      effects: z
        .array(z.enum(STANDING_INSTRUCTION_CAPTURE_EFFECT_KINDS))
        .max(STANDING_INSTRUCTION_CAPTURE_EFFECT_KINDS.length)
        .describe(
          "Only the effects the words ask for. demote_urgent: urgent becomes action_needed. " +
            "demote_demand: urgent and action_needed become fyi. demote_meeting: meeting mail " +
            "becomes fyi. force_category: always `forceCategory`. block_todo_suggestion: no " +
            "todo. exclude_briefing_priority: not a briefing priority. block_reply_draft: no " +
            "proactive draft. Can be empty: the words then stay prose for later model readers. " +
            "'Always show X in the briefing' has no effect yet; keep it in the words.",
        ),
      forceCategory: triageCategorySchema
        .optional()
        .describe("The category for `force_category`. Required with it, else omit."),
      exceptionOf: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "The `instructionId` of a broader active instruction that this one narrows, when the " +
            "words state an exception ('except its marketing mail').",
        ),
      replaces: instructionIds.describe(
        "The `instructionId`s of related instructions that the user chose to replace with this " +
          "one. They stop when this one is stored.",
      ),
      coexistsWith: instructionIds.describe(
        "The `instructionId`s of related instructions that the user chose to keep beside this " +
          "one. On mail that both match, the later write wins a conflict.",
      ),
      accountId: z
        .string()
        .trim()
        .max(200)
        .nullable()
        .optional()
        .describe(
          "Optional mailbox. Null or omitted means every connected mailbox. It bounds the " +
            "targets, the senderFilter, and the scope.",
        ),
    })
    .strict()
    .refine((v) => (v.instructionId === undefined) === (v.expectedRevision === undefined), {
      message: "expectedRevision is required with instructionId, and only with it",
      path: ["expectedRevision"],
    })
    .refine((v) => v.senderFilter === undefined || v.scope !== undefined, {
      message: "senderFilter needs a scope",
      path: ["senderFilter"],
    })
    .refine((v) => v.effects.includes("force_category") === (v.forceCategory !== undefined), {
      message: "forceCategory is required with force_category, and only with it",
      path: ["forceCategory"],
    })
    // An effect or an exception with nothing to match never applies, so it must name senders or a class.
    .refine(
      (v) =>
        (v.effects.length === 0 && v.exceptionOf === undefined) ||
        v.targets !== undefined ||
        v.scope !== undefined,
      {
        message:
          "effects and exceptionOf need targets or a scope; with neither, keep effects empty",
        path: ["effects"],
      },
    ),
);

/** No arguments. Returns a bounded newest-first page. */
export const listInstructionsInput = z.object({}).strict();

/** Targets one row by `factId`. Marks it `rejected`, so it can be undone. */
export const forgetInstructionInput = z
  .object({
    factId: z
      .string()
      .min(1)
      .max(100)
      .describe("The `factId` of the instruction to remove, from `list_instructions`."),
    reason: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe("Short note on why it's being removed (audit only)."),
  })
  .strict();

/**
 * Change the directive or label, not the target: supersedes the row. A domain row
 * takes neither edit and lists the ignored fields in `droppedInputs`.
 */
export const editInstructionInput = z
  .object({
    factId: z
      .string()
      .min(1)
      .max(100)
      .describe("The `factId` of the instruction to reframe, from `list_instructions`."),
    directive: z
      .string()
      .trim()
      .max(1_000)
      .refine((s) => !/[\r\n]/.test(s), {
        message: "directive must be single-line",
      })
      .optional()
      .describe(
        "New resolved instruction sentence. Omit to leave unchanged. A domain-target row ignores " +
          "it and reports it under `droppedInputs`.",
      ),
    senderLabel: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .describe(
        "New human display label for the sender. Omit to leave unchanged. A domain-target row " +
          "ignores it and reports it under `droppedInputs`.",
      ),
  })
  .strict();

/** `live` is {@link LIVE_TODO_STATUSES}. */
export const LIST_TODOS_STATUS_FILTERS = ["live", ...TODO_STATUSES] as const;

/** The hard cap on rows in one `system.list_todos` result. */
export const LIST_TODOS_MAX_LIMIT = 50;

/** The row count of one `system.list_todos` result when the model passes no `limit`. */
export const LIST_TODOS_DEFAULT_LIMIT = 20;

/** The hard cap on ids in one `system.resolve_todo` call of kind `todo_ids`. */
export const RESOLVE_TODO_IDS_MAX = 50;

/** The todo ids of one `system.resolve_todo` call of kind `todo_ids`. The task re-parses with it. */
export const resolveTodoIdsSchema = z
  .array(z.string().trim().min(1).max(100))
  .min(1)
  .max(RESOLVE_TODO_IDS_MAX);

export const listTodosInput = z
  .object({
    status: z
      .enum(LIST_TODOS_STATUS_FILTERS)
      .default("live")
      .describe(
        `\`live\` (default) returns the todos in the rail: ` +
          `${LIVE_TODO_STATUSES.map((status) => `\`${status}\``).join(" and ")}. Pass one ` +
          "status to read only that status, for example `done` or `dismissed`.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_TODOS_MAX_LIMIT)
      .default(LIST_TODOS_DEFAULT_LIMIT)
      .describe(
        `Maximum todos to return (1-${LIST_TODOS_MAX_LIMIT}, default ${LIST_TODOS_DEFAULT_LIMIT}), ` +
          "most recently changed first.",
      ),
  })
  .strict();

/**
 * One object with `kind` as the discriminant, because a top-level union serializes to a
 * typeless `oneOf`. `gmail_sender` matches by sender, thread, or account; `todo_ids` names
 * the todos. The refinements keep each kind to its own fields.
 */
export const resolveTodoInput = coerceJsonArrayFields(
  ["todoIds"],
  z
    .object({
      kind: z
        .enum(["gmail_sender", "todo_ids"])
        .describe(
          "`gmail_sender`: the live todos from the Gmail threads of a sender, a thread, or an " +
            "account. `todo_ids`: the exact todos in `todoIds`.",
        ),
      todoIds: resolveTodoIdsSchema
        .optional()
        .describe(
          `Required for \`todo_ids\`, invalid for \`gmail_sender\`: the ids of the todos to ` +
            `dismiss (1-${RESOLVE_TODO_IDS_MAX}). An id that is not a live todo of the user is ` +
            "reported under `skipped` and is not changed.",
        ),
      senderEmail: z
        .string()
        .trim()
        .toLowerCase()
        .max(320)
        .optional()
        .describe(
          "`gmail_sender` only. Resolved sender email. If unresolved, omit it and provide " +
            "sourceThreadId if known.",
        ),
      sourceThreadId: z
        .string()
        .trim()
        .max(512)
        .optional()
        .describe("`gmail_sender` only. Optional Gmail thread id to resolve exactly."),
      accountId: z
        .string()
        .trim()
        .max(200)
        .nullable()
        .optional()
        .describe(
          "`gmail_sender` only. Optional account scope. Null or omitted means match across " +
            "accounts.",
        ),
      reason: z
        .string()
        .trim()
        .max(1_000)
        .optional()
        .describe("Short audit reason for why the todo is being dismissed."),
    })
    .strict()
    .refine((v) => v.kind !== "todo_ids" || v.todoIds !== undefined, {
      message: "todoIds is required when kind is 'todo_ids'",
      path: ["todoIds"],
    })
    .refine((v) => v.kind !== "gmail_sender" || v.todoIds === undefined, {
      message: "todoIds is only for kind 'todo_ids'",
      path: ["todoIds"],
    })
    .refine(
      (v) =>
        v.kind !== "todo_ids" ||
        (v.senderEmail === undefined && v.sourceThreadId === undefined && v.accountId == null),
      {
        message: "kind 'todo_ids' takes no senderEmail, sourceThreadId, or accountId",
        path: ["kind"],
      },
    ),
);

export const webSearchInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(1_000)
      .describe(
        "A focused natural-language question to look up on the live web. Phrase it as the thing you want to know, not a bag of keywords.",
      ),
  })
  .strict();

export const fetchUrlInput = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(2_048)
      // Shape only. The scheme and host safety checks run in the server handler (ADR-0071).
      // `.check(z.url())` is the check that the deprecated `.url()` added, after `.trim()`.
      .check(z.url())
      .refine((u) => /^https?:\/\//i.test(u), {
        message: "url must be an http(s) URL.",
      })
      .describe(
        "The exact http(s) URL to read. Use this when you already hold a link (from the user, from read_user_context, or from a prior tool result) and want its page contents — prefer it over web_search, which discovers sources for a question rather than reading a known page.",
      ),
  })
  .strict();

export const corpusSearchInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(1_000)
      .describe(
        "A focused natural-language question or phrase to find in the user's ingested documents. Phrase it as the information you want, the way it would appear in the document.",
      ),
  })
  .strict();

/**
 * `system.search_context` input (ADR-0101): {@link contextSearchRequestSchema}
 * without `userId` and the server-owned budgets `expand` and `maxSourceCost`.
 */
export const searchContextInput = coerceJsonArrayFields(
  ["objects"],
  contextSearchRequestSchema
    .omit({ userId: true, expand: true, maxSourceCost: true })
    .strict()
    .describe(
      "One read across Alfred's registered evidence sources for a query. Use it to assemble first-pass evidence, then drill into provider-specific tools for actions or exact records.",
    ),
);

export const suggestTodoInput = coerceJsonArrayFields(
  ["sources"],
  z
    .object({
      name: z.string().min(1).max(2_000).describe("Short imperative title for the commitment."),
      description: z
        .string()
        .max(20_000)
        .optional()
        .describe("Optional longer context for the todo."),
      assist: z
        .string()
        .max(20_000)
        .optional()
        .describe(
          "Optional tip on how to approach it. State honestly if you can't act on it (no permission / integration not connected). This is not execution.",
        ),
      sources: z
        .array(todoSourceSchema)
        .max(64)
        .optional()
        .describe(
          "Cross-source provenance: [{ provider, kind, id, url? }]. Include every channel this commitment spans so it dedups across surfaces.",
        ),
    })
    .strict(),
);

/* ── artifacts (ADR-0075) ─────────────────────────────────────────────── */

/** `spreadsheet` has no renderer yet, and the server mints `external_file` (#287). */
const authorableArtifactKindSchema = artifactKindSchema.exclude(["spreadsheet", "external_file"]);

/**
 * The model fills every field, so `{kind:"pages", markdown:""}` failed the
 * no-markdown refine and it shipped a document instead of a deck.
 * Blank strings mean omitted here.
 */
export const createArtifactInput = blankFieldToOmitted(
  ["markdown", "format"],
  z
    .object({
      title: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "Short human title for the artifact, shown in the sidebar header and the chat card.",
        ),
      kind: authorableArtifactKindSchema.describe(
        "`document` for long-form prose (markdown), or `pages` for an ordered deck/PDF of full-bleed HTML pages.",
      ),
      format: artifactFormatSchema
        .optional()
        .describe(
          "Required when kind is `pages`: `slides` (16:9 deck) or `pdf` (portrait letter). Omit for `document`.",
        ),
      markdown: z
        .string()
        .max(ARTIFACT_SECTION_MAX_CHARS)
        .optional()
        .describe(
          "Opening section for a `document` (≤~1,800 words). Author the first section here, then continue with append_artifact_section — each section renders in the sidebar as produced. Do NOT attempt the whole document in one call; a long body must be split into sections. Invalid for `pages` (add pages with append_artifact_page).",
        ),
    })
    .strict()
    .refine((v) => (v.kind === "pages" ? v.format !== undefined : v.format === undefined), {
      message:
        "kind 'pages' needs format 'slides' or 'pdf'; kind 'document' takes no format. For a slide deck send {kind:'pages', format:'slides'} with no markdown, then add each slide with append_artifact_page.",
      path: ["format"],
    })
    .refine((v) => !(v.kind === "pages" && v.markdown !== undefined), {
      message:
        "kind 'pages' takes no markdown. Send {kind:'pages', format:'slides'|'pdf'} with markdown omitted or empty, then add each page with append_artifact_page. markdown is only for kind 'document'.",
      path: ["markdown"],
    }),
);

export const appendArtifactPageInput = z
  .object({
    artifactId: z
      .string()
      .min(1)
      .describe("The artifactId returned by create_artifact. Must be a `pages` artifact."),
    title: z
      .string()
      .max(200)
      .describe("Short page/slide title, shown on the thumbnail and chrome."),
    html: z
      .string()
      .max(200_000)
      .describe(
        "Body-level HTML for one page. Do not include <html>, <head>, <body>, <!doctype>, scripts, external links/CDNs, page geometry, body background, or font boilerplate; the renderer wraps it in the Alfred artifact shell. One call appends one page to the end; call again for each subsequent page.",
      ),
  })
  .strict();

export const appendArtifactSectionInput = z
  .object({
    artifactId: z
      .string()
      .min(1)
      .describe("The artifactId returned by create_artifact. Must be a `document` artifact."),
    markdown: z
      .string()
      .min(1)
      .max(ARTIFACT_SECTION_MAX_CHARS)
      .describe(
        "One section of markdown (≤~1,800 words), appended to the end of the document after a blank line. Write your own `##` headings. Split at block boundaries and keep each section self-contained — close every code fence and finish every list/table within the section, because the sidebar re-renders the whole document as each section arrives. Call again for each subsequent section; also use this to add to a document from an earlier turn.",
      ),
  })
  .strict();

export const updateArtifactInput = coerceJsonArrayFields(
  ["pages", "edits"],
  // A blank `markdown` beside `pages` means none.
  blankFieldToOmitted(
    ["title", "markdown"],
    z
      .object({
        artifactId: z.string().min(1).describe("The artifactId to revise."),
        title: z.string().min(1).max(200).optional().describe("New title (rename only)."),
        markdown: z
          .string()
          .max(500_000)
          .optional()
          .describe("Full replacement markdown for a `document` artifact."),
        pages: z
          .array(artifactPageSchema)
          .max(100)
          .optional()
          .describe(
            "Full replacement page list for a `pages` artifact. Send every page you want kept — this replaces the whole set. To merely add a page, prefer append_artifact_page.",
          ),
        edits: z
          .array(artifactTextEditSchema)
          .min(1)
          .max(ARTIFACT_EDITS_MAX)
          .optional()
          .describe(
            "Targeted exact-match edits, applied in order and saved together as one version. Each oldString must be raw text (not its JSON-escaped form) that occurs exactly once in the current body as it stands after the edits before it; for a deck, across all page HTML. Include enough surrounding text to make it unique. Needs no baseContentHash.",
          ),
        baseContentHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional()
          .describe(
            "Required for cross-turn markdown/pages replacement. Copy it exactly from a complete artifact reference. Omit for rename-only edits, `edits`, or content created earlier in this same run.",
          ),
      })
      .strict()
      .refine(
        (v) =>
          v.title !== undefined ||
          v.markdown !== undefined ||
          v.pages !== undefined ||
          v.edits !== undefined,
        { message: "provide at least one of title, markdown, pages, or edits" },
      )
      .refine(
        (v) => [v.markdown, v.pages, v.edits].filter((field) => field !== undefined).length <= 1,
        {
          message:
            "markdown, pages, and edits are mutually exclusive (send targeted edits, or one full replacement)",
        },
      ),
  ),
);

/** One table for the schema bounds and the prose that quotes them. */
export const ASK_USER_LIMITS = {
  questions: { min: 1, max: 4 },
  /** More than four is too open for a card (#1019). */
  options: { min: 2, max: 4 },
  /**
   * The card caps its textarea here: it re-parses the draft on every keystroke,
   * and a longer paste would swap the card for a raw-JSON editor.
   */
  customAnswer: { max: 4_000 },
} as const;

const askUserOptionSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("Short option text, one to five words. The answer carries this exact label."),
    description: z
      .string()
      .trim()
      .max(400)
      .describe("What choosing this option means or implies for the task."),
  })
  .strict();

export const askUserQuestionSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .describe("The complete question, phrased to the user, ending with a question mark."),
    header: z
      .string()
      .trim()
      .min(1)
      .max(24)
      .describe(
        "Very short chip label for the question, at most 24 characters, e.g. 'Recipients'.",
      ),
    options: z
      .array(askUserOptionSchema)
      .min(ASK_USER_LIMITS.options.min)
      .max(ASK_USER_LIMITS.options.max)
      .describe(
        `${ASK_USER_LIMITS.options.min} to ${ASK_USER_LIMITS.options.max} distinct choices, the recommended one first.`,
      ),
    multiSelect: z
      .boolean()
      .default(false)
      .describe("True when the user may pick several options at once."),
  })
  .strict()
  // The label is the option's identity in answers and in the card, so duplicates
  // would toggle together. Reject them here, not in prose.
  .refine((v) => new Set(v.options.map((option) => option.label)).size === v.options.length, {
    message: "options must carry distinct labels",
    path: ["options"],
  });

export type AskUserQuestion = z.infer<typeof askUserQuestionSchema>;

/**
 * Answers in question order. `customAnswer` is not trimmed: the card re-parses
 * its draft on every keystroke, and a trim deleted each typed space.
 */
export const askUserAnswerSchema = z
  .object({
    selectedOptions: z.array(z.string().trim().min(1).max(120)).max(ASK_USER_LIMITS.options.max),
    customAnswer: z.string().max(ASK_USER_LIMITS.customAnswer.max).nullable(),
  })
  .strict();

export type AskUserAnswer = z.infer<typeof askUserAnswerSchema>;

/** The model's fields, unwrapped so each schema below adds its own wrapper and rules. */
const askUserFields = z.object({
  context: z
    .string()
    .trim()
    .max(4_000)
    .optional()
    .describe(
      "Optional short markdown paragraph that frames why you ask, shown above the questions.",
    ),
  questions: z
    .array(askUserQuestionSchema)
    .min(ASK_USER_LIMITS.questions.min)
    .max(ASK_USER_LIMITS.questions.max)
    .describe(
      `${ASK_USER_LIMITS.questions.min} to ${ASK_USER_LIMITS.questions.max} questions the user answers before the turn continues.`,
    ),
});

/** Written by the decision route, never by the model. */
const askUserAnswersField = z
  .array(askUserAnswerSchema)
  .optional()
  .describe("Filled by the user, never by the model. One entry per question, in the same order.");

/**
 * What the model may write (ADR-0099). No `answers` key, so it cannot answer
 * itself: an optional `answers` once read to the model as a field to fill.
 */
export const askUserModelInput = coerceJsonArrayFields(["questions"], askUserFields.strict());

export type AskUserModelInput = z.infer<typeof askUserModelInput>;

/** Shared, so the two schemas below differ only by the pairing rule. */
const askUserAnswerSheet = askUserFields.extend({ answers: askUserAnswersField }).strict();

/**
 * The runtime schema (ADR-0099). Accepts `answers`, which the decision route
 * writes into the decided input. No length rule on purpose: a stray `answers`
 * must reach the dispatcher's question arm, which names the right repair.
 */
export const askUserInput = coerceJsonArrayFields(["questions", "answers"], askUserAnswerSheet);

export type AskUserInput = z.infer<typeof askUserInput>;

/** Adds the pairing rule, so a wrong-length answer list is a 400 the card can show. */
export const askUserDecidedInput = coerceJsonArrayFields(
  ["questions", "answers"],
  askUserAnswerSheet.refine(
    (v) => v.answers === undefined || v.answers.length === v.questions.length,
    {
      message: "answers must carry exactly one entry per question",
      path: ["answers"],
    },
  ),
);

export type AskUserDecidedInput = z.infer<typeof askUserDecidedInput>;

/**
 * The dispatcher sets `dismissed` and `expired` without running the tool.
 * The tool sets `no_answers` when the row was approved with no edit.
 */
export const askUserUnansweredReasonSchema = z.enum(["dismissed", "expired", "no_answers"]);

export type AskUserUnansweredReason = z.infer<typeof askUserUnansweredReasonSchema>;

/** Shared by `execute` and the dispatcher's synthesized results. */
export const askUserResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("answered"),
    questions: z.array(askUserQuestionSchema),
    answers: z.array(askUserAnswerSchema),
  }),
  z.object({
    status: z.literal("unanswered"),
    reason: askUserUnansweredReasonSchema,
    questions: z.array(askUserQuestionSchema),
    message: z.string(),
  }),
]);

export type AskUserResult = z.infer<typeof askUserResultSchema>;

export type AskUserUnansweredResult = Extract<AskUserResult, { status: "unanswered" }>;

export const subAgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "subId may only contain letters, numbers, underscores, and dashes");

export const spawnSubAgentInput = coerceJsonArrayFields(
  ["allowedIntegrations"],
  z
    .object({
      subId: subAgentIdSchema,
      brief: z.string().min(1).max(8_000),
      allowedIntegrations: z.array(z.enum(LOADABLE_INTEGRATION_SLUGS)).default([]),
    })
    .strict(),
);

export type SpawnSubAgentInput = z.infer<typeof spawnSubAgentInput>;

/** The join arm reads `childRunId` off a `staging: "join"` call, without the tool's `execute`. */
export const joinToolInput = z.object({ childRunId: z.string().min(1) });

/** Derived from `joinToolInput`, because the join arm reads the child id without `execute`. */
export const awaitSubAgentInput = joinToolInput.strict();

/** By `ToolName`, so the web can find a schema without server code. Every name has a row. */
export const TOOL_INPUT_SCHEMAS = {
  "vercel.list_projects": vercelListProjectsInput,
  "vercel.list_deployments": vercelListDeploymentsInput,
  "vercel.redeploy": vercelRedeployInput,
  "vercel.request": restPassthroughInput,
  "gmail.send_draft": gmailSendDraftInput,
  "sheets.append_values": sheetsAppendValuesInput,
  "contacts.search": contactsSearchInput,
  "contacts.list": contactsListInput,
  "contacts.get": contactsGetInput,
  "system.search_tools": searchToolsInput,
  "system.load_tool": loadToolInput,
  "system.current_time": currentTimeInput,
  "system.author_workflow": authorWorkflowInput,
  "system.recover_workflow": recoverWorkflowInput,
  "system.activate_workflow": activateWorkflowInput,
  "system.read_user_context": readUserContextInput,
  "system.read_chat_history": readChatHistoryInput,
  "system.read_scratch": readScratchInput,
  "system.write_scratch": writeScratchInput,
  "system.promote": promoteScratchInput,
  "system.remember": rememberInput,
  "system.list_instructions": listInstructionsInput,
  "system.forget_instruction": forgetInstructionInput,
  "system.edit_instruction": editInstructionInput,
  "system.list_todos": listTodosInput,
  "system.resolve_todo": resolveTodoInput,
  "system.suggest_todo": suggestTodoInput,
  "system.web_search": webSearchInput,
  "system.fetch_url": fetchUrlInput,
  "system.corpus_search": corpusSearchInput,
  "system.search_context": searchContextInput,
  "system.create_artifact": createArtifactInput,
  "system.append_artifact_page": appendArtifactPageInput,
  "system.append_artifact_section": appendArtifactSectionInput,
  "system.update_artifact": updateArtifactInput,
  "system.ask_user": askUserInput,
  "system.spawn_sub_agent": spawnSubAgentInput,
  "system.await_sub_agent": awaitSubAgentInput,
  "mcp.call": mcpCallInput,
  "mcp.list_tools": mcpToolSearchInputSchema,
  "mcp.inspect_tool": mcpToolInspectInputSchema,
} satisfies Record<ToolName, z.ZodType>;
