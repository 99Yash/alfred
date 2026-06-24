/**
 * Railway public GraphQL API client (https://docs.railway.com/reference/public-api).
 * Railway has no public OAuth, so access is a personal/account API token the
 * user generates at https://railway.com/account/tokens and pastes into Alfred.
 * The token is a long-lived bearer credential; we never refresh it.
 *
 * The exact query shapes below were validated against the live `/graphql/v2`
 * endpoint; if Railway evolves the schema, adjust the GQL strings here — the
 * tool layer only depends on the typed return shapes.
 */

import { HttpError, summarizeBody } from "@alfred/contracts";

const RAILWAY_API = "https://backboard.railway.app/graphql/v2";

interface GraphqlError {
  message: string;
}

async function railwayGraphql<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(RAILWAY_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // Keep the (redacted, bounded) upstream body for server logs, but don't
    // splice it into the thrown message (it reaches the tool dispatcher /
    // telemetry). The connect route sanitizes separately; this covers the
    // agent-tool call path. The structured HttpError carries the status.
    console.error(`[railway] ${res.status} graphql :: ${summarizeBody(text)}`);
    throw new HttpError({
      provider: "railway",
      status: res.status,
      url: RAILWAY_API,
      method: "POST",
      body: "",
    });
  }
  let json: { data?: T; errors?: GraphqlError[] };
  try {
    json = JSON.parse(text) as { data?: T; errors?: GraphqlError[] };
  } catch {
    console.error(`[railway] non-JSON response :: ${summarizeBody(text)}`);
    throw new Error("[railway] invalid response from upstream");
  }
  if (json.errors && json.errors.length > 0) {
    throw new Error(`[railway] graphql error :: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error("[railway] graphql returned no data");
  return json.data;
}

export interface RailwayAccount {
  id: string;
  name: string | null;
  email: string | null;
}

/**
 * Validate a pasted token and return an identity for it — used by the connect
 * route. Railway has two token shapes that answer different queries:
 *   - account tokens can run `me` (full personal identity);
 *   - workspace-scoped tokens CANNOT run `me` (it requires a personal token)
 *     and are limited to queries about their workspace.
 * So we try `me` first, then fall back to a workspace-token shape that only
 * needs the top-level `projects` connection. Upstream errors from the fallback
 * propagate so the connect route can log why an invalid token was rejected.
 */
export async function railwayValidateToken(token: string): Promise<RailwayAccount> {
  const account = await tryAccountIdentity(token);
  if (account) return account;
  return resolveWorkspaceIdentity(token);
}

async function tryAccountIdentity(token: string): Promise<RailwayAccount | null> {
  try {
    const data = await railwayGraphql<{
      me: { id: string; name: string | null; email: string | null } | null;
    }>(token, `query { me { id name email } }`);
    // workspace tokens come back as `me: null` (or a field-level authz error,
    // caught below) — either way, fall through to the workspace path.
    return data.me ? { id: data.me.id, name: data.me.name, email: data.me.email } : null;
  } catch {
    return null;
  }
}

async function resolveWorkspaceIdentity(token: string): Promise<RailwayAccount> {
  // Prefer a team-named identity, but never reject a valid token over a schema
  // guess: if the enriched query fails (e.g. `team` is unavailable), fall back
  // to the minimal known-good query that workspace tokens can always answer.
  try {
    const data = await railwayGraphql<{
      projects: { edges: Array<{ node: { team: { id: string; name: string } | null } }> };
    }>(token, `query { projects { edges { node { team { id name } } } } }`);
    const team = data.projects.edges.map((e) => e.node.team).find((t) => t != null);
    if (team) return { id: `team:${team.id}`, name: team.name, email: null };
  } catch {
    // fall through to the minimal validity check
  }
  // Throws (HttpError / graphql error) if the token is actually invalid; the
  // connect route logs that reason and surfaces a clean message.
  await railwayGraphql<{ projects: { edges: unknown[] } }>(
    token,
    `query { projects { edges { node { id } } } }`,
  );
  return { id: "workspace", name: "Railway workspace", email: null };
}

export interface RailwayService {
  id: string;
  name: string;
}
export interface RailwayEnvironment {
  id: string;
  name: string;
}
export interface RailwayProject {
  id: string;
  name: string;
  services: RailwayService[];
  environments: RailwayEnvironment[];
}

interface Connection<T> {
  edges: Array<{ node: T }>;
}

interface ProjectNode {
  id: string;
  name: string;
  // GraphQL connections can come back null; guard rather than trust the shape.
  services: Connection<{ id: string; name: string }> | null;
  environments: Connection<{ id: string; name: string }> | null;
}

function mapProjectNode(node: ProjectNode): RailwayProject {
  return {
    id: node.id,
    name: node.name,
    services: node.services?.edges.map((e) => e.node) ?? [],
    environments: node.environments?.edges.map((e) => e.node) ?? [],
  };
}

// GraphQL connections can come back null; the node selection is shared by the
// account (`me.workspaces`) and workspace (top-level `projects`) read paths.
const PROJECT_NODE_FIELDS = `
  id
  name
  services { edges { node { id name } } }
  environments { edges { node { id name } } }`;

export async function railwayListProjects(token: string): Promise<{ projects: RailwayProject[] }> {
  // Account tokens see workspace/team projects under `me.workspaces[].team.projects`
  // (and personal ones only at the top level); workspace-scoped tokens can't run
  // `me` at all but answer the top-level `projects` connection. Try the account
  // path first and fall back to the top level for workspace tokens (or accounts
  // with no workspace projects).
  try {
    const viaMe = await railwayListProjectsViaMe(token);
    if (viaMe.length > 0) return { projects: viaMe };
  } catch {
    // `me` is unauthorized for workspace tokens — use the top-level connection.
  }
  return { projects: await railwayListProjectsTopLevel(token) };
}

async function railwayListProjectsViaMe(token: string): Promise<RailwayProject[]> {
  const data = await railwayGraphql<{
    me: {
      workspaces: Array<{ team: { projects: Connection<ProjectNode> | null } | null } | null>;
    };
  }>(
    token,
    `query {
      me {
        workspaces {
          team {
            projects { edges { node { ${PROJECT_NODE_FIELDS} } } }
          }
        }
      }
    }`,
  );
  const projects: RailwayProject[] = [];
  for (const workspace of data.me.workspaces) {
    for (const edge of workspace?.team?.projects?.edges ?? []) {
      projects.push(mapProjectNode(edge.node));
    }
  }
  return projects;
}

async function railwayListProjectsTopLevel(token: string): Promise<RailwayProject[]> {
  const data = await railwayGraphql<{ projects: Connection<ProjectNode> }>(
    token,
    `query { projects { edges { node { ${PROJECT_NODE_FIELDS} } } } }`,
  );
  return data.projects.edges.map((edge) => mapProjectNode(edge.node));
}

export interface RailwayDeployment {
  id: string;
  status: string;
  createdAt: string | null;
  url: string | null;
  serviceId: string | null;
}

export async function railwayListDeployments(args: {
  token: string;
  projectId: string;
  serviceId?: string;
  environmentId?: string;
  limit: number;
}): Promise<{ deployments: RailwayDeployment[] }> {
  const data = await railwayGraphql<{
    deployments: Connection<{
      id: string;
      status: string;
      createdAt: string | null;
      staticUrl: string | null;
      url: string | null;
      serviceId: string | null;
    }>;
  }>(
    args.token,
    `query deployments($first: Int, $input: DeploymentListInput!) {
      deployments(first: $first, input: $input) {
        edges { node { id status createdAt staticUrl url serviceId } }
      }
    }`,
    {
      first: args.limit,
      input: {
        projectId: args.projectId,
        ...(args.serviceId ? { serviceId: args.serviceId } : {}),
        ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      },
    },
  );
  return {
    deployments: data.deployments.edges.map(({ node }) => ({
      id: node.id,
      status: node.status,
      createdAt: node.createdAt,
      url: node.staticUrl ?? node.url ?? null,
      serviceId: node.serviceId,
    })),
  };
}

export interface RailwayLogLine {
  message: string;
  timestamp: string | null;
  severity: string | null;
}

/**
 * Per-line cap on forwarded log text. The input bounds the line *count*
 * (limit ≤ 500), but a single stack trace / JSON dump can be many KB; cap each
 * line so a noisy deployment can't hand the model a giant unbounded blob.
 */
const MAX_LOG_LINE_CHARS = 2_000;

export async function railwayGetLogs(args: {
  token: string;
  deploymentId: string;
  limit: number;
}): Promise<{ logs: RailwayLogLine[] }> {
  const data = await railwayGraphql<{
    deploymentLogs: Array<{ message: string; timestamp: string | null; severity: string | null }>;
  }>(
    args.token,
    `query deploymentLogs($deploymentId: String!, $limit: Int) {
      deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
        message
        timestamp
        severity
      }
    }`,
    { deploymentId: args.deploymentId, limit: args.limit },
  );
  return {
    logs: data.deploymentLogs.map((line) => ({
      ...line,
      message:
        line.message.length > MAX_LOG_LINE_CHARS
          ? `${line.message.slice(0, MAX_LOG_LINE_CHARS)}… [truncated]`
          : line.message,
    })),
  };
}

export async function railwayRedeploy(args: {
  token: string;
  deploymentId: string;
}): Promise<{ id: string; status: string | null }> {
  const data = await railwayGraphql<{ deploymentRedeploy: { id: string; status: string | null } }>(
    args.token,
    `mutation deploymentRedeploy($id: String!) {
      deploymentRedeploy(id: $id) { id status }
    }`,
    { id: args.deploymentId },
  );
  return { id: data.deploymentRedeploy.id, status: data.deploymentRedeploy.status };
}
