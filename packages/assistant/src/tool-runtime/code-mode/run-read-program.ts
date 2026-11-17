/**
 * Run one read-only Code Mode script (ADR-0124, ADR-0087 substrate).
 *
 * The deep module of the read path: a script, a table of host reads, and the limits go in. The
 * honest outcome and the host-side call ledger come out. Each `RunError` code maps to one named
 * outcome, so no failure reaches the model as a generic message. The ledger is written here, on
 * the host side, so guest code cannot change it.
 */

import { getHostFunctionContext, run, RunError, type HostFunctions, type RunLimits } from "run";
import { isJsonObject, toJsonValue, type JsonValue } from "@alfred/contracts";
import { logger } from "@alfred/logging";
import type { HostReadOutcome, HostReadRefusal } from "../internal/registry";

/** One host function: its guest path (`contacts.search`) and the read behind it. */
export interface HostBinding {
  /** `<group>.<name>`. The guest calls it as `group.name(...args)`. */
  path: string;
  read: (args: readonly unknown[], requestIndex: number) => Promise<HostReadOutcome>;
}

/**
 * One host call, as the host saw it. `tool_error`: it executed and returned `ok: false` (an MCP
 * `isError`, a provider failure the tool reports in its value).
 */
export interface ReadProgramLedgerEntry {
  index: number;
  path: string;
  kind: "executed" | "tool_error" | HostReadRefusal;
  ms: number;
}

/**
 * Why a script did not complete. `script_error` covers an uncaught guest error and the memory
 * limit: `run` reports both as `RUN_USER_SOURCE_ERROR`, so the code cannot tell them apart.
 */
export type ReadProgramFailure =
  | "script_error"
  | "uncaught_read_failure"
  | "timeout"
  | "cpu_timeout"
  | "too_many_calls"
  | "source_too_large"
  | "result_too_large_or_not_json"
  | "unawaited_call"
  | "busy"
  | "internal";

export type ReadProgramOutcome =
  | { status: "completed"; value: JsonValue; ledger: readonly ReadProgramLedgerEntry[] }
  | {
      status: ReadProgramFailure;
      message: string;
      ledger: readonly ReadProgramLedgerEntry[];
    };

/**
 * The read path's limits. The wall clock stays under the 180 s chat turn ceiling. The result cap
 * is far below `run`'s 1 MiB: only the return value reaches the model, so a script trims first.
 * Eight reads in flight keeps one `Promise.all` from opening 32 dispatches at once.
 */
export const READ_PROGRAM_LIMITS = {
  timeoutMs: 90_000,
  cpuTimeoutMs: 10_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxResultBytes: 64 * 1024,
  maxBridgeRequests: 256,
  maxInFlightBridgeRequests: 8,
} as const satisfies RunLimits;

export async function runReadProgram(args: {
  source: string;
  hosts: readonly HostBinding[];
  /** For the log line of an `internal` failure only. */
  runId: string;
}): Promise<ReadProgramOutcome> {
  const ledger: ReadProgramLedgerEntry[] = [];
  const limits = READ_PROGRAM_LIMITS;

  try {
    const result = await run({
      source: args.source,
      hostFunctions: hostFunctions(args.hosts, ledger),
      limits,
    });

    // No host function interrupts, so `run` can only complete.
    if (result.status !== "completed") {
      return failure("internal", "The script stopped on an interrupt.", ledger);
    }

    // `run-js-v1` carries `Date`, `Map`, and `undefined`; the model reads their JSON form.
    return { status: "completed", value: toJsonValue(result.value), ledger };
  } catch (error) {
    if (!RunError.isInstance(error)) throw error;

    return failureFromRunError(error, limits, ledger, args.runId);
  }
}

/** Group the bindings into `run`'s `{ group: { name } }` shape, each wrapped by the ledger. */
function hostFunctions(
  bindings: readonly HostBinding[],
  ledger: ReadProgramLedgerEntry[],
): HostFunctions {
  const groups = new Map<string, Map<string, (...guestArgs: never[]) => Promise<JsonValue>>>();

  for (const binding of bindings) {
    const [group, name, ...rest] = binding.path.split(".");

    if (!group || !name || rest.length > 0) {
      throw new Error(`[code-mode] host path must be '<group>.<name>': '${binding.path}'`);
    }

    const members =
      groups.get(group) ?? new Map<string, (...guestArgs: never[]) => Promise<JsonValue>>();

    groups.set(group, members);
    members.set(name, async (...guestArgs: unknown[]) => callHost(binding, guestArgs, ledger));
  }

  return Object.fromEntries(
    [...groups].map(([group, members]) => [group, Object.fromEntries(members)]),
  );
}

