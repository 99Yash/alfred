/**
 * The `system.code_run` description: how to write a safe script (ADR-0124 decision 7), and the
 * index of host functions (decision 3). Each index line has the tool's first sentence, its input
 * from the model-facing schema, and its output from the compiler (`guest-index.generated.ts`).
 */

import { collapseWhitespace, MODEL_RESULT_MAX_BYTES } from "@alfred/contracts";
import { z } from "zod";
import type { RegisteredTool } from "../internal/registry";
import { GUEST_OUTPUT_TYPES } from "./guest-index.generated";
import { MCP_READ_PATH, TIME_NOW_PATH } from "./host-bindings";
import { HOST_READ_DELIVERY_MAX_BYTES } from "./result-budget";
import { RESULT_HANDLE_TTL_DAYS } from "../result-handle-store";
import { HOST_READS_IN_FLIGHT, READ_PROGRAM_LIMITS } from "./run-read-program";

type GuestPath = keyof typeof GUEST_OUTPUT_TYPES;

/**
 * The host paths that every index lists: the clock is not a read and needs no connection.
 * `mcp.read` is listed with the MCP discovery reads (`codeRunIndexPaths`).
 */
const ALWAYS_LISTED_PATHS: ReadonlySet<string> = new Set([TIME_NOW_PATH]);

/**
 * The paths that one run's index lists (ADR-0130 decision 6): `time.now`, the read tools that
 * the run can call, and `mcp.read` when the run can call the MCP discovery reads. Sorted, so the
 * same reads give the same description, and the prompt cache holds.
 */
export function codeRunIndexPaths(callableReads: readonly string[]): string[] {
  const paths = new Set([...callableReads, ...ALWAYS_LISTED_PATHS]);

  if (callableReads.some((name) => name.startsWith("mcp."))) paths.add(MCP_READ_PATH);

  return [...paths].toSorted();
}

/**
 * The description, built from the registered read tools. Throws when the read tools and the
 * generated index disagree, so a new `codeModeRead` tool cannot ship without its output type.
 * `listed` limits the index lines to one run's paths (`codeRunIndexPaths`). Without it, the index
 * lists every host function: the boot description, which a run with no pinned index keeps.
 */
export function codeRunDescription(
  readTools: readonly RegisteredTool[],
  listed?: ReadonlySet<string>,
): string {
  const indexed = new Set<string>(Object.keys(GUEST_OUTPUT_TYPES));
  const hostPaths = [MCP_READ_PATH, TIME_NOW_PATH];
  const declared = new Set<string>([...readTools.map((tool) => tool.name), ...hostPaths]);
  const missing = [...declared].filter((path) => !indexed.has(path));
  const extra = [...indexed].filter((path) => !declared.has(path));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `[code-mode] the index and the codeModeRead tools disagree (missing: ${missing.join(", ") || "none"}; ` +
        `extra: ${extra.join(", ") || "none"}). Add the tool to codegen/code-mode-guest-index.ts and ` +
        "run node scripts/generate-code-mode-index.mjs",
    );
  }

  const isListed = (path: string): boolean => listed === undefined || listed.has(path);

  const lines = readTools
    .filter((tool) => isListed(tool.name))
    .map((tool) =>
      indexLine(
        tool.name,
        firstSentence(tool.description),
        inputParam(tool),
        outputType(tool.name),
      ),
    );

  if (isListed(MCP_READ_PATH)) {
    lines.push(
      indexLine(
        MCP_READ_PATH,
        "Call one read-only tool of a connected MCP server (Gmail, Calendar, GitHub, and others).",
        'ref: <a ref whose route is "script", from mcp.list_tools or system.search_tools>, args?: { [key: string]: JsonValue }',
        outputType(MCP_READ_PATH),
      ),
    );
  }

  lines.push(
    indexLine(
      TIME_NOW_PATH,
      "The time now, in the user's timezone.",
      "",
      outputType(TIME_NOW_PATH),
    ),
  );

  return [
    "Read the user's data by running one JavaScript (or TypeScript) script. Every read is an async " +
      "function below. The script gets each full result, up to " +
      `${HOST_READ_DELIVERY_MAX_BYTES / 1024} KiB for one read, and only the value the script ` +
      "returns comes back to you.",
    "",
    "How to write the script:",
    "- Top-level `await` and `return` work. Return plain JSON data under " +
      `${READ_PROGRAM_LIMITS.maxResultBytes / 1024} KiB. You read at most ` +
      `${MODEL_RESULT_MAX_BYTES / 1024} KiB of it: a larger value keeps whole list items from the ` +
      "start, and its `truncation` names each cut with the kept and total counts.",
    `- Alfred stores each value that a script returns, for ${RESULT_HANDLE_TTL_DAYS} days, and ` +
      "gives its `handle`. A later " +
      "script reads the whole value with `system.load_result({ handle })`, so do not read the " +
      "same data again. Each earlier turn ends with a line for each stored result: its handle, " +
      "the input that made it, the item count, and the fetch time. Fetch again only when the data " +
      "is too old for the question.",
    "- Code can filter by known fields (state, labels, dates, authors). Code cannot judge prose, " +
      "so return the text that you must read to answer.",
    "- Wrap each read in try/catch. A failed read throws an Error whose `code` says why: " +
      "`needs_approval` (the read waits for the user's approval: call it directly instead), `not_a_read`, " +
      "`invalid_input`, `not_allowed`, `failed`, and others. Return what succeeded, and the failures.",
    "- Use Promise.all for reads that do not depend on each other. The host runs at most " +
      `${HOST_READS_IN_FLIGHT} at once and queues the rest. Await every read.`,
    `- The script stops after ${READ_PROGRAM_LIMITS.timeoutMs / 1000} s and ` +
      `${READ_PROGRAM_LIMITS.maxBridgeRequests} reads. It has no network, no imports, and no ` +
      "timers. `Date.now()` and `Math.random()` are fixed for the run, and `Date` uses the server's " +
      "timezone: get the user's date and time from `time.now()`.",
    ...(isListed(MCP_READ_PATH)
      ? [
          "- MCP tools: find one with `mcp.list_tools({ query })`, read its schemas with " +
            '`mcp.inspect_tool({ ref })`, and call a hit whose `route` is `"script"` with ' +
            '`mcp.read(ref, args)`. A `"direct"` hit runs only as a direct mcp.call. `mcp.read` returns ' +
            '`{ status: "completed", result }` on success. If the tool has no output schema, first ' +
            "return a short sample of `result`, then write the real script.",
        ]
      : []),
    "",
    "type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };",
    "",
    ...lines,
  ].join("\n");
}

