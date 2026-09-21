import {
  canonicalizeRailwayTargetId,
  getPath,
  type IntegrationActivityItem,
} from "@alfred/contracts";
import {
  deliveryInstantFromDate,
  objectStateStore,
  type ObjectState,
} from "@alfred/assistant/connections";
import {
  builtInProviderForEndpoint,
  getMcpConnectionManager,
  listOwnedConnections,
  RAILWAY_MCP_STORED_ISSUER,
  type McpPreparedToolCall,
} from "@alfred/assistant/connections/mcp";
import { RAILWAY_PULL_EVENT_TYPE } from "@alfred/assistant/connections/object-state/railway-reducer";
import { z } from "zod";

/**
 * The verified pull for failure-only providers (#1094) — the second named
 * closure source beside the verified push (ADR-0062 amendment 2026-09-20).
 *
 * Railway mails a build failure and stays silent on success, so email
 * evidence can observe the failure and can never observe the recovery. This
 * seam takes an authenticated read of CURRENT deployment state at gather
 * time instead: one read holds the whole answer, and a read proving a later
 * success folds through the same store guards every push travels
 * (unknown kind/unknown token no-write, per-kind absorbing, the
 * `(providerEventTime, deliveredAt)` recency rule).
 *
 * What the fold buys is trigger and verdict state, not email-loop closure:
 * the folded rows re-arm the next gather's trigger (failed/active rows
 * re-verify) and dedup identical reads, and the pull appends verified
 * red/green verdict lines beside the failure mail. It does NOT drop the
 * email loop through `reconcileEvidence` — the Railway adapter proposes no
 * keys until the deployment-URL grammar lands, so no Railway row reaches
 * the closure reader today.
 *
 * The Railway MCP catalog publishes `list-services` and `list-deployments`.
 * The read uses the user's ready, issuer-pinned connection and parses only
 * structured tool output. Missing tools, invalid output, and remote errors
 * prove nothing and leave the loop live.
 *
 * Approval floors gate AGENT discretion; this deterministic gather-time read
 * over a user-connected grant is the calendar/weather gatherer pattern, so
 * it bypasses staging/approval by construction and holds no write tool.
 */

/** A Railway deployment target: the identity a pull reads. */
export interface RailwayPullTarget {
  projectId: string;
  serviceId: string;
  environmentId: string;
}

/** Display names for a target, best-effort — identity never depends on them. */
interface RailwayTargetNames {
  project: string;
  service: string;
  environment: string;
}

/**
 * What one authenticated read proved, parsed from `unknown` at the transport
 * boundary. `null` from the reader means the read failed, timed out, or
 * returned an unknown state — the caller mints nothing, so the loop stays
 * live (ADR-0048-D). A null is never a close.
 */
export interface ParsedRailwayStatus {
  status: "success" | "failure" | "pending";
  deploymentId: string;
  /** Provider-clock instant of the deployment, absent when the API names none. */
  providerEventTime: Date | null;
  url: string | null;
}

const railwayProjectSchema = z.object({ id: z.string().min(1), name: z.string() });

const railwayProjectsSchema = z.object({ projects: z.array(railwayProjectSchema) });

const railwayServicesSchema = z.object({
  project: railwayProjectSchema,
  services: z.array(z.object({ id: z.string().min(1), name: z.string() })),
  environments: z.array(z.object({ id: z.string().min(1), name: z.string() })),
});

const railwayDeploymentSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  createdAt: z.string().nullable(),
  url: z.string().nullable(),
  // The read filters and orders client-side (below), so the item must carry
  // the target it belongs to. Both arrive as strings on the live wire and
  // are absent-tolerant here: a response that omits them is still readable,
  // and only a POSITIVE mismatch drops the item.
  serviceId: z.string().nullable().optional(),
  environmentId: z.string().nullable().optional(),
});

const railwayDeploymentsSchema = z.object({
  deployments: z.array(railwayDeploymentSchema),
});

interface RailwayReadSession {
  connectionId: string;
  prepared: McpPreparedToolCall;
}

