import { getStringPath, httpErrorFromResponse } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { createHmac, createPrivateKey, timingSafeEqual, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import { z } from "zod";

/**
 * GitHub *App* authentication (ADR-0052), replacing the classic OAuth App.
 *
 * Three distinct credentials, three jobs:
 *   - App JWT (App id + private key, RS256) — authenticates *as the App* to
 *     mint installation tokens. Short-lived (≤10 min), never stored.
 *   - Installation token — what REST calls actually use. Minted on demand
 *     from the App JWT, scoped to one installation's repos, expires in ~1h.
 *   - User-to-server OAuth token — proves *who the user is* (their login),
 *     captured during install. Stored on the credential row for identity.
 *
 * We keep the package's no-Octokit convention: jose signs the JWT, plain
 * `fetch` does the REST. The installation token is cached in-process (the
 * server is one long-lived process) so we don't re-mint per call.
 */

const API_BASE = "https://api.github.com";
const TOKEN_BASE = "https://github.com/login/oauth/access_token";
const USER_BASE = `${API_BASE}/user`;
const GITHUB_FETCH_TIMEOUT_MS = 30_000;
const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "alfred-app",
} as const;

function githubFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
}

export interface GithubAppConfig {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  /** PEM with real newlines (env stores them `\n`-escaped). PKCS#1 from GitHub. */
  privateKey: string;
  webhookSecret: string;
  redirectUri: string;
}

export function getGithubAppConfig(): GithubAppConfig {
  const env = serverEnv();
  return {
    appId: env.GITHUB_APP_ID,
    slug: env.GITHUB_APP_SLUG,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    redirectUri: env.GITHUB_APP_REDIRECT_URI,
  };
}

/** `https://github.com/apps/<slug>/installations/new` — installs the App and (with
 *  request_oauth_on_install) authorizes the user in one screen. */
export function buildInstallUrl(state: string): string {
  const { slug } = getGithubAppConfig();
  return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
}

// GitHub's manifest issues a PKCS#1 key (`BEGIN RSA PRIVATE KEY`), which
// jose's importPKCS8 rejects; Node's createPrivateKey auto-detects the
// encoding and yields a KeyObject jose signs with directly.
let _signingKey: KeyObject | undefined;
function signingKey(): KeyObject {
  if (!_signingKey) _signingKey = createPrivateKey(getGithubAppConfig().privateKey);
  return _signingKey;
}

/** Mint a short-lived App JWT (RS256). `iat` is backdated 60s for clock skew. */
export async function mintAppJwt(): Promise<string> {
  const { appId } = getGithubAppConfig();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540) // 9 min, under GitHub's 10-min ceiling
    .setIssuer(appId)
    .sign(signingKey());
}

const installationTokenSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
});

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

// In-process cache keyed by installation id. Re-mint a couple minutes before
// expiry so a cached token never goes stale mid-request.
const _installationTokens = new Map<string, InstallationToken>();
const TOKEN_SAFETY_MS = 5 * 60 * 1000;

export async function getInstallationToken(installationId: string): Promise<InstallationToken> {
  const cached = _installationTokens.get(installationId);
  if (cached && cached.expiresAt.getTime() - Date.now() > TOKEN_SAFETY_MS) {
    return cached;
  }
  const jwt = await mintAppJwt();
  const res = await githubFetch(`${API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw await httpErrorFromResponse("github.app", res, {
      url: `${API_BASE}/app/installations/${installationId}/access_tokens`,
      method: "POST",
    });
  }
  const parsed = installationTokenSchema.parse(await res.json());
  const token: InstallationToken = { token: parsed.token, expiresAt: new Date(parsed.expires_at) };
  _installationTokens.set(installationId, token);
  return token;
}

const userTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  // Present only when the App has "expiring user tokens" enabled.
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
});

const githubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
});

const userInstallationRepositoriesSchema = z.object({
  total_count: z.number(),
});

export interface ExchangeUserCodeResult {
  /** Numeric GitHub user id, stringified — credential rows key on `account_id: string`. */
  accountId: string;
  accountLogin: string;
  accountEmail: string | null;
  accountName: string | null;
  accessToken: string;
  refreshToken: string | null;
  /** Token expiry; far-future sentinel when the App issues non-expiring user tokens. */
  expiresAt: Date;
  scopes: string[];
  tokenType: string;
}

const FAR_FUTURE = () => new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);

/**
 * Exchange the user-to-server `code` (delivered alongside `installation_id`
 * on the post-install redirect) for a user token, then identify the user so
 * we have a stable `accountId` + login to upsert against.
 */
export async function exchangeUserCode(code: string): Promise<ExchangeUserCodeResult> {
  const cfg = getGithubAppConfig();
  const tokenRes = await githubFetch(TOKEN_BASE, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    throw new Error(
      `[github.app] user code exchange failed: ${tokenRes.status} ${body.slice(0, 300)}`,
    );
  }
  const tokenJson = await tokenRes.json();
  const parsed = userTokenResponseSchema.safeParse(tokenJson);
  if (!parsed.success) {
    throw new Error(
      `[github.app] user code exchange returned non-token payload: ${getStringPath(tokenJson, "error") ?? ""} ${getStringPath(tokenJson, "error_description") ?? ""}`.trim(),
    );
  }

  const userRes = await githubFetch(USER_BASE, {
    headers: { ...GH_HEADERS, Authorization: `Bearer ${parsed.data.access_token}` },
  });
  if (!userRes.ok) {
    throw await httpErrorFromResponse("github.app", userRes, { url: USER_BASE });
  }
  const user = githubUserSchema.parse(await userRes.json());

  return {
    accountId: String(user.id),
    accountLogin: user.login,
    accountEmail: user.email ?? null,
    accountName: user.name ?? null,
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresAt: parsed.data.expires_in
      ? new Date(Date.now() + parsed.data.expires_in * 1000)
      : FAR_FUTURE(),
    scopes: parsed.data.scope ? parsed.data.scope.split(/[,\s]+/).filter(Boolean) : [],
    tokenType: parsed.data.token_type ?? "bearer",
  };
}

/**
 * GitHub warns that the setup callback's `installation_id` is user-supplied
 * and can be spoofed. Verify it with the user-to-server token before binding
 * the installation to an Alfred credential.
 */
export async function canUserAccessInstallation(args: {
  accessToken: string;
  installationId: string;
}): Promise<boolean> {
  if (!/^\d+$/.test(args.installationId)) return false;

  const url = new URL(`${API_BASE}/user/installations/${args.installationId}/repositories`);
  url.searchParams.set("per_page", "1");
  const res = await githubFetch(url, {
    headers: { ...GH_HEADERS, Authorization: `Bearer ${args.accessToken}` },
  });

  if (res.status === 403 || res.status === 404) return false;
  if (!res.ok) {
    throw await httpErrorFromResponse("github.app", res, { url: url.toString() });
  }

  userInstallationRepositoriesSchema.parse(await res.json());
  return true;
}

/**
 * Verify a webhook's `X-Hub-Signature-256` over the *raw* request body. The
 * HMAC must be computed on the exact bytes GitHub sent — re-serializing the
 * parsed JSON would change whitespace and break the comparison.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  const { webhookSecret } = getGithubAppConfig();
  const expected = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}
