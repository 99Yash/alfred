/**
 * Run one read-only Code Mode script (ADR-0124, ADR-0087 substrate).
 *
 * The deep module of the read path: a script, a table of host reads, and the limits go in. The
 * honest outcome and the host-side call ledger come out. Each `RunError` code maps to one named
 * outcome, so no failure reaches the model as a generic message. Dispatch owns the ledger, and the
 * host writes it here, so guest code cannot change it.
 */

import { getHostFunctionContext, run, RunError, type HostFunctions, type RunLimits } from "run";
import {
  isJsonObject,
  isRecord,
  sanitizeErrorMessage,
  toJsonValue,
  type JsonValue,
} from "@alfred/contracts";
import { sha256Canonical } from "@alfred/db/hash";
import { logger } from "@alfred/logging";
import {
  HOST_READ_DELIVERY_MAX_BYTES,
  SCRIPT_FAILURE_MESSAGE_MAX_CHARS,
  SCRIPT_VALUE_MAX_BYTES,
  scriptReadTooLarge,
} from "./result-budget";
import type {
  HostCallEntry,
  HostCallLedger,
  HostCallSettlement,
  HostReadOutcome,
} from "../internal/registry";

/**
 * One host function: its guest path (`contacts.search`), and the read behind it or a host value.
 * A `read` is a nested dispatch: it has a ledger entry and waits for a read slot. A `value` is not
 * a read (for example `time.now()`): it has no dispatch, no ledger entry, and no slot.
 */
export type HostBinding = HostReadBinding | HostValueBinding;

interface HostReadBinding {
  /** `<group>.<name>`. The guest calls it as `group.name(...args)`. */
  path: string;
  read: (args: readonly unknown[], requestIndex: number) => Promise<HostReadOutcome>;
}

interface HostValueBinding {
  path: string;
  value: (args: readonly unknown[]) => JsonValue;
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
  | { status: "completed"; value: JsonValue; ledger: readonly HostCallEntry[] }
  | {
      status: ReadProgramFailure;
      message: string;
      ledger: readonly HostCallEntry[];
    };

/**
 * The read path's limits. The wall clock stays under the 180 s chat turn ceiling. The result cap
 * is `run`'s 1 MiB: the staging row keeps the whole value, and the model reads a copy that the one
 * size rule bounds (ADR-0130 decision 5).
 *
 * `run` ends the whole script when its in-flight limit is reached, and a guest `catch` cannot
 * stop that (measured on run@2.1.13: the ninth of nine parallel reads ended the script). So
 * `run`'s in-flight limit equals the total, and the host queues reads instead
 * ({@link HOST_READS_IN_FLIGHT}).
 */
export const READ_PROGRAM_LIMITS = {
  timeoutMs: 90_000,
  cpuTimeoutMs: 10_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxResultBytes: SCRIPT_VALUE_MAX_BYTES,
  maxBridgeRequests: 256,
  maxInFlightBridgeRequests: 256,
  // `run`'s default, stated here because the host's delivery cap must stay below it.
  maxHostFunctionOutputBytes: 4 * 1024 * 1024,
} as const satisfies RunLimits;

/** Host reads that dispatch at once. One `Promise.all` cannot open 32 dispatches; the rest wait. */
export const HOST_READS_IN_FLIGHT = 8;

export async function runReadProgram(args: {
  source: string;
  hosts: readonly HostBinding[];
  /** Dispatch's ledger of this call. It freezes when `run` returns. */
  ledger: HostCallLedger;
  /** For the log line of an `internal` failure only. */
  runId: string;
}): Promise<ReadProgramOutcome> {
  const slots = new HostReadSlots(HOST_READS_IN_FLIGHT);

  // After `run` returns, no queued read may start: the script that asked for it has ended.
  // A read in flight at that time stays `unfinished`: dispatch takes no abort signal, so it runs
  // to its own deadline, and the frozen ledger ignores its late settlement.
  return runScript(args, slots).finally(() => slots.close());
}

async function runScript(
  args: { source: string; hosts: readonly HostBinding[]; ledger: HostCallLedger; runId: string },
  slots: HostReadSlots,
): Promise<ReadProgramOutcome> {
  const limits = READ_PROGRAM_LIMITS;
  // Outside the `try`: a bad host path is a boot fault, not a run outcome.
  const functions = hostFunctions(args.hosts, args.ledger, slots);

  try {
    const result = await run({ source: args.source, hostFunctions: functions, limits });

    const ledger = args.ledger.freeze();

    // No host function interrupts, so `run` can only complete.
    if (result.status !== "completed") {
      return failure("internal", "The script stopped on an interrupt.", ledger);
    }

    // `run-js-v1` carries `Date`, `Map`, and `undefined`; the model reads their JSON form.
    return { status: "completed", value: toJsonValue(result.value), ledger };
  } catch (error) {
    const ledger = args.ledger.freeze();

    if (RunError.isInstance(error)) return failureFromRunError(error, limits, ledger, args.runId);

    // A sandbox fault. Return it as an outcome, so the caller still writes the record of the
    // reads that ran (ADR-0124 amendment: failed runs keep a record too).
    logger.error(
      { err: error, event: "code_run_internal_failure", runId: args.runId },
      "Code Mode run threw outside the sandbox's error codes",
    );

    return failure("internal", "The sandbox failed. This is not a fault of the script.", ledger);
  }
}

/** Group the bindings into `run`'s `{ group: { name } }` shape, each read wrapped by the ledger. */
function hostFunctions(
  bindings: readonly HostBinding[],
  ledger: HostCallLedger,
  slots: HostReadSlots,
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

    if (members.has(name)) throw new Error(`[code-mode] two host functions at '${binding.path}'`);

    if ("value" in binding) {
      const { value } = binding;

      members.set(name, async (...guestArgs: unknown[]) => value(guestArgs));
      continue;
    }

    members.set(name, async (...guestArgs: unknown[]) => {
      // The entry exists from the request, also for a read that waits for a slot.
      const { requestIndex } = getHostFunctionContext();
      const settle = ledger.begin(requestIndex, binding.path);

      return slots.run(() => callHost(binding, guestArgs, requestIndex, settle));
    });
  }