/** Prepare a ready, issuer-pinned Railway connection for a bounded pull. */
async function prepareRailwayRead(userId: string): Promise<RailwayReadSession | null> {
  const connections = await listOwnedConnections(userId);

  const connection = connections.find(
    (item) => builtInProviderForEndpoint(item.server.endpointUrl) === "railway",
  );

  if (
    !connection ||
    connection.status !== "ready" ||
    connection.authServerIdentity !== RAILWAY_MCP_STORED_ISSUER
  ) {
    return null;
  }

  return {
    connectionId: connection.id,
    prepared: await getMcpConnectionManager().prepareToolCall(connection.id),
  };
}

async function readRailwayTool<Schema extends z.ZodType>(
  connectionId: string,
  prepared: McpPreparedToolCall,
  remoteName: "list-projects" | "list-services" | "list-deployments",
  args: Record<string, string | number>,
  schema: Schema,
): Promise<z.infer<Schema> | null> {
  const envelope = await prepared.call(
    { kind: "mcp", connectionId, remoteName, catalogRevision: prepared.catalog.revision },
    args,
  );

  if (envelope.outcome !== "completed" || envelope.truncation) return null;

  const parsed = schema.safeParse(getPath(envelope.result, "structuredContent"));

  return parsed.success ? parsed.data : null;
}

/**
 * Read current deployment state for one target over the user's Railway MCP
 * connection. Unknown output or a transport fault is never a guessed state.
 */
export async function readRailwayDeploymentStatus(
  userId: string,
  target: RailwayPullTarget,
): Promise<ParsedRailwayStatus | null> {
  try {
    const read = await prepareRailwayRead(userId);

    return read ? await readRailwayDeploymentStatusFromSession(read, target) : null;
  } catch {
    // A failed read is unverified. It cannot close the loop.
    return null;
  }
}

/**
 * How many deployments one read pulls. The catalog window is 1–50 (default
 * 10); ten is enough to find the newest readable state while staying at the
 * default cost. Never 1: a single row makes the server's return order the
 * verdict, and order is a server claim, not a contract.
 */
const RAILWAY_DEPLOYMENT_READ_LIMIT = 10;

async function readRailwayDeploymentStatusFromSession(
  read: RailwayReadSession,
  target: RailwayPullTarget,
): Promise<ParsedRailwayStatus | null> {
  // Argument names mirror the catalog's `list-deployments` input schema:
  // `projectId` is the one required property; `serviceId`, `environmentId`,
  // and `limit` are optional filters. `prepared.call` validates this object
  // against that live schema and throws `invalid_arguments` on drift, which
  // both callers fold to null — an unverifiable read, never a guessed state.
  const parsed = await readRailwayTool(
    read.connectionId,
    read.prepared,
    "list-deployments",
    {
      projectId: target.projectId,
      serviceId: target.serviceId,
      environmentId: target.environmentId,
      limit: RAILWAY_DEPLOYMENT_READ_LIMIT,
    },
    railwayDeploymentsSchema,
  );

  if (!parsed) return null;

  // The catalog describes the list as most-recent-first, but the verdict
  // must not depend on that claim: drop deployments for other targets, put
  // the newest provider instant first (an absent instant sorts last, keeping
  // server order among ties — the sort is stable), and take the newest
  // deployment whose status is in the registry vocabulary. A newest row with
  // an unknown status (a future enum, a casing drift) yields to the previous
  // readable row instead of failing the whole read.
  const candidates = parsed.deployments
    .filter(
      (deployment) =>
        (deployment.serviceId == null || deployment.serviceId === target.serviceId) &&
        (deployment.environmentId == null || deployment.environmentId === target.environmentId),
    )
    .map((deployment) => ({
      deployment,
      status: collapseRailwayStatus(deployment.status),
      timeMs: parseProviderInstant(deployment.createdAt)?.getTime() ?? null,
    }))
    .filter((candidate) => candidate.status !== null)
    .sort(
      (a, b) => (b.timeMs ?? Number.NEGATIVE_INFINITY) - (a.timeMs ?? Number.NEGATIVE_INFINITY),
    );

  const [latest] = candidates;

  if (!latest?.status) return null;

  return {
    status: latest.status,
    deploymentId: latest.deployment.id,
    providerEventTime: parseProviderInstant(latest.deployment.createdAt),
    url: latest.deployment.url,
  };
}

