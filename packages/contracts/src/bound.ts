import { assertNever } from "./errors";
import { isJsonArray, isJsonObject } from "./guards";
import { z } from "zod";
import { jsonValueSchema, type JsonPrimitive, type JsonValue } from "./user-model";

/**
 * One size rule (ADR-0130 decision 5): a result is bounded by its structure where it goes to the
 * model. The JSON stays valid. A list keeps whole items from its start, and an object keeps every
 * field, so a cursor next to a list stays. A long string is cut only when it is the largest part.
 * The truncation note names each cut, with its kept and total counts. Deterministic, so the cached
 * transcript prefix stays stable.
 */

/**
 * The most UTF-8 bytes of JSON in one result that the model reads. Measured on prod
 * `action_stagings` over 45 days (2026-11-19): the largest single-object reads were 7.6 KB
 * (`issue_read`), 11.7 KB (`github.get_issue`), and 35.9 KB (`system.read_user_context`), and the
 * largest `system.code_run` value was 51.6 KB. All fit whole. Only lists (`list_issues`, 117 KB)
 * and fetched pages (`system.fetch_url`, p90 103 KB) are larger.
 */
export const MODEL_RESULT_MAX_BYTES = 64 * 1024;

/** A string with fewer UTF-16 code units is never cut, so ids, cursors, and titles stay whole. */
const MIN_CUT_STRING_CHARS = 512;

/** The cuts that the note lists. A result with more cuts gives their count in `moreCuts`. */
const MAX_LISTED_CUTS = 10;

/** The most characters of a listed path. A longer path keeps its start and ends in the cut mark. */
const MAX_PATH_CHARS = 200;

/**
 * Room for the truncation note beside the result. The note is at most about 3 KB by construction:
 * the fixed text, and {@link MAX_LISTED_CUTS} cuts with a path of at most {@link MAX_PATH_CHARS}.
 * So the result and its note stay within the limit.
 */
const NOTE_RESERVE_BYTES = 4 * 1024;

/**
 * The rounds that may cut lists and strings. After them, a round cuts only object fields, so an
 * object with many long strings still fits. Each round removes a part, so a real result ends early.
 */
const LEAF_ROUNDS = 500;

/** A guard on the loop, after the field rounds too. */
const MAX_ROUNDS = 1000;

/** The text after a cut string, so the model sees the cut at its place. */
const STRING_CUT_MARK = "…";

/**
 * Who reads a tool result. A script gets the full result, and only the model's copy is bounded
 * (ADR-0130 decision 5).
 */
export type ResultRecipient = "model" | "script";

/** One cut: where it is, and what it kept. */
const resultCutSchema = z
  .object({
    /** The JSON path of the cut value, for example `$.issues` or `$.content[0].json.items`. */
    path: z.string(),
    /**
     * `items`: whole list items from the end. `chars`: string UTF-16 code units from the end.
     * `fields`: object fields from the end, only when no list or long string is left to cut.
     * `value`: the whole result, only when no cut can make it fit.
     */
    unit: z.enum(["items", "chars", "fields", "value"]),
    kept: z.number(),
    total: z.number(),
  })
  .strict();

export type ResultCut = z.infer<typeof resultCutSchema>;

/** The note beside a bounded result. */
const resultTruncationSchema = z
  .object({
    limitBytes: z.number(),
    /** The JSON bytes of the whole result. */
    totalBytes: z.number(),
    cuts: z.array(resultCutSchema),
    /** The count of cuts that `cuts` does not list. */
    moreCuts: z.number().optional(),
    /**
     * The handle of the whole result, when Alfred stored it (ADR-0087, ADR-0130 decision 5). A
     * script reads it with `system.load_result({ handle })`. Absent when nothing was stored.
     */
    handle: z.string().optional(),
    note: z.string(),
  })
  .strict();

export type ResultTruncation = z.infer<typeof resultTruncationSchema>;

/**
 * The stored copy of a result behind a handle: the value, and the note when the stored cap cut it.
 * The park step writes it, and `system.load_result` parses it.
 */
export const storedResultSchema = z
  .object({ value: jsonValueSchema, truncation: resultTruncationSchema.optional() })
  .strict();

export type StoredResultCopy = z.infer<typeof storedResultSchema>;

export interface BoundedResult {
  value: JsonValue;
  /** Absent when the result fits. Then `value` is the input. */
  truncation?: ResultTruncation;
}

