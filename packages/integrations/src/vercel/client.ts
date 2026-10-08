import { redacted, type Redacted } from "@alfred/contracts";
import { z } from "zod";

import { getActiveBearerCredential } from "../shared/credentials";
import type { ProviderBindOptions } from "../shared/provider";
import { defineProviderClient, type ProviderRequestContext } from "../shared/provider-client";
import { restPassthroughCapability } from "../shared/rest-passthrough";
import type { RetryPolicy } from "../shared/retry";
import { readVercelTeamId } from "./credential";

/**
 * Vercel REST client (https://vercel.com/docs/rest-api).
 * A team install needs `?teamId=` on every call. Without it Vercel returns an empty
 * list, not an error (see `./credential`).
 */

const VERCEL_API = "https://api.vercel.com";

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
  latestDeploymentState: string | null;
  /**
   * `owner/repo`, or `null` when the project is not linked or Vercel sent half the pair.
   * `null` is not "no repo": the verified pull treats it as a wildcard.
   */
  linkedRepo: string | null;
}

/**
 * The commit a deployment built. `githubCommit*` names the built commit and `github*`
 * the linked repo; they differ for a fork or a manual redeploy.
 * `ref` is separate because a deployment can name a repo without a branch.
 */
export interface VercelDeploymentGit {
  org: string;
  repo: string;
  ref: string | null;
}

const listProjectsResponseSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      framework: z.string().nullish(),
      latestDeployments: z.array(z.object({ readyState: z.string().nullish() })).optional(),
      link: z
        .object({ org: z.string().nullish(), repo: z.string().nullish() })
        .nullish()
        .catch(null),
    }),
  ),
});

export interface VercelDeployment {
  uid: string;
  name: string;
  url: string | null;
  state: string | null;
  target: string | null;
  createdAt: number | null;
  git: VercelDeploymentGit | null;
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
      meta: z
        .object({
          githubCommitRef: z.string().nullish(),
          githubCommitOrg: z.string().nullish(),
          githubCommitRepo: z.string().nullish(),
          githubOrg: z.string().nullish(),
          githubRepo: z.string().nullish(),
        })
        .nullish()
        .catch(null),
    }),
  ),
});

const redeployResponseSchema = z.object({
  id: z.string().optional(),
  uid: z.string().optional(),
  url: z.string().nullish(),
  readyState: z.string().nullish(),
});

export interface VercelRedeployResult {
  uid: string;
  url: string | null;
  state: string | null;
}

export interface VercelAuthResolver {
  (): Promise<{ token: Redacted<string>; teamId: string | null }>;
}

export interface VercelClientOptions {
  resolveAuth: VercelAuthResolver;
  /** `redeploy` is a POST, so it never retries, whatever this says. */
  retry: RetryPolicy | "none";
}

/** Takes the resolver directly so tests can inject a token. Call sites use {@link vercelClientForUser}. */
export function createVercelClient(options: VercelClientOptions) {
  /** The curated reads and the passthrough share this, so both carry the same authority. */
  const authContext = async (): Promise<ProviderRequestContext> => {
    const { token, teamId } = await options.resolveAuth();

    return {
      headers: { Authorization: `Bearer ${token.unwrap()}`, Accept: "application/json" },
      ...(teamId ? { fixedQuery: { teamId } } : {}),
    };
  };

  const client = defineProviderClient({
    provider: "vercel",
    baseUrl: VERCEL_API,
    resolve: authContext,
    retry: options.retry,
    // The `{error: {code, message}}` body is the only explanation of a team-scope 403.
    bodyPolicy: "summarize",
  });

  const passthrough = restPassthroughCapability({
    slug: "vercel",
    retry: options.retry,
    resolveProfile: async () => ({ baseUrl: VERCEL_API, ...(await authContext()) }),
  });

  return {
    /** Read-only passthrough profile (ADR-0074). The read gate lives in `@alfred/assistant`. */
    passthrough,

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
        linkedRepo: p.link?.org && p.link?.repo ? `${p.link.org}/${p.link.repo}` : null,
      }));
    },

    async deployments(args?: {
      projectId?: string | undefined;
      limit?: number | undefined;
    }): Promise<VercelDeployment[]> {
      const json = listDeploymentsResponseSchema.parse(
        await client.json("/v7/deployments", {
          label: "/v7/deployments",
          query: { limit: args?.limit ?? 20, projectId: args?.projectId },
        }),
      );

      return json.deployments.map((d) => {
        const org = d.meta?.githubCommitOrg ?? d.meta?.githubOrg;
        const repo = d.meta?.githubCommitRepo ?? d.meta?.githubRepo;

        return {
          uid: d.uid,
          name: d.name,
          url: d.url ?? null,
          state: d.state ?? d.readyState ?? null,
          target: d.target ?? null,
          createdAt: d.createdAt ?? d.created ?? null,
          // Half a repo is no repo: it would build an `owner/` target.
          git: org && repo ? { org, repo, ref: d.meta?.githubCommitRef ?? null } : null,
        };
      });
    },

    /**
     * Do not mark this `idempotent`: it is a POST with `forceNew=1`, so a retry after a
     * timeout can ship a second deploy.
     */
    async redeploy(args: {
      deploymentId: string;
      name: string;
      target?: "production" | "preview" | undefined;
    }): Promise<VercelRedeployResult> {
      const json = redeployResponseSchema.parse(
        await client.json("/v13/deployments", {
          label: "/v13/deployments",
          method: "POST",
          query: { forceNew: 1 },
          body: {
            deploymentId: args.deploymentId,
            name: args.name,
            ...(args.target ? { target: args.target } : {}),
          },
        }),
      );

      // A 2xx with no id is a failure, not a success with no handle.
      const uid = json.uid ?? json.id;

      if (!uid) throw new Error("[vercel] redeploy returned no deployment id");

      return { uid, url: json.url ?? null, state: json.readyState ?? null };
    },
  };
}

export type VercelClient = ReturnType<typeof createVercelClient>;

/** Reads the credential per request, so a rotated token applies on the next call. */
export function vercelClientForUser(options: ProviderBindOptions): VercelClient {
  const { userId, retry } = options;

  const resolveAuth = async () => {
    const cred = await getActiveBearerCredential(userId, "vercel", options.accountRef);

    return { token: redacted(cred.accessToken), teamId: readVercelTeamId(cred.metadata) };
  };

  return createVercelClient({ resolveAuth, retry });
}