/**
 * Collapse a Railway deployment status into the registry's outcome
 * vocabulary. Byte-exact on the provider enum: anything unlisted — a future
 * status, a casing drift — reads as unknown, and absence never closes.
 */
function collapseRailwayStatus(status: string): "success" | "failure" | "pending" | null {
  switch (status) {
    case "SUCCESS":
      return "success";
    case "FAILED":
    case "CRASHED":
      return "failure";
    case "BUILDING":
    case "DEPLOYING":
    case "QUEUED":
    case "PENDING":
    case "INITIALIZING":
    case "WAITING":
      return "pending";
    default:
      return null;
  }
}

function parseProviderInstant(value: string | null): Date | null {
  if (!value) return null;

  const time = new Date(value);

  return Number.isNaN(time.getTime()) ? null : time;
}

/**
 * A minted pull receipt: the structured body `reduceRailwayEvent` folds.
 * Named (not anonymous) so the mint's return type keeps its evidence.
 */
export interface RailwayPullReceipt {
  eventType: typeof RAILWAY_PULL_EVENT_TYPE;
  payload: unknown;
}

/**
 * Mint the pull receipt body for a parsed status — the ONLY constructor of
 * the shape `reduceRailwayEvent` folds. Takes `ParsedRailwayStatus`, never
 * text: an email string or adapter output cannot construct it, because no
 * string-taking overload exists (criterion 6).
 */
export function mintRailwayPullReceipt(
  target: RailwayPullTarget,
  parsed: ParsedRailwayStatus,
): RailwayPullReceipt {
  return {
    eventType: RAILWAY_PULL_EVENT_TYPE,
    payload: {
      target: {
        projectId: target.projectId,
        serviceId: target.serviceId,
        environmentId: target.environmentId,
      },
      deployment: {
        id: parsed.deploymentId,
        status: parsed.status,
        createdAt: parsed.providerEventTime?.toISOString() ?? null,
        url: parsed.url,
      },
    },
  };
}

/** One pulled target's verdict for the gather step. */
export interface RailwayPullResult {
  target: RailwayPullTarget;
  targetId: string;
  names: RailwayTargetNames | null;
  /**
   * The stored row's state after folding this read — the verdict the briefing
   * prints. Null when the read failed, timed out, or puzzled, or when the row
   * holds a token outside the three-state vocabulary.
   */
  status: ParsedRailwayStatus["status"] | null;
  /**
   * `applied` — the read folded and the row holds what it proved (a later
   * success advances the target row, a later failure reopens it, per the
   * store's recency rule).
   * `duplicate` — this exact deployment already folded (its attempt key
   * exists), so redeliveries, retries, and identical consecutive reads mint
   * nothing. `stale` — the read was verified but
   * older than the stored row, so the store kept the row; `status` and
   * `occurredAt` carry the row, not the read. `unverified` — the read proved
   * nothing; the loop stays live.
   */
  outcome: "applied" | "duplicate" | "stale" | "unverified";
  deploymentId: string | null;
  url: string | null;
  occurredAt: string | null;
}

const MAX_RAILWAY_PULL_TARGETS = 5;

/**
 * Pull current state for each target and fold it. The dedup is by deployment
 * identity, not by outcome: when this exact deployment already folded (its
 * `deployment_id` attempt key exists), nothing is minted — so redeliveries,
 * retries, and identical consecutive reads cannot move the row. A second,
 * different deployment with the SAME status still folds, so the row advances
 * to the new deploymentId, url, and provider instant instead of keeping the
 * old ones. When the outcome differs, the store's own recency rule
 * decides the write (a stale read loses to the row), and the verdict is
 * re-read off the row — so the briefing prints what the projection holds,
 * never what a losing read claimed.
 */
