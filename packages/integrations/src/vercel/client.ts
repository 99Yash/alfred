/**
 * Vercel REST client (https://vercel.com/docs/rest-api). Thin `fetch` wrapper.
 * Every call optionally carries `?teamId=` — required when the integration was
 * installed on a team rather than a personal account (we stash the team id in
 * the credential metadata at connect).
 */

import { httpErrorFromResponse } from "@alfred/contracts";

const VERCEL_API = "https://api.vercel.com";

async function vercelFetch<T>(args: {
  accessToken: string;
  path: string;
  teamId?: string | null;
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}): Promise<T> {
  const url = new URL(`${VERCEL_API}${args.path}`);
  if (args.teamId) url.searchParams.set("teamId", args.teamId);
  for (const [k, v] of Object.entries(args.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method: args.method ?? "GET",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw await httpErrorFromResponse("vercel", res, {
      url: args.path,
      method: args.method ?? "GET",
    });
  }
  return (await res.json()) as T;
}

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
  latestDeploymentState: string | null;
}

export async function vercelListProjects(args: {
  accessToken: string;
  teamId?: string | null;
  limit: number;
}): Promise<{ projects: VercelProject[] }> {
  const json = await vercelFetch<{
    projects: Array<{
      id: string;
      name: string;
      framework?: string | null;
      latestDeployments?: Array<{ readyState?: string | null }>;
    }>;
  }>({
    accessToken: args.accessToken,
    teamId: args.teamId,
    path: "/v10/projects",
    query: { limit: args.limit },
  });
  return {
    projects: json.projects.map((p) => ({
      id: p.id,
      name: p.name,
      framework: p.framework ?? null,
      latestDeploymentState: p.latestDeployments?.[0]?.readyState ?? null,
    })),
  };
}

export interface VercelDeployment {
  uid: string;
  name: string;
  url: string | null;
  state: string | null;
  target: string | null;
  createdAt: number | null;
}

export async function vercelListDeployments(args: {
  accessToken: string;
  teamId?: string | null;
  projectId?: string;
  limit: number;
}): Promise<{ deployments: VercelDeployment[] }> {
  const json = await vercelFetch<{
    deployments: Array<{
      uid: string;
      name: string;
      url?: string | null;
      state?: string | null;
      readyState?: string | null;
      target?: string | null;
      created?: number | null;
      createdAt?: number | null;
    }>;
  }>({
    accessToken: args.accessToken,
    teamId: args.teamId,
    path: "/v6/deployments",
    query: { limit: args.limit, projectId: args.projectId },
  });
  return {
    deployments: json.deployments.map((d) => ({
      uid: d.uid,
      name: d.name,
      url: d.url ?? null,
      state: d.state ?? d.readyState ?? null,
      target: d.target ?? null,
      createdAt: d.createdAt ?? d.created ?? null,
    })),
  };
}

export async function vercelRedeploy(args: {
  accessToken: string;
  teamId?: string | null;
  deploymentId: string;
  name: string;
  target?: "production" | "preview";
}): Promise<{ uid: string; url: string | null; state: string | null }> {
  const json = await vercelFetch<{
    id?: string;
    uid?: string;
    url?: string | null;
    readyState?: string | null;
  }>({
    accessToken: args.accessToken,
    teamId: args.teamId,
    path: "/v13/deployments",
    method: "POST",
    query: { forceNew: 1 },
    body: {
      deploymentId: args.deploymentId,
      name: args.name,
      ...(args.target ? { target: args.target } : {}),
    },
  });
  // A 2xx with neither id nor uid would otherwise mask as a "successful"
  // redeploy carrying an unusable handle — surface it as a failure instead.
  const uid = json.uid ?? json.id;
  if (!uid) throw new Error("[vercel] redeploy returned no deployment id");
  return {
    uid,
    url: json.url ?? null,
    state: json.readyState ?? null,
  };
}
