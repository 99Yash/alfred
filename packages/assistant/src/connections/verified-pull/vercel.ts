import {
  canonicalizeVercelTargetId,
  emailDomain,
  getPath,
  getStringPath,
  INTEGRATIONS,
  parseEmailAddress,
  parseGitBranchRef,
  safeJsonParse,
} from "@alfred/contracts";
import {
  builtInProviderForEndpoint,
  getMcpConnectionManager,
  listOwnedConnections,
  VERCEL_MCP_STORED_ISSUER,
  type McpPreparedToolCall,
} from "../mcp";
import { VERCEL_PULL_EVENT_TYPE } from "../object-state/vercel-reducer";
import { z } from "zod";
import {
  MAX_VERIFIED_PULL_TARGETS,
  type VerifiedPullProvider,
  type VerifiedPullReading,
  type VerifiedPullReceipt,
  type VerifiedPullStatus,
} from "./driver";

/**
 * Vercel's half of the verified pull (#1193) — the second
 * {@link VerifiedPullProvider}, and the pull half of Vercel's succession shape.
 * The push half is the relayed `repository_dispatch` (`reduceVercelEvent`).
 * Both halves fold into the same `owner/repo#branch#environment` target row,
 * so a pull success after a push failure (or the reverse) is one succession.
 *
 * The read goes over the user's Vercel MCP connection, never the curated
 * Vercel grant (#1008 retires that grant). It uses only `list_teams`,
 * `list_projects`, and `list_deployments`, and it parses the tool output from
 * `unknown`: the structured content when the server sends it, else the one
 * JSON text block. Missing tools, invalid or truncated output, a remote error,
 * and a deployment that does not name its repo, branch, and environment prove
 * nothing and leave the loop live.
 *
 * The output shapes below follow Vercel's REST deployment and project objects.
 * No live Vercel MCP connection existed when this was written (2026-09-23), so
 * they are NOT measured against the MCP wire. A shape the server does not
 * send reads as unverified, never as a guessed state.
 */

/** A Vercel deployment target: the identity the dispatch and the pull share. */
export interface VercelPullTarget {
  repoFullName: string;
  branch: string;
  environment: string;
}

/** A project the read may scan, and the repo its Git link names, when known. */
interface VercelProjectRef {
  teamId: string;
  projectId: string;
  name: string;
  linkedRepo: string | null;
}

/** One deployment, parsed and attributed to the target it belongs to. */
interface VercelDeploymentReading {
  project: VercelProjectRef;
  targetId: string;
  target: VercelPullTarget;
  reading: VerifiedPullReading;
}

interface VercelReadSession {
  connectionId: string;
  prepared: McpPreparedToolCall;
  projects: readonly VercelProjectRef[];
  /** One `list_deployments` per project per gather, shared by every target. */
  deployments: Map<string, Promise<VercelDeploymentReading[] | null>>;
}

/**
 * How many projects one read session scans for deployments. Every target read
 * in a session shares the per-project cache, so this caps the
 * `list_deployments` calls of one session. A gather opens at most two sessions
 * (bootstrap discovery, then the reads).
 */
const VERCEL_PROJECT_SCAN_LIMIT = 10;

/** A list the server may send bare or under its REST key. */
function listSchema<Item extends z.ZodType>(key: string, item: Item) {
  return z
    .union([z.array(item), z.object({ [key]: z.array(item) })])
    .transform((value): z.infer<Item>[] => (Array.isArray(value) ? value : value[key]) ?? []);
}

const vercelTeamsSchema = listSchema("teams", z.object({ id: z.string().min(1) }));

const vercelProjectsSchema = listSchema(
  "projects",
  z.object({
    id: z.string().min(1),
    name: z.string(),
    link: z.object({ org: z.string().nullish(), repo: z.string().nullish() }).nullish().catch(null),
  }),
);