export async function pullRailwayTargets(
  userId: string,
  targets: readonly RailwayPullTarget[],
): Promise<RailwayPullResult[]> {
  const read = await prepareRailwayRead(userId).catch(() => null);

  const names = read
    ? await resolveRailwayTargetNames(read).catch(() => new Map<string, RailwayTargetNames>())
    : new Map<string, RailwayTargetNames>();

  const results: RailwayPullResult[] = [];

  for (const target of targets.slice(0, MAX_RAILWAY_PULL_TARGETS)) {
    const targetId = canonicalizeRailwayTargetId(target);

    if (!targetId) {
      results.push({
        target,
        targetId: "",
        names: null,
        status: null,
        outcome: "unverified",
        deploymentId: null,
        url: null,
        occurredAt: null,
      });
      continue;
    }

    const parsed = read
      ? await readRailwayDeploymentStatusFromSession(read, target).catch(() => null)
      : null;

    if (!parsed) {
      results.push({
        target,
        targetId,
        names: names.get(targetId) ?? null,
        status: null,
        outcome: "unverified",
        deploymentId: null,
        url: null,
        occurredAt: null,
      });
      continue;
    }

    const result: RailwayPullResult = {
      target,
      targetId,
      names: names.get(targetId) ?? null,
      status: parsed.status,
      outcome: "applied",
      deploymentId: parsed.deploymentId,
      url: parsed.url,
      occurredAt: parsed.providerEventTime?.toISOString() ?? null,
    };

    // Duplicate iff this exact deployment folded before — the reducer writes
    // one `deployment_id` attempt key per folded deployment beside the target
    // row, so the key is the folded set. A same-status check here would skip
    // a second, different failed deployment and leave the row pointing at the
    // old deploymentId, url, and provider instant.
    const folded = await objectStateStore.resolveByKey(
      userId,
      "railway",
      "deployment_id",
      parsed.deploymentId,
    );

    if (folded) {
      result.outcome = "duplicate";
      results.push(result);
      continue;
    }

    // A same-status row for an OLDER deployment is not a duplicate: the mint
    // below re-asserts the status with the new deployment's identity, and the
    // store's recency rule advances the row (or keeps it, re-read below).
    const receipt = mintRailwayPullReceipt(target, parsed);

    await objectStateStore.applyEvent({
      userId,
      provider: "railway",
      eventType: receipt.eventType,
      action: null,
      payload: receipt.payload,
      // A pull mints no receipt row, so this instant comes from a JavaScript
      // clock and is honestly millisecond-true with zero microseconds.
      deliveredAt: deliveryInstantFromDate(new Date()),
    });

    // The store's recency guard may refuse a stale read — a SUCCESS for an
    // older deployment loses to the failed row — so the verdict is re-read
    // off the row, never the parsed read. Otherwise the briefing prints a
    // success the projection refused to write.
    const stored = await objectStateStore.getByIdentity(userId, {
      provider: "railway",
      kind: "deployment_target",
      externalId: targetId,
    });

    const storedStatus =
      stored?.nativeState === "success" ||
      stored?.nativeState === "failure" ||
      stored?.nativeState === "pending"
        ? stored.nativeState
        : null;

    if (!stored || storedStatus === parsed.status) {
      results.push(result);
      continue;
    }

    results.push({
      ...result,
      status: storedStatus,
      outcome: "stale",
      deploymentId: null,
      url: stored.url,
      occurredAt: stored.stateDeliveredAt?.toISOString() ?? result.occurredAt,
    });
  }

  return results;
}

/**
 * Best-effort display names for known targets, keyed by canonical target id.
 * MCP project and service reads supply display names. Any failure gives an
 * empty map, and titles fall back to ids. Names never define identity.
 */
