import { redacted, type Redacted } from "@alfred/contracts";
import { z } from "zod";

import { getActiveBearerCredential } from "../shared/credentials";
import type { ProviderBindOptions } from "../shared/provider";
import { defineProviderClient, type ProviderRequestContext } from "../shared/provider-client";
import type { RestPassthroughProfile } from "../shared/rest-passthrough";
import type { RetryPolicy } from "../shared/retry";
import { readVercelTeamId } from "./credential";

/**
 * The one door to Vercel's REST API (https://vercel.com/docs/rest-api) on a
 * user's behalf — the curated read surface plus `redeploy`, plus the transport
 * profile the general read-only passthrough tier (ADR-0074) sends through.
 *
 * Two things are Vercel-specific and both are settled in one place here:
 *
 *   1. Bearer auth from the active bearer credential, unwrapped only at the
 *      headers ({@link Redacted} everywhere above that).
 *   2. `?teamId=` — required on EVERY call when the integration was installed on
 *      a team rather than a personal account. It rides as `fixedQuery`, so it is
 *      merged after a caller's own `query` and cannot be overridden, and it is
 *      read through {@link readVercelTeamId} so the persisted key has one
 *      spelling. Both matter because a missing team scope is not an error: see
 *      `./credential` for why it surfaces as a confident empty list.
 *
 * Base URL, transient retry, error classification and JSON parsing are the
 * shared `defineProviderClient` seam, not restated here.
 */

const VERCEL_API = "https://api.vercel.com";

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

/** Resolves fresh bearer auth per call; the client stores this, not a credential. */
export interface VercelAuthResolver {
  (): Promise<{ token: Redacted<string>; teamId: string | null }>;
}

export interface VercelClientOptions {
  resolveAuth: VercelAuthResolver;
  /**
   * Transient-retry envelope for this client's retry-safe requests, or `"none"`.
   * Required — see `ProviderBindOptions.retry`. `redeploy` is a POST and is
   * excluded by method regardless of what this says.
   */
  retry: RetryPolicy | "none";
}

/**
 * A Vercel REST client bound to an auth *resolver*. Prefer
 * {@link vercelClientForUser} at call sites; this constructor takes the resolver
 * directly so tests can inject a fixed token without touching credentials.
 *
 * `resolveAuth` is called once per request, here and through
 * {@link vercelClientForUser} alike — there is no second entry point with
 * different freshness semantics, so a client is safe to hold for as long as its
 * resolver is.
 */
export function createVercelClient(options: VercelClientOptions) {
  /**
   * The one place a Vercel credential becomes a header. Both the curated reads
   * (via `resolve`) and the passthrough profile go through it, so the authority a
   * raw passthrough call carries is the same authority — origin, bearer, pinned
   * team scope — that `projects()` carries, and a change cannot reach one and
   * miss the other.
   */
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
    // Vercel returns a structured `{error: {code, message}}` that is prod-safe
    // after bounding + secret redaction, and it is the only thing that explains a
    // 403 on a team-scoped read. Stated, not inherited.
    bodyPolicy: "summarize",
  });

  return {
    /**
     * Transport profile for the general read-only passthrough tier (ADR-0074):
     * pinned authority as data, so the passthrough tool never holds a credential.
     * The gate that proves a request is a *read* is deliberately not here — that
     * is policy owned by `@alfred/api` (`assertReadableRestRequest`).
     */
    async passthroughProfile(): Promise<RestPassthroughProfile> {
      return { baseUrl: VERCEL_API, ...(await authContext()) };
    },

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

    async deployments(args?: {
      projectId?: string | undefined;
      limit?: number | undefined;
    }): Promise<VercelDeployment[]> {
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

    /**
     * Re-deploy an existing deployment. Deliberately NOT marked `idempotent`: it
     * is a POST with `forceNew=1`, so a retry after a timeout that actually
     * reached Vercel would ship a second deploy. The shared client's
     * method-eligibility gate keeps it un-retried by default; this comment exists
     * so nobody "fixes" that by opting in.
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
      // A 2xx carrying neither id nor uid would otherwise mask as a "successful"
      // redeploy with an unusable handle — surface it as a failure instead.
      const uid = json.uid ?? json.id;
      if (!uid) throw new Error("[vercel] redeploy returned no deployment id");
      return { uid, url: json.url ?? null, state: json.readyState ?? null };
    },
  };
}

export type VercelClient = ReturnType<typeof createVercelClient>;

/**
 * The ergonomic call-site entry: a Vercel client for a user, reading as
 * `vercel.projects({ limit })` with no credential in sight.
 *
 * The resolver reads the active bearer credential, wraps the token as
 * {@link Redacted}, and takes the team scope from the credential metadata. It runs
 * per request rather than once per bind: the saving would be one indexed
 * `integration_credentials` read, and the cost would be a client whose token is
 * only as fresh as the moment it was first touched — a lifetime rule no type can
 * state. Rotate the credential and the very next call picks it up.
 */
export function vercelClientForUser(options: ProviderBindOptions): VercelClient {
  const { userId, retry } = options;
  const resolveAuth = async () => {
    const cred = await getActiveBearerCredential(userId, "vercel");
    return { token: redacted(cred.accessToken), teamId: readVercelTeamId(cred.metadata) };
  };
  return createVercelClient({ resolveAuth, retry });
}