function indexLine(path: string, summary: string, params: string, output: string): string {
  return `// ${summary}\n${path}(${params}): Promise<${output}>`;
}

function outputType(path: string): string {
  // SAFETY: `codeRunDescription` checked that every path it renders is a key of the index.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- key checked against the index above
  return GUEST_OUTPUT_TYPES[path as GuestPath];
}

/** The first sentence, at most 200 characters, so a long tool description stays one line. */
function firstSentence(description: string): string {
  const sentence = /^.*?[.!?](?=\s|$)/s.exec(description)?.[0] ?? description;
  const oneLine = collapseWhitespace(sentence);

  return oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
}

/** The tool's model-facing input as one parameter, from the JSON Schema the model sees. */
function inputParam(tool: RegisteredTool): string {
  const schema = z.toJSONSchema(tool.modelInputSchema, {
    io: "input",
    reused: "inline",
    unrepresentable: "any",
  });

  // An input with no required field may be left out.
  const optional = (schema.required ?? []).length === 0 ? "?" : "";

  return `input${optional}: ${renderSchema(schema)}`;
}

type JsonSchema = z.core.JSONSchema.BaseSchema;

/** A compact TypeScript rendering of the JSON Schema subset that zod emits for tool inputs. */
function renderSchema(schema: JsonSchema | boolean | undefined): string {
  if (schema === undefined || schema === true) return "JsonValue";

  if (schema === false) return "never";

  if (schema.const !== undefined) return JSON.stringify(schema.const);

  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");

  const union = schema.anyOf ?? schema.oneOf;

  if (union) return union.map((member) => renderSchema(member)).join(" | ");

  if (schema.allOf) return schema.allOf.map((member) => renderSchema(member)).join(" & ");

  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => renderSchema({ ...schema, type })).join(" | ");
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `${wrapUnion(renderSchema(Array.isArray(schema.items) ? undefined : schema.items))}[]`;
    case "object":
      return renderObject(schema);
    case undefined:
    default:
      return "JsonValue";
  }
}

function renderObject(schema: JsonSchema): string {
  const required = new Set(schema.required ?? []);

  const fields = Object.entries(schema.properties ?? {}).map(([key, property]) => {
    const optional = !required.has(key) || (isSchema(property) && property.default !== undefined);

    return `${key}${optional ? "?" : ""}: ${renderSchema(property)}`;
  });

  const extra = schema.additionalProperties;

  if (extra !== undefined && extra !== false) {
    fields.push(`[key: string]: ${renderSchema(extra)}`);
  }

  return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
}

function isSchema(value: JsonSchema | boolean): value is JsonSchema {
  return value !== true && value !== false;
}

function wrapUnion(type: string): string {
  return type.includes(" | ") || type.includes(" & ") ? `(${type})` : type;
}