const vercelDeploymentsSchema = listSchema(
  "deployments",
  z.object({
    uid: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    state: z.string().nullish(),
    readyState: z.string().nullish(),
    // `null` is a preview deployment. ABSENT is unknown, and an unknown
    // environment attributes the deployment to no target.
    target: z.string().nullable().optional(),
    created: z.union([z.number(), z.string()]).nullish(),
    createdAt: z.union([z.number(), z.string()]).nullish(),
    url: z.string().nullish(),
    meta: z
      .object({
        githubCommitRef: z.string().nullish(),
        githubOrg: z.string().nullish(),
        githubRepo: z.string().nullish(),
        githubCommitOrg: z.string().nullish(),
        githubCommitRepo: z.string().nullish(),
      })
      .nullish()
      .catch(null),
  }),
);

/**
 * Parse a tool result against `schema`: the structured content when present,
 * else the one text block parsed as JSON. Any other result shape is null.
 */
function parseToolPayload<Schema extends z.ZodType>(
  result: unknown,
  schema: Schema,
): z.infer<Schema> | null {
  const structured = getPath(result, "structuredContent");
  const content = getPath(result, "content");
  const [block] = Array.isArray(content) && content.length === 1 ? content : [];
  const text = getStringPath(block, "type") === "text" ? getStringPath(block, "text") : undefined;

  const parsed = schema.safeParse(
    structured !== undefined ? structured : text !== undefined ? safeJsonParse(text) : undefined,
  );

  return parsed.success ? parsed.data : null;
}

async function readVercelTool<Schema extends z.ZodType>(
  connectionId: string,
  prepared: McpPreparedToolCall,
  remoteName: "list_teams" | "list_projects" | "list_deployments",
  args: Record<string, string>,
  schema: Schema,
): Promise<z.infer<Schema> | null> {
  const envelope = await prepared.call(
    { kind: "mcp", connectionId, remoteName, catalogRevision: prepared.catalog.revision },
    args,
  );

  // A truncated body may have dropped the newest deployment, so it proves
  // nothing about current state.
  if (envelope.outcome !== "completed" || envelope.truncation) return null;

  return parseToolPayload(envelope.result, schema);
}

/**
 * Open a ready, issuer-pinned Vercel MCP connection and list the projects the
 * read may scan. A connection that is absent, not ready, or pinned to another
 * issuer opens nothing.
 */
async function openVercelRead(userId: string): Promise<VercelReadSession | null> {
  const connections = await listOwnedConnections(userId);

  const connection = connections.find(
    (item) => builtInProviderForEndpoint(item.server.endpointUrl) === "vercel",
  );

  if (
    !connection ||
    connection.status !== "ready" ||
    connection.authServerIdentity !== VERCEL_MCP_STORED_ISSUER
  ) {
    return null;
  }

  const prepared = await getMcpConnectionManager().prepareToolCall(connection.id);

  const teams = await readVercelTool(connection.id, prepared, "list_teams", {}, vercelTeamsSchema);

  if (!teams) return null;

  const projects: VercelProjectRef[] = [];

  for (const team of teams) {
    if (projects.length >= VERCEL_PROJECT_SCAN_LIMIT) break;

    const listed = await readVercelTool(
      connection.id,
      prepared,
      "list_projects",
      { teamId: team.id },
      vercelProjectsSchema,
    );

    for (const project of listed ?? []) {
      if (projects.length >= VERCEL_PROJECT_SCAN_LIMIT) break;

      const org = project.link?.org;
      const repo = project.link?.repo;

      projects.push({
        teamId: team.id,
        projectId: project.id,
        name: project.name,
        linkedRepo: org && repo ? `${org}/${repo}` : null,
      });
    }
  }

  return { connectionId: connection.id, prepared, projects, deployments: new Map() };
}

/**
 * Collapse a Vercel deployment state into the registry's outcome vocabulary.
 * Byte-exact on the provider enum: `CANCELED`, `DELETED`, a future state, or a
 * casing drift reads as unknown, and absence never closes.
 */
function collapseVercelState(state: string | null | undefined): VerifiedPullStatus | null {
  switch (state) {
    case "READY":
      return "success";
    case "ERROR":
      return "failure";
    case "BUILDING":
    case "INITIALIZING":
    case "QUEUED":
      return "pending";
    default:
      return null;
  }
}

function parseProviderInstant(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;

  const time = new Date(value);

  return Number.isNaN(time.getTime()) ? null : time;
}

