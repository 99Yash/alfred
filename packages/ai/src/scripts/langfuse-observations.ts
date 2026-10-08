/**
 * Langfuse reads for the manual scripts. Self-hosted v4 runs `events_only`, where
 * `GET /api/public/traces/:id` returns 404, so read v2 observations by trace id.
 */
import { safeJsonParse } from "@alfred/contracts";

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

const OBSERVATION_FIELDS = "core,basic,time,io,metadata,model,usage,trace_context";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Throws when the v2 API is missing, so it is not read as "not ingested yet". */
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

  // SAFETY: every field read is optional, and a missing `data` means not ingested yet.
  const body = (await res.json()) as { data?: LangfuseObservation[] };

  return body.data ?? [];
}

/** v2 returns I/O as JSON strings. Decode objects and arrays; leave plain text alone. */
export function decodeLangfuseIo(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;

  return safeJsonParse(trimmed) ?? value;
}