async function resolveRailwayTargetNames(
  read: RailwayReadSession,
): Promise<Map<string, RailwayTargetNames>> {
  const byId = new Map<string, RailwayTargetNames>();

  const projects = await readRailwayTool(
    read.connectionId,
    read.prepared,
    "list-projects",
    {},
    railwayProjectsSchema,
  );

  if (!projects) return byId;

  for (const project of projects.projects) {
    const services = await readRailwayTool(
      read.connectionId,
      read.prepared,
      "list-services",
      { projectId: project.id },
      railwayServicesSchema,
    );

    if (!services || services.project.id !== project.id) continue;

    for (const service of services.services) {
      for (const environment of services.environments) {
        const targetId = canonicalizeRailwayTargetId({
          projectId: project.id,
          serviceId: service.id,
          environmentId: environment.id,
        });

        if (targetId && !byId.has(targetId)) {
          byId.set(targetId, {
            project: project.name,
            service: service.name,
            environment: environment.name,
          });
        }
      }
    }
  }

  return byId;
}

/**
 * Discover pull targets from Railway MCP's project and service lists — the
 * bootstrap, before any target row exists. Bounded: the first
 * `MAX_RAILWAY_PULL_TARGETS` in provider order. A transport fault discovers
 * nothing, so the loop stays live.
 */
export async function discoverRailwayTargets(userId: string): Promise<RailwayPullTarget[]> {
  try {
    const read = await prepareRailwayRead(userId);

    if (!read) return [];

    const projects = await readRailwayTool(
      read.connectionId,
      read.prepared,
      "list-projects",
      {},
      railwayProjectsSchema,
    );

    if (!projects) return [];

    const targets: RailwayPullTarget[] = [];

    for (const project of projects.projects) {
      const services = await readRailwayTool(
        read.connectionId,
        read.prepared,
        "list-services",
        { projectId: project.id },
        railwayServicesSchema,
      );

      if (!services || services.project.id !== project.id) continue;

      for (const service of services.services) {
        for (const environment of services.environments) {
          if (targets.length >= MAX_RAILWAY_PULL_TARGETS) return targets;

          targets.push({
            projectId: project.id,
            serviceId: service.id,
            environmentId: environment.id,
          });
        }
      }
    }

    return targets;
  } catch {
    return [];
  }
}

/**
 * The Railway MCP connection's readiness as pull provenance: connected means
 * the stored row is `ready`, and issuer-pinned means its authorization server
 * is byte-for-byte `RAILWAY_MCP_STORED_ISSUER` — never URL-round-tripped. Both
 * conditions gate the deployment read.
 */
export async function readRailwayMcpReadiness(
  userId: string,
): Promise<{ connected: boolean; issuerPinned: boolean }> {
  const connections = await listOwnedConnections(userId);

  const railway = connections.find(
    (connection) => builtInProviderForEndpoint(connection.server.endpointUrl) === "railway",
  );

  if (!railway) return { connected: false, issuerPinned: false };

  return {
    connected: railway.status === "ready",
    issuerPinned: railway.authServerIdentity === RAILWAY_MCP_STORED_ISSUER,
  };
}

/**
 * A surfaced digest item signaling a Railway deployment failure — the email
 * half of the gather trigger. Deliberately narrow (a railway sender domain
 * AND a failure word in subject or snippet) and trigger-only: it causes a
 * verified read, never an assertion. The structured follow-up is a Railway
 * deployment-URL grammar plus a text adapter; until then this heuristic is
 * the only way a brand-new failure (no target row yet, discovery already
 * bootstrapped) starts a pull.
 */
export function digestSignalsRailwayFailure(
  items: readonly { subject?: string | null; from?: string | null; snippet?: string | null }[],
): boolean {
  return items.some((item) => {
    const from = item.from ?? "";

    if (!/railway\.(app|com)/i.test(from)) return false;

    return /fail|error|crash|timed out|unable to deploy/i.test(
      `${item.subject ?? ""} ${item.snippet ?? ""}`,
    );
  });
}