const TRUNCATION_NOTE =
  "This result is over the size limit, so each cut kept the start of a list or a string. The cursor " +
  "of a cut list points after the whole page, so the cut items are not on the next page. To read " +
  "them, read again with a smaller page or a filter, or read in a script and filter by known " +
  "fields there.";

const DROPPED_NOTE =
  "This result is too large to show any part of it. Read it in a script and filter by known " +
  "fields there.";

/** The note of a cut result whose whole copy Alfred stored. */
function handleNote(handle: string): string {
  return (
    "This result is over the size limit, so each cut kept the start of a list or a string. The " +
    `whole result is stored as handle "${handle}". To read the cut part, call ` +
    `system.load_result({ handle: "${handle}" }) in a script and filter by known fields there.`
  );
}

/** The note with the handle of the stored whole result, which replaces the read-again advice. */
export function withHandle(truncation: ResultTruncation, handle: string): ResultTruncation {
  return { ...truncation, handle, note: handleNote(handle) };
}

const encoder = new TextEncoder();

function jsonByteLength(value: JsonValue): number {
  return encoder.encode(JSON.stringify(value)).length;
}

interface LeafNode {
  kind: "leaf";
  value: Exclude<JsonPrimitive, string>;
  bytes: number;
}

interface StringNode {
  kind: "string";
  value: string;
  /** The characters that stay. */
  kept: number;
  bytes: number;
}

interface ArrayNode {
  kind: "array";
  items: SizedNode[];
  kept: number;
  bytes: number;
}

interface ObjectNode {
  kind: "object";
  fields: FieldNode[];
  kept: number;
  bytes: number;
}

interface FieldNode {
  key: string;
  /** The bytes of the quoted key and its colon. */
  keyBytes: number;
  node: SizedNode;
}

type SizedNode = LeafNode | StringNode | ArrayNode | ObjectNode;

/** A part that a round can cut. */
type Cuttable = StringNode | ArrayNode | ObjectNode;

function sized(value: JsonValue): SizedNode {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the walk dispatches on the runtime representation of a JSON value; the string arm is the one that can be cut.
  if (typeof value === "string") {
    return { kind: "string", value, kept: value.length, bytes: jsonByteLength(value) };
  }

  if (isJsonArray(value)) {
    const items = value.map(sized);

    return { kind: "array", items, kept: items.length, bytes: 0 };
  }

  if (isJsonObject(value)) {
    const fields = Object.entries(value).map(([key, child]) => ({
      key,
      keyBytes: jsonByteLength(key) + 1,
      node: sized(child),
    }));

    return { kind: "object", fields, kept: fields.length, bytes: 0 };
  }

  return { kind: "leaf", value, bytes: jsonByteLength(value) };
}

/** Set `bytes` of each container from its kept children, and return the bytes of `node`. */
function measure(node: SizedNode): number {
  switch (node.kind) {
    case "leaf":
    case "string":
      return node.bytes;
    case "array": {
      let bytes = 2 + Math.max(0, node.kept - 1);

      for (const item of node.items.slice(0, node.kept)) bytes += measure(item);

      node.bytes = bytes;

      return bytes;
    }

    case "object": {
      let bytes = 2 + Math.max(0, node.kept - 1);

      for (const field of node.fields.slice(0, node.kept)) {
        bytes += field.keyBytes + measure(field.node);
      }

      node.bytes = bytes;

      return bytes;
    }

    default:
      return assertNever(node, "bound node");
  }
}

/** The kept children of a container, for a walk over what the model would see. */
function keptChildren(node: SizedNode): SizedNode[] {
  if (node.kind === "array") return node.items.slice(0, node.kept);

  if (node.kind === "object") return node.fields.slice(0, node.kept).map((field) => field.node);

  return [];
}

/**
 * The part to cut next. A list or a long string comes first, the largest of them, so a list loses
 * whole items and the one long string of a single record is cut. An object loses fields only when
 * no list or long string is left, because its fields hold the cursor.
 */
function nextCut(root: SizedNode, leaves: boolean): Cuttable | null {
  let best: ArrayNode | StringNode | null = null;
  let bestObject: ObjectNode | null = null;
  const stack: SizedNode[] = [root];

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (!leaves) {
      // Only fields from here: skip the lists and strings.
    } else if (node.kind === "array" && node.kept > 1 && (!best || node.bytes > best.bytes)) {
      best = node;
    } else if (
      node.kind === "string" &&
      node.kept > MIN_CUT_STRING_CHARS &&
      (!best || node.bytes > best.bytes)
    ) {
      best = node;
    }

    if (node.kind === "object" && node.kept > 1 && (!bestObject || node.bytes > bestObject.bytes)) {
      bestObject = node;
    }

    stack.push(...keptChildren(node));
  }

  return best ?? bestObject;
}

