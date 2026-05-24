import { serverEnv } from "@alfred/env/server";
import { z } from "zod";

/**
 * Classic GitHub OAuth App authorization-code helpers. Mirrors the
 * structure of `google/oauth.ts` — we call the JSON endpoints directly
 * rather than pull in Octokit just for two HTTP requests.
 *
 * "Classic" OAuth Apps (not GitHub Apps / fine-grained tokens) issue
 * long-lived access tokens with no refresh-token rotation. That keeps
 * the credential bookkeeping simpler: there is no `refreshAccessToken`
 * because `expiresAt` never elapses.
 */

const AUTH_BASE = "https://github.com/login/oauth/authorize";
const TOKEN_BASE = "https://github.com/login/oauth/access_token";
const USER_BASE = "https://api.github.com/user";

/**
 * Per-feature GitHub OAuth scopes. Same shape as the Google feature
 * map so the catalog metadata + `requireScopes` helper stay symmetric.
 *
 *   read   — `read:user` + `user:email`: identify the user, list emails
 *   repos  — `repo`: full read/write across public + private repos
 *
 * We default to `read` + `repos` together at consent time so a single
 * connect powers both "tell me about my work" and "open an issue."
 * Narrower features (a separate `notifications` scope, say) can land
 * later without a schema change.
 */
export const GITHUB_FEATURE_SCOPES = {
  read: ["read:user", "user:email"],
  repos: ["repo"],
} as const satisfies Record<string, readonly string[]>;

export type GithubFeature = keyof typeof GITHUB_FEATURE_SCOPES;

const ALL_FEATURES = Object.keys(GITHUB_FEATURE_SCOPES) as GithubFeature[];

export function scopesForFeatures(features?: readonly GithubFeature[]): string[] {
  const wanted = features?.length ? features : ALL_FEATURES;
  const set = new Set<string>();
  for (const f of wanted) {
    for (const scope of GITHUB_FEATURE_SCOPES[f]) set.add(scope);
  }
  return [...set];
}

export const DEFAULT_GITHUB_SCOPES: string[] = scopesForFeatures();

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getGithubOAuthConfig(): GithubOAuthConfig {
  const env = serverEnv();
  const { GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, GITHUB_OAUTH_REDIRECT_URI } = env;
  if (!GITHUB_OAUTH_CLIENT_ID || !GITHUB_OAUTH_CLIENT_SECRET || !GITHUB_OAUTH_REDIRECT_URI) {
    throw new Error(
      "GitHub OAuth not configured. Set GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, and GITHUB_OAUTH_REDIRECT_URI in apps/server/.env",
    );
  }
  return {
    clientId: GITHUB_OAUTH_CLIENT_ID,
    clientSecret: GITHUB_OAUTH_CLIENT_SECRET,
    redirectUri: GITHUB_OAUTH_REDIRECT_URI,
  };
}

export interface BuildAuthorizeUrlArgs {
  state: string;
  scopes?: string[];
}

export function buildAuthorizeUrl(args: BuildAuthorizeUrlArgs): string {
  const cfg = getGithubOAuthConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: (args.scopes ?? DEFAULT_GITHUB_SCOPES).join(" "),
    state: args.state,
    // GitHub honors `allow_signup=false` to skip the "create an account"
    // option on the consent screen. We want only existing accounts here.
    allow_signup: "false",
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  scope: z.string(),
});

const githubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  avatar_url: z.string().optional(),
});

export interface ExchangeCodeResult {
  /** Numeric GitHub user id, stringified — we key credential rows by `account_id: string`. */
  accountId: string;
  accountLogin: string;
  accountEmail: string | null;
  accountName: string | null;
  access_token: string;
  /** Classic tokens don't expire; we set this far in the future so credential bookkeeping stays uniform. */
  expiresAt: Date;
  scopes: string[];
  token_type: string;
}

/**
 * Trade an authorization code for an access token, then identify the user
 * so we have a stable `accountId` to upsert against. Two requests: token
 * exchange + `/user`.
 */
export async function exchangeCode(code: string): Promise<ExchangeCodeResult> {
  const cfg = getGithubOAuthConfig();
  const tokenRes = await fetch(TOKEN_BASE, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    throw new Error(`[github.oauth] token exchange failed: ${tokenRes.status} ${body.slice(0, 500)}`);
  }
  const tokenJson = await tokenRes.json();
  const parsedToken = tokenResponseSchema.safeParse(tokenJson);
  if (!parsedToken.success) {
    // GitHub returns `{ error, error_description }` on bad codes — surface it.
    const err = (tokenJson as { error?: string; error_description?: string }) ?? {};
    throw new Error(
      `[github.oauth] token exchange returned non-token payload: ${err.error ?? ""} ${err.error_description ?? ""}`.trim(),
    );
  }

  const userRes = await fetch(USER_BASE, {
    headers: {
      Authorization: `Bearer ${parsedToken.data.access_token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!userRes.ok) {
    const body = await userRes.text().catch(() => "");
    throw new Error(
      `[github.oauth] /user lookup failed: ${userRes.status} ${body.slice(0, 500)}`,
    );
  }
  const user = githubUserSchema.parse(await userRes.json());

  return {
    accountId: String(user.id),
    accountLogin: user.login,
    accountEmail: user.email ?? null,
    accountName: user.name ?? null,
    access_token: parsedToken.data.access_token,
    // Classic tokens are functionally non-expiring; set a far-future
    // sentinel so credential bookkeeping (`expiresAt`) stays uniform
    // across providers.
    expiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
    scopes: parsedToken.data.scope ? parsedToken.data.scope.split(/[,\s]+/).filter(Boolean) : [],
    token_type: parsedToken.data.token_type,
  };
}