/** Phrase one pull result as a briefing activity item — red-then-green lives here. */
export function railwayPullResultToActivityItem(
  result: RailwayPullResult,
): IntegrationActivityItem {
  const where = result.names
    ? `${result.names.service} (${result.names.environment})`
    : result.targetId || "unknown target";

  const word =
    result.status === "success"
      ? "succeeded"
      : result.status === "failure"
        ? "failed"
        : result.status === "pending"
          ? "building"
          : "unverified";

  return {
    id: `railway-pull:${result.targetId || "unknown"}:${result.deploymentId ?? "unverified"}`,
    provider: "railway",
    source: "mcp",
    activityCategory: "deploy",
    providerKind: "railway.deployment_status",
    title: `Railway deployment ${word}: ${where}`,
    status:
      result.status === "success"
        ? "succeeded"
        : result.status === "failure"
          ? "failed"
          : result.status === "pending"
            ? "open"
            : "needs_attention",
    severity: result.status === "failure" ? "warning" : "info",
    occurredAt: result.occurredAt ?? new Date().toISOString(),
    ...(result.url && result.url.startsWith("https://") ? { url: result.url } : {}),
  };
}

/**
 * The gather-time hook: a surfaced deployment failure triggers a live status
 * read, and the read's verdicts return as deployment activity lines. Runs
 * after the email digest resolves (it needs the surfaced items) and before
 * the gather result assembles.
 *
 * Trigger, in order: failed target rows (the loop is live — re-verify),
 * active target rows (a pull is in flight — follow it to its outcome),
 * zero target rows (bootstrap from the provider's own project list), or a
 * Railway failure mail over rows that all read resolved (the failure is new
 * — re-verify). All-resolved rows with no mail: quiet, no pull.
 *
 * Never throws: any fault — no credential, no transport, no rows, a DB
 * blip — resolves to no lines, and every loop stays live. A failed read is
 * an absence, never evidence (ADR-0048-D).
 */
export async function gatherRailwayVerifiedPull(args: {
  userId: string;
  digestItems: readonly {
    subject?: string | null;
    from?: string | null;
    snippet?: string | null;
  }[];
}): Promise<IntegrationActivityItem[]> {
  try {
    const failed = await objectStateStore.list(args.userId, "railway", {
      kind: "deployment_target",
      stateCategory: "failed",
      limit: MAX_RAILWAY_PULL_TARGETS,
    });

    const active =
      failed.length < MAX_RAILWAY_PULL_TARGETS
        ? await objectStateStore.list(args.userId, "railway", {
            kind: "deployment_target",
            stateCategory: "active",
            limit: MAX_RAILWAY_PULL_TARGETS - failed.length,
          })
        : [];

    let targets = rowsToPullTargets([...failed, ...active]);

    if (targets.length === 0) {
      const known = await objectStateStore.list(args.userId, "railway", {
        kind: "deployment_target",
        limit: MAX_RAILWAY_PULL_TARGETS,
      });

      if (known.length === 0) {
        targets = await discoverRailwayTargets(args.userId);
      } else if (digestSignalsRailwayFailure(args.digestItems)) {
        targets = rowsToPullTargets(known);
      } else {
        return [];
      }
    }

    if (targets.length === 0) return [];

    const results = await pullRailwayTargets(args.userId, targets);

    return results.map(railwayPullResultToActivityItem);
  } catch {
    return [];
  }
}

/**
 * Read pull targets back off stored rows. The external id IS the canonical
 * `projectId/serviceId/environmentId` form (the reducer only writes what
 * `canonicalizeRailwayTargetId` returned, which refuses slashes), so a
 * three-part split recovers the query the pull needs. Anything else is a row
 * this build did not write — dropped, never pulled.
 */
function rowsToPullTargets(rows: readonly ObjectState[]): RailwayPullTarget[] {
  const targets: RailwayPullTarget[] = [];

  for (const row of rows) {
    const [projectId, serviceId, environmentId] = row.externalId.split("/");

    if (projectId && serviceId && environmentId) {
      targets.push({ projectId, serviceId, environmentId });
    }
  }

  return targets;
}
