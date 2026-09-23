import { canonicalizeRailwayTargetId, getPath } from "@alfred/contracts";
import {
  builtInProviderForEndpoint,
  getMcpConnectionManager,
  listOwnedConnections,
  RAILWAY_MCP_STORED_ISSUER,
  type McpPreparedToolCall,
} from "../mcp";
import { RAILWAY_PULL_EVENT_TYPE } from "../object-state/railway-reducer";
import { z } from "zod";
import {
  MAX_VERIFIED_PULL_TARGETS,
  type VerifiedPullProvider,
  type VerifiedPullReading,
  type VerifiedPullReceipt,
  type VerifiedPullStatus,
} from "./driver";

/**
 * Railway's half of the verified pull (#1094) — the first
 * {@link VerifiedPullProvider}.
 *
 * Railway mails a build failure and stays silent on success. What the fold
 * buys is trigger and verdict state, not email-loop closure: the folded rows
 * re-arm the next gather's trigger (failed/active rows re-verify) and dedup
 * identical reads, and the pull appends verified red/green verdict lines
 * beside the failure mail. It does NOT drop the email loop through
 * `reconcileEvidence` — the Railway adapter proposes no keys until the
 * deployment-URL grammar lands, so no Railway row reaches the closure reader
 * today.
 *
 * The Railway MCP catalog publishes `list-services` and `list-deployments`.
 * The read uses the user's ready, issuer-pinned connection and parses only
 * structured tool output. Missing tools, invalid output, and remote errors
 * prove nothing and leave the loop live.
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
): Promise<VerifiedPullReading | null> {
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
): Promise<VerifiedPullReading | null> {
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
    attemptId: latest.deployment.id,
    providerEventTime: parseProviderInstant(latest.deployment.createdAt),
    url: latest.deployment.url,
  };
}

/**
 * Collapse a Railway deployment status into the registry's outcome
 * vocabulary. Byte-exact on the provider enum: anything unlisted — a future
 * status, a casing drift — reads as unknown, and absence never closes.
 */
function collapseRailwayStatus(status: string): VerifiedPullStatus | null {
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
 * Mint the pull receipt body for a parsed status — the ONLY constructor of
 * the shape `reduceRailwayEvent` folds. Takes a {@link VerifiedPullReading},
 * never text: an email string or adapter output cannot construct it, because
 * no string-taking overload exists (criterion 6).
 */
export function mintRailwayPullReceipt(
  target: RailwayPullTarget,
  parsed: VerifiedPullReading,
): VerifiedPullReceipt {
  return {
    eventType: RAILWAY_PULL_EVENT_TYPE,
    payload: {
      target: {
        projectId: target.projectId,
        serviceId: target.serviceId,
        environmentId: target.environmentId,
      },
      deployment: {
        id: parsed.attemptId,
        status: parsed.status,
        createdAt: parsed.providerEventTime?.toISOString() ?? null,
        url: parsed.url,
      },
    },
  };
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
 * bootstrap, before any target row exists. Bounded: the first `limit` in
 * provider order. A transport fault discovers nothing, so the loop stays live.
 */
export async function discoverRailwayTargets(
  userId: string,
  limit: number = MAX_VERIFIED_PULL_TARGETS,
): Promise<RailwayPullTarget[]> {
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
          if (targets.length >= limit) return targets;

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

export const railwayVerifiedPullProvider: VerifiedPullProvider<
  RailwayPullTarget,
  RailwayReadSession,
  RailwayTargetNames
> = {
  provider: "railway",
  targetKind: "deployment_target",
  attemptKeyKind: "deployment_id",

  /**
   * A surfaced digest item signaling a Railway deployment failure.
   * Deliberately narrow (a railway sender domain AND a failure word in
   * subject or snippet). The structured follow-up is a Railway
   * deployment-URL grammar plus a text adapter; until then this heuristic is
   * the only way a brand-new failure (no target row yet, discovery already
   * bootstrapped) starts a pull.
   */
  digestSignalsFailure(items) {
    return items.some((item) => {
      const from = item.from ?? "";

      if (!/railway\.(app|com)/i.test(from)) return false;

      return /fail|error|crash|timed out|unable to deploy/i.test(
        `${item.subject ?? ""} ${item.snippet ?? ""}`,
      );
    });
  },

  /**
   * The external id IS the canonical `projectId/serviceId/environmentId`
   * form (the reducer only writes what `canonicalizeRailwayTargetId`
   * returned, which refuses slashes), so a three-part split recovers the
   * query the pull needs. Anything else is a row this build did not write —
   * dropped, never pulled.
   */
  targetFromRow(row) {
    const [projectId, serviceId, environmentId] = row.externalId.split("/");

    return projectId && serviceId && environmentId ? { projectId, serviceId, environmentId } : null;
  },

  canonicalTargetId: canonicalizeRailwayTargetId,
  discoverTargets: discoverRailwayTargets,
  openSession: prepareRailwayRead,
  resolveNames: resolveRailwayTargetNames,
  readStatus: readRailwayDeploymentStatusFromSession,
  mintReceipt: mintRailwayPullReceipt,

  /** Red-then-green lives here. */
  toActivityItem(result) {
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
      id: `railway-pull:${result.targetId || "unknown"}:${result.attemptId ?? "unverified"}`,
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
  },
};
