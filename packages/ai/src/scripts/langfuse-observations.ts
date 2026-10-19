/**
 * Langfuse reads for the manual scripts. Self-hosted v4 runs `events_only`, where
 * `GET /api/public/traces/:id` returns 404, so read v2 observations by trace id.
 */
import { safeJsonParse } from "@alfred/contracts";
import { z } from "zod";

const langfuseObservationSchema = z.object({
  id: z.string(),
  traceId: z.string().nullable(),
  type: z.string(),
  name: z.string().nullish(),
  startTime: z.string(),
  endTime: z.string().nullish(),
  level: z.string().nullish(),
  statusMessage: z.string().nullish(),
  environment: z.string().nullish(),
  userId: z.string().nullish(),
  sessionId: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  model: z.string().nullish(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.unknown(),
  usageDetails: z.record(z.string(), z.number()).optional(),
  costDetails: z.record(z.string(), z.number()).optional(),
});

export type LangfuseObservation = z.infer<typeof langfuseObservationSchema>;

/** A missing `data` means the trace is not ingested yet. */
const observationsResponseSchema = z.object({
  data: z.array(langfuseObservationSchema).optional(),
});

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

  const raw: unknown = await res.json();
  const body = observationsResponseSchema.parse(raw);

  return body.data ?? [];
}

/** v2 returns I/O as JSON strings. Decode objects and arrays; leave plain text alone. */
export function decodeLangfuseIo(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;

  return safeJsonParse(trimmed) ?? value;
}