/** Remove at least `over` bytes from `node`, or as many as it can give. */
function cut(node: Cuttable, over: number): void {
  switch (node.kind) {
    case "array": {
      let removed = 0;

      while (node.kept > 1 && removed < over) {
        node.kept--;
        removed += (node.items[node.kept]?.bytes ?? 0) + 1;
      }

      return;
    }

    case "object": {
      let removed = 0;

      while (node.kept > 1 && removed < over) {
        node.kept--;
        const field = node.fields[node.kept];

        removed += field ? field.keyBytes + field.node.bytes + 1 : 1;
      }

      return;
    }

    case "string": {
      // The bytes of one character vary, so take the share of characters that leaves the share of
      // bytes, and let the next round cut again when that was not enough.
      const share = Math.max(0, node.bytes - over) / node.bytes;
      let kept = Math.max(MIN_CUT_STRING_CHARS, Math.floor(node.kept * share));

      kept = Math.min(kept, node.kept - 1);

      // Do not split a surrogate pair.
      if (isHighSurrogate(node.value.charCodeAt(kept - 1))) kept--;

      node.kept = kept;
      node.bytes = jsonByteLength(cutString(node));

      return;
    }

    default:
      return assertNever(node, "bound node");
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function cutString(node: StringNode): string {
  return node.kept < node.value.length
    ? `${node.value.slice(0, node.kept)}${STRING_CUT_MARK}`
    : node.value;
}

/** Build the bounded value, and add a cut for each part that lost something. */
function emit(node: SizedNode, path: string, cuts: ResultCut[]): JsonValue {
  switch (node.kind) {
    case "leaf":
      return node.value;
    case "string":
      if (node.kept < node.value.length) {
        cuts.push({ path, unit: "chars", kept: node.kept, total: node.value.length });
      }

      return cutString(node);
    case "array":
      if (node.kept < node.items.length) {
        cuts.push({ path, unit: "items", kept: node.kept, total: node.items.length });
      }

      return node.items.slice(0, node.kept).map((item, i) => emit(item, `${path}[${i}]`, cuts));
    case "object": {
      if (node.kept < node.fields.length) {
        cuts.push({ path, unit: "fields", kept: node.kept, total: node.fields.length });
      }

      return Object.fromEntries(
        node.fields
          .slice(0, node.kept)
          .map((field) => [field.key, emit(field.node, childPath(path, field.key), cuts)]),
      );
    }

    default:
      return assertNever(node, "bound node");
  }
}

/** A cut as the note lists it, with a path of at most {@link MAX_PATH_CHARS}. */
function listedCut(cut: ResultCut): ResultCut {
  return cut.path.length > MAX_PATH_CHARS
    ? { ...cut, path: `${cut.path.slice(0, MAX_PATH_CHARS)}${STRING_CUT_MARK}` }
    : cut;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function childPath(path: string, key: string): string {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Bound a result where it goes to the model (ADR-0130 decision 5). A result within the limit
 * comes back as the same value with no note. Otherwise each round cuts the largest list or long
 * string from its end until the result and its note fit.
 */
export function boundForModel(
  value: JsonValue,
  limitBytes: number = MODEL_RESULT_MAX_BYTES,
): BoundedResult {
  const root = sized(value);
  const totalBytes = measure(root);

  if (totalBytes <= limitBytes) return { value };

  const target = limitBytes - NOTE_RESERVE_BYTES;
  let bytes = totalBytes;

  for (let round = 0; bytes > target && round < MAX_ROUNDS; round++) {
    const part = nextCut(root, round < LEAF_ROUNDS);

    if (!part) break;
    cut(part, bytes - target);
    bytes = measure(root);
  }

  if (bytes > target) {
    return {
      value: null,
      truncation: {
        limitBytes,
        totalBytes,
        cuts: [{ path: "$", unit: "value", kept: 0, total: 1 }],
        note: DROPPED_NOTE,
      },
    };
  }

  const cuts: ResultCut[] = [];
  const bounded = emit(root, "$", cuts);
  const more = cuts.length - MAX_LISTED_CUTS;

  return {
    value: bounded,
    truncation: {
      limitBytes,
      totalBytes,
      cuts: cuts.slice(0, MAX_LISTED_CUTS).map(listedCut),
      ...(more > 0 ? { moreCuts: more } : {}),
      note: TRUNCATION_NOTE,
    },
  };
}
