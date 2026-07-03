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

import { createHash } from "node:crypto";

import { HttpError, summarizeBody, toMessage } from "@alfred/contracts";

const RAILWAY_API = "https://backboard.railway.app/graphql/v2";

interface GraphqlError {
  message: string;
  // GraphQL errors usually carry a machine-readable code; prefer it over the
  // human-readable message when classifying (message wording is upstream copy
  // and can change without notice).
  extensions?: { code?: string | null } | null;
}

export class RailwayGraphqlError extends Error {
  readonly _tag = "RailwayGraphqlError" as const;
  readonly errors: readonly GraphqlError[];

  constructor(errors: readonly GraphqlError[]) {
    super(`[railway] graphql error :: ${errors.map((e) => e.message).join("; ")}`);
    this.name = "RailwayGraphqlError";
    this.errors = errors;
  }
}

const RAILWAY_AUTHZ_CODES = new Set([
  "UNAUTHORIZED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_AUTHORIZED",
]);

export function isRailwayAuthorizationError(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 401 || err.status === 403;
  if (!(err instanceof RailwayGraphqlError)) return false;
  return err.errors.some((e) => {
    const code = e.extensions?.code;
    if (code && RAILWAY_AUTHZ_CODES.has(code.toUpperCase())) return true;
    // Load-bearing: Railway tags authz failures with extensions.code
    // "INTERNAL_SERVER_ERROR" (verified against the live API 2026-06-24), NOT a
    // real authz code — so the message text is the only reliable signal here.
    // Do not drop this regex in favour of the code check above.
    return /\b(not authorized|unauthorized|unauthenticated|forbidden)\b/i.test(e.message);
  });
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
  if (json.errors && json.errors.length > 0) throw new RailwayGraphqlError(json.errors);
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
 * route. Railway has three token shapes:
 *   - account tokens can run `me` (full personal identity);
 *   - workspace/team tokens CANNOT run `me` (it needs a personal token) but can
 *     answer the top-level `projects` connection (railwayapp/cli#845);
 *   - project tokens are out of scope.
 * We try `me` first (account path). On a null / unauthorized `me` we treat the
 * token as workspace-scoped and validate it against `projects` — the only shape
 * confirmed to work for those tokens — so a valid token is never rejected over
 * a schema guess. A non-authz upstream failure on `me` stays a failure.
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
    // Workspace/project tokens can't run `me`: Railway answers with a top-level
    // "Not Authorized" GraphQL error (handled by the catch below), not a
    // `me: null` payload, so the null branch here is a defensive fall-through.
    return data.me ? { id: data.me.id, name: data.me.name, email: data.me.email } : null;
  } catch (err) {
    if (!isRailwayAuthorizationError(err)) throw err;
    return null;
  }
}

/**
 * Identity for a workspace-scoped token. We want the most stable per-workspace
 * id we can get (it becomes the credential's `accountId`, the upsert key), so we
 * ask the token to introspect its own workspace first: `apiToken { workspaces }`
 * returns the workspace a workspace-scoped token is bound to (verified against
 * the live API 2026-06-24 — see apps/server/src/scripts/probes/probe-railway-token.ts).
 * Introspection is still best-effort and can never reject the token. The
 * fallbacks are `projects` (a real team workspace exposes `team { id name }`
 * there) and finally a synthetic id for a team-less workspace.
 */
