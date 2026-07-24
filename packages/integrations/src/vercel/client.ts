/**
 * Vercel REST client (https://vercel.com/docs/rest-api). Thin `fetch` wrapper.
 * Every call optionally carries `?teamId=` — required when the integration was
 * installed on a team rather than a personal account (we stash the team id in
 * the credential metadata at connect).
 */

import { isRecord, redacted, type Redacted } from "@alfred/contracts";
import { z } from "zod";

import { authedJson } from "../shared/authed-json";
import { getActiveBearerCredential } from "../shared/credentials";
import type { ProviderBindOptions } from "../shared/provider";
import { defineProviderClient } from "../shared/provider-client";
import type { RetryPolicy } from "../shared/retry";
import type { RestPassthroughProfile } from "../shared/rest-passthrough";

const VERCEL_API = "https://api.vercel.com";

/**
 * Transport profile for the general read-only passthrough tier (ADR-0074): the
 * pinned Vercel REST authority + bearer auth. A team install must echo `teamId`
 * on every call, so it is pinned as `fixedQuery` (the model's own `query` can
 * never override it). Personal installs pass `teamId: null` → no fixed query.
 */
export function vercelPassthroughProfile(args: {
  token: string;
  teamId: string | null;
}): RestPassthroughProfile {
  return {
    baseUrl: VERCEL_API,
    headers: { Authorization: `Bearer ${args.token}`, Accept: "application/json" },
    ...(args.teamId ? { fixedQuery: { teamId: args.teamId } } : {}),
  };
}

/**
 * Authenticated Vercel REST call returning the parsed JSON body as `unknown`;
 * each caller validates it with a `zod` schema (no `as T` on `response.json()`).
 * The `?teamId=` and other query params are pinned here; a non-2xx maps to an
 * `HttpError` reporting the redacted path (never the token-bearing URL).
 */
async function vercelFetch(args: {
  accessToken: string;
  path: string;
  teamId?: string | null;
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}): Promise<unknown> {
  const url = new URL(`${VERCEL_API}${args.path}`);
  if (args.teamId) url.searchParams.set("teamId", args.teamId);
  for (const [k, v] of Object.entries(args.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return authedJson(
    { headers: { Authorization: `Bearer ${args.accessToken}`, Accept: "application/json" } },
    { url, method: args.method ?? "GET", body: args.body },
    { provider: "vercel", urlLabel: args.path },
  );
}

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
  latestDeploymentState: string | null;
}

const listProjectsResponseSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      framework: z.string().nullish(),
      latestDeployments: z.array(z.object({ readyState: z.string().nullish() })).optional(),
    }),
  ),
});

export async function vercelListProjects(args: {
  accessToken: string;
  teamId?: string | null;
  limit: number;
}): Promise<{ projects: VercelProject[] }> {
  const json = listProjectsResponseSchema.parse(
    await vercelFetch({
      accessToken: args.accessToken,
      teamId: args.teamId,
      path: "/v10/projects",
      query: { limit: args.limit },
    }),
  );
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

const listDeploymentsResponseSchema = z.object({
  deployments: z.array(
    z.object({
      uid: z.string(),
      name: z.string(),
      url: z.string().nullish(),
      state: z.string().nullish(),
      readyState: z.string().nullish(),
      target: z.string().nullish(),
      created: z.number().nullish(),
      createdAt: z.number().nullish(),
    }),
  ),
});

export async function vercelListDeployments(args: {
  accessToken: string;
  teamId?: string | null;
  projectId?: string;
  limit: number;
}): Promise<{ deployments: VercelDeployment[] }> {
  const json = listDeploymentsResponseSchema.parse(
    await vercelFetch({
      accessToken: args.accessToken,
      teamId: args.teamId,
      path: "/v6/deployments",
      query: { limit: args.limit, projectId: args.projectId },
    }),
  );
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

const redeployResponseSchema = z.object({
  id: z.string().optional(),
  uid: z.string().optional(),
  url: z.string().nullish(),
  readyState: z.string().nullish(),
});

export async function vercelRedeploy(args: {
  accessToken: string;
  teamId?: string | null;
  deploymentId: string;
  name: string;
  target?: "production" | "preview";
}): Promise<{ uid: string; url: string | null; state: string | null }> {
  const json = redeployResponseSchema.parse(
    await vercelFetch({
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
    }),
  );
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

/**
 * PROTOTYPE — the Vercel counterpart to `createGithubClient`, on the SAME shared
 * `defineProviderClient` seam. It exists to prove a second provider slots in
 * without re-hand-rolling the fetch skeleton: only what is genuinely
 * Vercel-specific lives here — the bearer credential path, the `teamId` pinned
 * on every call, and the per-method path + schema (reused from above). The base
 * URL, retry, error classification and JSON parsing are the shared seam.
 */
export interface VercelClientOptions {
  /** Resolve fresh auth per call: the bearer token (Redacted) + optional team scope. */
  resolveAuth: () => Promise<{ token: Redacted<string>; teamId: string | null }>;
  retry?: RetryPolicy;
}

export function createVercelClient(options: VercelClientOptions) {
  const client = defineProviderClient({
    provider: "vercel",
    baseUrl: VERCEL_API,
    // Bearer unwrapped only here, at the headers; teamId pinned on every request.
    resolve: async () => {
      const { token, teamId } = await options.resolveAuth();
      return {
        headers: { Authorization: `Bearer ${token.unwrap()}`, Accept: "application/json" },
        ...(teamId ? { fixedQuery: { teamId } } : {}),
      };
    },
    retry: options.retry,
  });

  return {
    async projects(args?: { limit?: number }): Promise<VercelProject[]> {
      const json = listProjectsResponseSchema.parse(
        await client.json("/v10/projects", {
          label: "/v10/projects",
          query: { limit: args?.limit ?? 20 },
        }),
      );
      return json.projects.map((p) => ({
        id: p.id,
        name: p.name,
        framework: p.framework ?? null,
        latestDeploymentState: p.latestDeployments?.[0]?.readyState ?? null,
      }));
    },

    async deployments(args?: { projectId?: string; limit?: number }): Promise<VercelDeployment[]> {
      const json = listDeploymentsResponseSchema.parse(
        await client.json("/v6/deployments", {
          label: "/v6/deployments",
          query: { limit: args?.limit ?? 20, projectId: args?.projectId },
        }),
      );
      return json.deployments.map((d) => ({
        uid: d.uid,
        name: d.name,
        url: d.url ?? null,
        state: d.state ?? d.readyState ?? null,
        target: d.target ?? null,
        createdAt: d.createdAt ?? d.created ?? null,
      }));
    },
  };
}

export type VercelClient = ReturnType<typeof createVercelClient>;

/**
 * The call-site entry: a Vercel client for a user. Resolves the active bearer
 * credential per call (wrapping the token as {@link Redacted}) and reads the
 * connect-time `teamId` out of the credential metadata.
 */
export function vercelClientForUser(options: ProviderBindOptions): VercelClient {
  const { userId, retry } = options;
  return createVercelClient({
    resolveAuth: async () => {
      const cred = await getActiveBearerCredential(userId, "vercel");
      const teamId =
        isRecord(cred.metadata) && typeof cred.metadata.teamId === "string"
          ? cred.metadata.teamId
          : null;
      return { token: redacted(cred.accessToken), teamId };
    },
    retry,
  });
}