  return Object.fromEntries(
    [...groups].map(([group, members]) => [group, Object.fromEntries(members)]),
  );
}

/**
 * A queue that runs at most `size` host reads at once, in arrival order. `close` ends the queue
 * when the script ends: each waiting read and each later request is refused, not started.
 */
class HostReadSlots {
  #free: number;
  #closed = false;
  readonly #waiting: { start: () => void; refuse: (error: RunError) => void }[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  async run<T>(read: () => Promise<T>): Promise<T> {
    if (this.#closed) throw scriptEnded();

    if (this.#free > 0) this.#free -= 1;
    else {
      await new Promise<void>((start, refuse) => this.#waiting.push({ start, refuse }));
    }

    try {
      return await read();
    } finally {
      // Hand the slot to the next waiter, or free it.
      const next = this.#waiting.shift();

      if (next) next.start();
      else this.#free += 1;
    }
  }

  close(): void {
    this.#closed = true;

    for (const waiter of this.#waiting.splice(0)) waiter.refuse(scriptEnded());
  }
}

/** The guest never sees it: `run` has returned, and the read must not start. */
function scriptEnded(): RunError {
  return new RunError("The script ended before this read started.", "RUN_ABORTED");
}

async function callHost(
  binding: HostReadBinding,
  guestArgs: readonly unknown[],
  requestIndex: number,
  settle: (settlement: HostCallSettlement) => void,
): Promise<JsonValue> {
  let outcome: HostReadOutcome;

  try {
    outcome = await binding.read(guestArgs, requestIndex);
  } catch (error) {
    // A dispatch fault, not a reader outcome. The record keeps the call as failed, with no
    // call facts. The guest gets "Host function failed." (measured on run@2.1.13).
    settle({
      kind: "failed",
      call: undefined,
      message: "The read failed inside the host.",
      evidence: undefined,
      contentHash: null,
      savedBytes: null,
    });
    throw error;
  }

  if (outcome.kind === "refused") {
    settle({
      kind: outcome.refusal,
      call: outcome.call,
      message: outcome.message,
      evidence: undefined,
      contentHash: null,
      savedBytes: null,
      ...((outcome.refusal === "needs_approval" || outcome.refusal === "rejected") &&
      outcome.approvalCause
        ? { approvalCause: outcome.approvalCause }
        : {}),
    });
    // Only a `RunError` reaches the guest with its message and code; any other throw arrives
    // as "Host function failed." (measured on run@2.1.13).
    throw new RunError(`${binding.path}: ${outcome.message}`, outcome.refusal);
  }

  // The record says `executed` only for a value that the bridge delivers. Dispatch refuses a
  // staged read above the cap before it saves it, so this catches a `fast_path` read, which saves
  // nothing, and a row saved before that check existed.
  if (outcome.bytes > HOST_READ_DELIVERY_MAX_BYTES) {
    const { message } = scriptReadTooLarge(outcome.bytes);

    settle({
      kind: "output_too_large",
      call: outcome.call,
      message,
      evidence: undefined,
      contentHash: null,
      savedBytes: outcome.call.stagingId === null ? null : outcome.bytes,
    });
    throw new RunError(`${binding.path}: ${message}`, "output_too_large");
  }

  settle({
    kind: isJsonObject(outcome.value) && outcome.value.ok === false ? "tool_error" : "executed",
    call: outcome.call,
    message: undefined,
    evidence: outcome.evidence,
    // The value that the guest gets, whole and sanitized: no bound of Alfred's cut it (ADR-0124
    // amendment 2026-11-18 (b)). A provider's own cut stays in the evidence's coverage.
    contentHash: sha256Canonical(outcome.value),
    savedBytes: outcome.call.stagingId === null ? null : outcome.bytes,
  });

  return outcome.value;
}

function failureFromRunError(
  error: RunError,
  limits: RunLimits,
  ledger: readonly HostCallEntry[],
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
      return failure("too_many_calls", bridgeLimitMessage(error, limits), ledger);
    case "RUN_SOURCE_TOO_LARGE":
      return failure("source_too_large", "The script source is too long.", ledger);
    case "RUN_SERIALIZATION_ERROR":
      return failure(
        "result_too_large_or_not_json",
        `The return value must be plain JSON data under ${kib(limits.maxResultBytes)}: ` +
          error.message,
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

/** `run` uses one code for three limits. Its `details` names the limit that the script reached. */
function bridgeLimitMessage(error: RunError, limits: RunLimits): string {
  const has = (key: string) => isRecord(error.details) && key in error.details;

  if (has("maxBridgeRequests")) {
    return `The script made more than ${limits.maxBridgeRequests ?? "the allowed"} reads. Make fewer reads, or split the job.`;
  }

  if (has("maxInFlightBridgeRequests")) {
    return `The script had more than ${limits.maxInFlightBridgeRequests ?? "the allowed"} reads waiting at once.`;
  }

  return `One read's arguments or result was too large for the sandbox bridge: ${error.message}`;
}

function failure(
  status: ReadProgramFailure,
  message: string,
  ledger: readonly HostCallEntry[],
): ReadProgramOutcome {
  // A guest error message has no length limit of its own (ADR-0124: the result budget).
  return {
    status,
    message: sanitizeErrorMessage(message, SCRIPT_FAILURE_MESSAGE_MAX_CHARS),
    ledger,
  };
}

/** The last refused read, so an uncaught failure names its cause. */
function lastRefusal(ledger: readonly HostCallEntry[]): string {
  const refused = ledger.findLast(
    (entry) =>
      entry.kind !== "executed" && entry.kind !== "tool_error" && entry.kind !== "unfinished",
  );

  return refused ? ` (${refused.path} #${refused.index}: ${refused.kind})` : "";
}

const mib = (bytes: number | undefined) => `${Math.round((bytes ?? 0) / (1024 * 1024))} MiB`;

const kib = (bytes: number | undefined) => `${Math.round((bytes ?? 0) / 1024)} KiB`;

const seconds = (ms: number | undefined) => `${Math.round((ms ?? 0) / 1000)} s`;
