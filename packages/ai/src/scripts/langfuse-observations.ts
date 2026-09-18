/**
 * Read path shared by the manual Langfuse scripts.
 *
 * Self-hosted v4 runs in `events_only` write mode, where the legacy read
 * endpoints — including `GET /api/public/traces/:id` — return 404. A trace is
 * the set of observations that share a `traceId`, and the Observations API v2
 * (`GET /api/public/v2/observations`) is the supported read path in that mode.
 * These scripts therefore read observations by trace id instead of fetching a
 * trace record.
 *
 * `input` and `output` come back as raw (JSON-encoded) strings in v2, so
 * callers that need the structured value run it through `decodeLangfuseIo`.
 */
import { safeJsonParse } from "@alfred/contracts";

/** The slice of a Langfuse observation these scripts read. */
export interface LangfuseObservation {
  id: string;
  traceId: string | null;
  type: string;
  name?: string | null;
  startTime: string;
  endTime?: string | null;
  level?: string | null;
  statusMessage?: string | null;
  environment?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  tags?: string[] | null;
  model?: string | null;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
}

/** Field groups the scripts need — trace identity, attribution, and payloads. */
const OBSERVATION_FIELDS = "core,basic,time,io,metadata,model,usage,trace_context";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Fetch every observation in one trace. Throws a named error when the
 * Observations API v2 itself is missing, so a script fails loudly instead of
 * reading an empty list as "the trace has not ingested yet".
 */
export async function fetchObservationsByTraceId(args: {
  host: string;
  auth: string;
  traceId: string;
  timeoutMs?: number;
}): Promise<LangfuseObservation[]> {
  const url = new URL(`${args.host}/api/public/v2/observations`);

  url.searchParams.set("traceId", args.traceId);
  url.searchParams.set("fields", OBSERVATION_FIELDS);
  url.searchParams.set("limit", "100");

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${args.auth}` },
    signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (res.status === 404 || res.status === 405) {
    throw new Error(
      `Observations API v2 is unavailable at ${args.host} (HTTP ${res.status}). ` +
        "These scripts read traces through GET /api/public/v2/observations; the " +
        "legacy /api/public/traces/:id path returns 404 under events_only.",
    );
  }

  if (!res.ok) {
    throw new Error(`GET observations for ${args.traceId} → ${res.status} ${await res.text()}`);
  }

  // SAFETY: `data` is the response envelope's observation array; every field
  // the scripts read is optional-tolerant, and a missing `data` is treated as
  // an empty (not-yet-ingested) trace.
  const body = (await res.json()) as { data?: LangfuseObservation[] };

  return body.data ?? [];
}

/**
 * v2 returns observation I/O as raw strings. Decode a JSON object/array string
 * back to its value; leave plain text and non-strings untouched so a text
 * completion is not mistaken for a parse failure.
 */
export function decodeLangfuseIo(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;

  return safeJsonParse(trimmed) ?? value;
}