/**
 * Every readable deployment of one project, newest provider instant first,
 * each attributed to the target its own Git metadata names. Read once per
 * project per gather. `null` means the read proved nothing.
 */
function readProjectDeployments(
  session: VercelReadSession,
  project: VercelProjectRef,
): Promise<VercelDeploymentReading[] | null> {
  const cached = session.deployments.get(project.projectId);

  if (cached) return cached;

  const pending = readVercelTool(
    session.connectionId,
    session.prepared,
    "list_deployments",
    { projectId: project.projectId, teamId: project.teamId },
    vercelDeploymentsSchema,
  ).then((deployments) => {
    if (!deployments) return null;

    const readings: VercelDeploymentReading[] = [];

    for (const deployment of deployments) {
      const attemptId = deployment.uid ?? deployment.id;
      const status = collapseVercelState(deployment.state ?? deployment.readyState);
      const org = deployment.meta?.githubCommitOrg ?? deployment.meta?.githubOrg;
      const repo = deployment.meta?.githubCommitRepo ?? deployment.meta?.githubRepo;
      const ref = deployment.meta?.githubCommitRef;
      const branch = ref ? parseGitBranchRef(ref) : null;

      // The target is the deployment's OWN claim, never inferred: a deployment
      // that does not name its repo, branch, and environment belongs to no
      // target, so it cannot close one.
      if (!attemptId || !status || !org || !repo || !branch || deployment.target === undefined) {
        continue;
      }

      const target: VercelPullTarget = {
        repoFullName: `${org}/${repo}`,
        branch,
        environment: deployment.target ?? "preview",
      };

      const targetId = canonicalizeVercelTargetId(target);

      if (!targetId) continue;

      const url = deployment.url ?? null;

      readings.push({
        project,
        targetId,
        target,
        reading: {
          status,
          attemptId,
          providerEventTime: parseProviderInstant(deployment.createdAt ?? deployment.created),
          url: url && !url.includes("://") ? `https://${url}` : url,
        },
      });
    }

    // Server order is a claim, not a contract. The newest provider instant
    // comes first; an absent instant sorts last, and the stable sort keeps
    // server order among ties.
    return readings.sort(
      (a, b) =>
        (b.reading.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY) -
        (a.reading.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY),
    );
  });

  session.deployments.set(project.projectId, pending);

  return pending;
}

/**
 * The projects that may hold this target's deployments: a project whose Git
 * link names the target's repo, or whose link is unknown. A project linked to
 * another repo cannot hold them.
 */
function candidateProjects(
  session: VercelReadSession,
  target: VercelPullTarget,
): VercelProjectRef[] {
  const repo = target.repoFullName.toLowerCase();

  return session.projects.filter(
    (project) => project.linkedRepo === null || project.linkedRepo.toLowerCase() === repo,
  );
}

/**
 * Read current deployment state for one target: the newest readable
 * deployment, across the candidate projects, whose own metadata names this
 * target. A target with no such deployment reads as null, never a guess.
 */
async function readVercelDeploymentStatusFromSession(
  session: VercelReadSession,
  target: VercelPullTarget,
): Promise<VerifiedPullReading | null> {
  const targetId = canonicalizeVercelTargetId(target);

  if (!targetId) return null;

  let latest: VerifiedPullReading | null = null;

  for (const project of candidateProjects(session, target)) {
    const readings = await readProjectDeployments(session, project);
    const match = readings?.find((item) => item.targetId === targetId);

    if (!match) continue;

    const matchTime = match.reading.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY;
    const latestTime = latest?.providerEventTime?.getTime() ?? Number.NEGATIVE_INFINITY;

    if (!latest || matchTime > latestTime) latest = match.reading;
  }

  return latest;
}

/**
 * Read current deployment state for one target over the user's Vercel MCP
 * connection. Unknown output or a transport fault is never a guessed state.
 */
export async function readVercelDeploymentStatus(
  userId: string,
  target: VercelPullTarget,
): Promise<VerifiedPullReading | null> {
  try {
    const session = await openVercelRead(userId);

    return session ? await readVercelDeploymentStatusFromSession(session, target) : null;
  } catch {
    return null;
  }
}