async function callHost(
  binding: HostBinding,
  guestArgs: readonly unknown[],
  ledger: ReadProgramLedgerEntry[],
): Promise<JsonValue> {
  const { requestIndex } = getHostFunctionContext();
  const started = performance.now();
  const outcome = await binding.read(guestArgs, requestIndex);
  const ms = Math.round(performance.now() - started);

  if (outcome.kind === "refused") {
    ledger.push({ index: requestIndex, path: binding.path, kind: outcome.refusal, ms });
    // Only a `RunError` reaches the guest with its message and code; any other throw arrives
    // as "Host function failed." (measured on run@2.1.13).
    throw new RunError(`${binding.path}: ${outcome.message}`, outcome.refusal);
  }

  const kind =
    isJsonObject(outcome.value) && outcome.value.ok === false ? "tool_error" : "executed";

  ledger.push({ index: requestIndex, path: binding.path, kind, ms });

  return outcome.value;
}

function failureFromRunError(
  error: RunError,
  limits: RunLimits,
  ledger: readonly ReadProgramLedgerEntry[],
  runId: string,
): ReadProgramOutcome {
  // `run` mints only `RUN_*` codes. Any other code is a refused read that the script did not
  // catch: `run` passes the host's `RunError` through unchanged (measured on run@2.1.13).
  if (!error.code.startsWith("RUN_")) {
    return failure(
      "uncaught_read_failure",
      `A read failed and the script did not catch it (${error.code}): ${error.message}. Wrap ` +
        "each call in try/catch and return what succeeded.",
      ledger,
    );
  }

  switch (error.code) {
    case "RUN_USER_SOURCE_ERROR":
      return failure(
        "script_error",
        `The script threw, or it used more than the ${mib(limits.memoryLimitBytes)} memory ` +
          `limit (the sandbox reports both the same way): ${error.message}`,
        ledger,
      );
    case "RUN_HOST_FUNCTION_ERROR":
      return failure(
        "uncaught_read_failure",
        `A read failed and the script did not catch it${lastRefusal(ledger)}. Wrap each call in ` +
          "try/catch and return what succeeded.",
        ledger,
      );
    case "RUN_TIMEOUT":
      return failure(
        "timeout",
        `The script ran longer than ${seconds(limits.timeoutMs)}. Make fewer reads, or split the job.`,
        ledger,
      );
    case "RUN_CPU_TIMEOUT":
      return failure(
        "cpu_timeout",
        `The script computed for longer than ${seconds(limits.cpuTimeoutMs)}, not counting reads.`,
        ledger,
      );
    case "RUN_BRIDGE_LIMIT":
      return failure(
        "too_many_calls",
        `The script made more than ${limits.maxBridgeRequests ?? "the allowed"} reads.`,
        ledger,
      );
    case "RUN_SOURCE_TOO_LARGE":
      return failure("source_too_large", "The script source is too long.", ledger);
    case "RUN_SERIALIZATION_ERROR":
      return failure(
        "result_too_large_or_not_json",
        `The return value must be plain JSON data under ${kib(limits.maxResultBytes)}. Return ` +
          `only the fields the answer needs: ${error.message}`,
        ledger,
      );
    case "RUN_DETACHED_BRIDGE_REQUEST":
      return failure(
        "unawaited_call",
        `A read was started and not awaited: ${error.message}`,
        ledger,
      );
    case "RUN_CONCURRENCY_LIMIT":
      return failure("busy", "The sandbox is busy. Try the same script again one time.", ledger);
    case "RUN_ABORTED":
    case "RUN_PROTOCOL_ERROR":
    default:
      logger.error(
        { err: error, event: "code_run_internal_failure", code: error.code, runId },
        "Code Mode run failed inside the sandbox",
      );

      return failure("internal", "The sandbox failed. This is not a fault of the script.", ledger);
  }
}

function failure(
  status: ReadProgramFailure,
  message: string,
  ledger: readonly ReadProgramLedgerEntry[],
): ReadProgramOutcome {
  return { status, message, ledger };
}

/** The last refused read, so an uncaught failure names its cause. */
function lastRefusal(ledger: readonly ReadProgramLedgerEntry[]): string {
  const refused = ledger.findLast(
    (entry) => entry.kind !== "executed" && entry.kind !== "tool_error",
  );

  return refused ? ` (${refused.path} #${refused.index}: ${refused.kind})` : "";
}

const mib = (bytes: number | undefined) => `${Math.round((bytes ?? 0) / (1024 * 1024))} MiB`;

const kib = (bytes: number | undefined) => `${Math.round((bytes ?? 0) / 1024)} KiB`;

const seconds = (ms: number | undefined) => `${Math.round((ms ?? 0) / 1000)} s`;
