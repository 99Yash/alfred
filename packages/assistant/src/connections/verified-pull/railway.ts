import {
  canonicalizeRailwayTargetId,
  type DeploymentStatus,
  getPath,
  isNotificationSender,
} from "@alfred/contracts";
import {
  builtInProviderForEndpoint,
  getMcpConnectionManager,
  listOwnedConnections,
  RAILWAY_MCP_STORED_ISSUER,
  type McpPreparedToolCall,
} from "../mcp";
import { VERIFIED_PULL_EVENT_TYPE, type RailwayPullEvent } from "../object-state";
import { z } from "zod";
import {
  MAX_VERIFIED_PULL_TARGETS,
  type VerifiedPullProvider,
  type VerifiedPullRead,
  type VerifiedPullReading,
  verifiedPullVerdict,
} from "./driver";

/**
 * Railway's half of the verified pull (#1094). Railway mails failures, not successes.
 * The folded rows re-arm the next gather's trigger and add red/green verdict lines.
 * Reads use the ready, issuer-pinned MCP connection and parse only structured output.
 * The fold input owns the target shape, so the pull and the reducer cannot drift.
 */
export type RailwayPullTarget = RailwayPullEvent["payload"]["target"];

/** Display names only, never identity. */
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
  // Optional: only a positive mismatch drops the item.
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

/** Any failure, and a read that finds the target `absent`, returns `null`, never a guessed state. */
export async function readRailwayDeploymentStatus(
  userId: string,
  target: RailwayPullTarget,
): Promise<VerifiedPullReading | null> {
  try {
    const read = await prepareRailwayRead(userId);
    const reading = read ? await readRailwayDeploymentStatusFromSession(read, target) : null;

    return reading === "absent" ? null : reading;
  } catch {
    return null;
  }
}

/** Reverses `canonicalizeRailwayTargetId`. Segments cannot hold `/`, so a three-part split is exact. */
export function railwayTargetFromId(targetId: string): RailwayPullTarget | null {
  const [projectId, serviceId, environmentId, extra] = targetId.split("/");

  return projectId && serviceId && environmentId && extra === undefined
    ? { projectId, serviceId, environmentId }
    : null;
}

/** Never 1: then the server's order alone would pick the verdict. */
const RAILWAY_DEPLOYMENT_READ_LIMIT = 10;

/**
 * `absent` when the list was read and held no deployment of the target. A list of deployments with
 * no known status, such as a sleeping service's `SLEEPING` and `REMOVED`, is `null`: the target is
 * there, but this build cannot read it.
 */
async function readRailwayDeploymentStatusFromSession(
  read: RailwayReadSession,
  target: RailwayPullTarget,
): Promise<VerifiedPullRead> {
  // `prepared.call` checks these against the live schema and throws on drift.
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

  // Do not trust server order. Take the newest deployment with a known status;
  // no instant sorts last, and ties keep server order.
  const ofTarget = parsed.deployments.filter(
    (deployment) =>
      (deployment.serviceId == null || deployment.serviceId === target.serviceId) &&
      (deployment.environmentId == null || deployment.environmentId === target.environmentId),
  );

  if (ofTarget.length === 0) return "absent";

  const candidates = ofTarget
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

/** Railway deployment statuses this build knows. The schema keeps the wire value a `string`. */
const RAILWAY_DEPLOYMENT_STATUSES = [
  "SUCCESS",
  "FAILED",
  "CRASHED",
  "BUILDING",
  "DEPLOYING",
  "QUEUED",
  "PENDING",
  "INITIALIZING",
  "WAITING",
  "SLEEPING",
  "REMOVED",
] as const;

const railwayDeploymentStatusSchema = z.enum(RAILWAY_DEPLOYMENT_STATUSES);

/** `satisfies` forces a verdict for every known status. `null`: the deployment proves no health. */
const VERDICT_BY_RAILWAY_STATUS = {
  SUCCESS: "success",
  FAILED: "failure",
  CRASHED: "failure",
  BUILDING: "pending",
  DEPLOYING: "pending",
  QUEUED: "pending",
  PENDING: "pending",
  INITIALIZING: "pending",
  WAITING: "pending",
  SLEEPING: null,
  REMOVED: null,
} satisfies Record<(typeof RAILWAY_DEPLOYMENT_STATUSES)[number], DeploymentStatus | null>;

/**
 * `null` for a status that proves no health and for an unknown one. The read treats both alike: the
 * target is there, so a list with no readable status is a fault, never `absent`.
 */
function collapseRailwayStatus(status: string): DeploymentStatus | null {
  const known = railwayDeploymentStatusSchema.safeParse(status);

  return known.success ? VERDICT_BY_RAILWAY_STATUS[known.data] : null;
}

function parseProviderInstant(value: string | null): Date | null {
  if (!value) return null;

  const time = new Date(value);

  return Number.isNaN(time.getTime()) ? null : time;
}

/** The only minter of the pull event `reduceRailwayEvent` folds. Takes a parsed reading, never text. */
function mintRailwayPullReceipt(
  target: RailwayPullTarget,
  reading: VerifiedPullReading,
): RailwayPullEvent {
  return { provider: "railway", eventType: VERIFIED_PULL_EVENT_TYPE, payload: { target, reading } };
}

/** Display names by target id. A failure gives an empty map, and titles show ids. */
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

/** Bootstrap targets before any row exists: the first `limit`. A fault finds none. */
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

/** Both gate the read. The issuer must equal `RAILWAY_MCP_STORED_ISSUER` byte for byte. */
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
  RailwayPullEvent,
  RailwayPullTarget,
  RailwayReadSession,
  RailwayTargetNames
> = {
  provider: "railway",
  targetKind: "deployment_target",
  attemptKeyKind: "deployment_id",

  /** A Railway sender plus a failure word. Only triggers a read. */
  digestSignalsFailure(items) {
    return items.some((item) => {
      if (!isNotificationSender("railway", item.from)) return false;

      return /fail|error|crash|timed out|unable to deploy/i.test(
        `${item.subject ?? ""} ${item.snippet ?? ""}`,
      );
    });
  },

  targetFromRow: (row) => railwayTargetFromId(row.externalId),

  canonicalTargetId: canonicalizeRailwayTargetId,
  discoverTargets: discoverRailwayTargets,
  openSession: prepareRailwayRead,
  resolveNames: resolveRailwayTargetNames,
  readStatus: readRailwayDeploymentStatusFromSession,
  mintReceipt: mintRailwayPullReceipt,

  toActivityItem(result) {
    const where = result.names
      ? `${result.names.service} (${result.names.environment})`
      : result.targetId || "unknown target";

    const { word, ...verdict } = verifiedPullVerdict(result);

    return {
      id: `railway-pull:${result.targetId || "unknown"}:${result.attemptId ?? "unverified"}`,
      provider: "railway",
      source: "mcp",
      activityCategory: "deploy",
      providerKind: "railway.deployment_status",
      title: `Railway deployment ${word}: ${where}`,
      ...verdict,
    };
  },
};