/**
 * Discover pull targets from the user's recent Vercel deployments — the
 * bootstrap, before any target row exists. Bounded: the first `limit` distinct
 * targets, newest deployment first within each project, projects in provider
 * order. A transport fault discovers nothing, so the loop stays live.
 */
export async function discoverVercelTargets(
  userId: string,
  limit: number = MAX_VERIFIED_PULL_TARGETS,
): Promise<VercelPullTarget[]> {
  try {
    const session = await openVercelRead(userId);

    if (!session) return [];

    const targets = new Map<string, VercelPullTarget>();

    for (const project of session.projects) {
      for (const item of (await readProjectDeployments(session, project)) ?? []) {
        if (targets.size >= limit) return [...targets.values()];

        if (!targets.has(item.targetId)) targets.set(item.targetId, item.target);
      }
    }

    return [...targets.values()];
  } catch {
    return [];
  }
}

/**
 * Mint the pull receipt body for a parsed status — the ONLY constructor of the
 * pull shape `reduceVercelEvent` folds. It takes a {@link VerifiedPullReading},
 * never text, so an email string or adapter output cannot construct it.
 */
export function mintVercelPullReceipt(
  target: VercelPullTarget,
  parsed: VerifiedPullReading,
): VerifiedPullReceipt {
  return {
    eventType: VERCEL_PULL_EVENT_TYPE,
    payload: {
      target: {
        repoFullName: target.repoFullName,
        branch: target.branch,
        environment: target.environment,
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

export const vercelVerifiedPullProvider: VerifiedPullProvider<
  VercelPullTarget,
  VercelReadSession,
  never
> = {
  provider: "vercel",
  targetKind: "deployment_target",
  attemptKeyKind: "deployment_id",

  /**
   * A surfaced digest item signaling a Vercel deployment failure. Deliberately
   * narrow: the sender's domain IS `INTEGRATIONS.vercel.domain` (so
   * `ship@info.vercel.com` marketing does not qualify) AND a failure word sits
   * in the subject or snippet. Trigger-only: it causes a read, never an
   * assertion.
   */
  digestSignalsFailure(items) {
    return items.some((item) => {
      if (emailDomain(parseEmailAddress(item.from)) !== INTEGRATIONS.vercel.domain) return false;

      return /fail|error|unable to deploy/i.test(`${item.subject ?? ""} ${item.snippet ?? ""}`);
    });
  },

  /**
   * The external id is the canonical `owner/repo#branch#environment` form,
   * and `canonicalizeVercelTargetId` refuses a `#` in any segment, so a
   * three-part split recovers the target. The id folds the repo's case, so
   * the row's `repo` column supplies the display spelling when it agrees.
   * Anything else is a row this build did not write — dropped, never pulled.
   */
  targetFromRow(row) {
    const [repoFullName, branch, environment, ...rest] = row.externalId.split("#");

    if (!repoFullName || !branch || !environment || rest.length > 0) return null;

    const repo = row.repo?.toLowerCase() === repoFullName ? row.repo : repoFullName;

    return { repoFullName: repo, branch, environment };
  },

  canonicalTargetId: canonicalizeVercelTargetId,
  discoverTargets: discoverVercelTargets,
  openSession: openVercelRead,
  // The verdict line names the target by repo, branch, and environment, which
  // the target itself carries, so there is nothing further to resolve.
  resolveNames: async () => new Map<string, never>(),
  readStatus: readVercelDeploymentStatusFromSession,
  mintReceipt: mintVercelPullReceipt,

  toActivityItem(result) {
    const where = `${result.target.repoFullName} ${result.target.branch} (${result.target.environment})`;

    const word =
      result.status === "success"
        ? "succeeded"
        : result.status === "failure"
          ? "failed"
          : result.status === "pending"
            ? "building"
            : "unverified";

    return {
      id: `vercel-pull:${result.targetId || "unknown"}:${result.attemptId ?? "unverified"}`,
      provider: "vercel",
      source: "mcp",
      activityCategory: "deploy",
      providerKind: "vercel.deployment_status",
      title: `Vercel deployment ${word}: ${where}`,
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