async function resolveWorkspaceIdentity(token: string): Promise<RailwayAccount> {
  const introspected = await tryWorkspaceIntrospection(token);
  if (introspected) return introspected;

  // Validates the token (throws if it is actually invalid) and yields a stable
  // team identity when the workspace is a real team.
  const team = await firstTeamFromProjects(token);
  if (team) return { id: `team:${team.id}`, name: team.name, email: null };

  // Team-less workspace (e.g. a Hobby personal workspace) where introspection
  // returned nothing usable: accept the token with a synthetic identity keyed on
  // a fingerprint of the token itself. A literal constant id would collapse two
  // distinct team-less tokens onto one credential row (the second silently
  // overwrites the first on the (userId, 'railway', accountId) upsert); the
  // fingerprint keeps them distinct while staying idempotent across a reconnect
  // of the same token. SHA-256 (one-way, 16 hex chars) so the stored accountId
  // can't be reversed back into the token. Distinct `workspace-token:` namespace
  // so it can never alias a real `workspace:<id>` from introspection.
  return {
    id: `workspace-token:${tokenFingerprint(token)}`,
    name: "Railway workspace",
    email: null,
  };
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Best-effort identity from Railway's token introspection. `apiToken.workspaces`
 * lists the workspace(s) the token is bound to, and a workspace-scoped token
 * reports exactly one. Returns null on anything else (no/many workspaces, an
 * unknown field, authz, network) so introspection can never reject an
 * otherwise-valid token — it only ever upgrades it to a stable `workspace:<id>`.
 */
async function tryWorkspaceIntrospection(token: string): Promise<RailwayAccount | null> {
  try {
    const data = await railwayGraphql<{
      apiToken: { workspaces: Array<{ id: string; name: string | null }> } | null;
    }>(token, `query { apiToken { workspaces { id name } } }`);
    const workspaces = data.apiToken?.workspaces ?? [];
    const [workspace] = workspaces;
    // A workspace-scoped token is bound to exactly one workspace. Zero (or an
    // account-style token that slipped through with many) is ambiguous, so fall
    // through to the projects/team path rather than picking arbitrarily.
    if (!workspace || workspaces.length !== 1) return null;
    return {
      id: `workspace:${workspace.id}`,
      name: workspace.name ?? `Railway workspace ${workspace.id}`,
      email: null,
    };
  } catch (err) {
    // Best-effort: never reject a valid token over a failed introspection. But
    // leave a breadcrumb — without it, "why did this token resolve to team:/
    // workspace-token: instead of workspace:?" is an undebuggable mystery.
    console.debug(`[railway] workspace introspection failed :: ${summarizeBody(toMessage(err))}`);
    return null;
  }
}

async function firstTeamFromProjects(token: string): Promise<{ id: string; name: string } | null> {
  const data = await railwayGraphql<{
    projects: { edges: Array<{ node: { team: { id: string; name: string } | null } }> };
  }>(token, `query { projects { edges { node { team { id name } } } } }`);
  // GraphQL doesn't promise a stable edge order, so "first non-null team" over
  // the raw edges could pick a different team between two connects of the same
  // token → a flapping accountId → duplicate credential rows. Pick the
  // lowest team id deterministically so the identity is reproducible.
  const teams = data.projects.edges
    .map((e) => e.node.team)
    .filter((t): t is { id: string; name: string } => t != null);
  if (teams.length === 0) return null;
  return teams.reduce((lowest, t) => (t.id < lowest.id ? t : lowest));
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
  // while top-level `projects` is the workspace-token path and can also include
  // personal projects for account tokens. The two reads are independent, so fire
  // them concurrently and merge — a workspace token would otherwise pay a
  // guaranteed-to-fail `me` round-trip before the top-level query that's its only
  // working path. De-dupe by project id; `me` wins so a project that appears in
  // both keeps its workspace-scoped name.
  const [viaMe, topLevel] = await Promise.allSettled([
    railwayListProjectsViaMe(token),
    railwayListProjectsTopLevel(token),
  ]);

  const projectsById = new Map<string, RailwayProject>();
  if (viaMe.status === "fulfilled") {
    for (const project of viaMe.value) projectsById.set(project.id, project);
  } else if (!isRailwayAuthorizationError(viaMe.reason)) {
    // A workspace token's `me` is authz-rejected and tolerated (top-level
    // carries it); any other failure (5xx / timeout) is a real upstream error.
    // Note the deliberate asymmetry with the top-level tolerance below: `me` is
    // the COMPLETE account view (workspace + team projects), so swallowing a
    // transient `me` failure would silently return a partial list missing the
    // user's main projects. The top-level query is only supplementary for an
    // account token (personal projects), so losing it to a transient blip is
    // tolerable when `me` already answered. Different sources, different stakes.
    throw viaMe.reason;
  }

  if (topLevel.status === "fulfilled") {
    for (const project of topLevel.value) {
      if (!projectsById.has(project.id)) projectsById.set(project.id, project);
    }
  } else if (projectsById.size === 0) {
    // The top-level query is additive for account tokens but the *only* path for
    // workspace tokens. If `me` already produced projects, don't let a transient
    // failure here tank the whole call; if we have nothing yet, surface it.
    throw topLevel.reason;
  }
  return { projects: [...projectsById.values()] };
}

async function railwayListProjectsViaMe(token: string): Promise<RailwayProject[]> {
  const data = await railwayGraphql<{
    // `me` can come back null for non-account tokens (mirrors the validate path);
    // don't dereference it blindly.
    me: {
      workspaces: Array<{ team: { projects: Connection<ProjectNode> | null } | null } | null>;
    } | null;
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
  for (const workspace of data.me?.workspaces ?? []) {
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
