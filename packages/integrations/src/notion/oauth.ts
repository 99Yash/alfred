import { serverEnv } from "@alfred/env/server";

/**
 * Notion public-integration OAuth (https://developers.notion.com/docs/authorization).
 * Authorization-code flow with HTTP Basic client auth on the token exchange.
 * Notion access tokens are long-lived and carry no refresh token, so there is
 * no refresh path here — the token we store is the token we keep using.
 */

const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

export interface NotionOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Read + assert the Notion OAuth env. Throws when the integration isn't configured yet. */
export function getNotionOAuthConfig(): NotionOAuthConfig {
  const env = serverEnv();
  if (!env.NOTION_OAUTH_CLIENT_ID || !env.NOTION_OAUTH_CLIENT_SECRET || !env.NOTION_OAUTH_REDIRECT_URI) {
    throw new Error(
      "[notion.oauth] Notion is not configured — set NOTION_OAUTH_CLIENT_ID, NOTION_OAUTH_CLIENT_SECRET, NOTION_OAUTH_REDIRECT_URI",
    );
  }
  return {
    clientId: env.NOTION_OAUTH_CLIENT_ID,
    clientSecret: env.NOTION_OAUTH_CLIENT_SECRET,
    redirectUri: env.NOTION_OAUTH_REDIRECT_URI,
  };
}

export function isNotionConfigured(): boolean {
  const env = serverEnv();
  return Boolean(
    env.NOTION_OAUTH_CLIENT_ID && env.NOTION_OAUTH_CLIENT_SECRET && env.NOTION_OAUTH_REDIRECT_URI,
  );
}

export function buildNotionAuthorizeUrl(state: string): string {
  const cfg = getNotionOAuthConfig();
  const url = new URL(NOTION_AUTHORIZE_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface NotionTokenResult {
  accessToken: string;
  /** Stable id we key the credential on. */
  workspaceId: string;
  workspaceName: string | null;
  workspaceIcon: string | null;
  botId: string | null;
  /** Owner's display name / email when Notion includes them. */
  ownerName: string | null;
}

export async function exchangeNotionCode(code: string): Promise<NotionTokenResult> {
  const cfg = getNotionOAuthConfig();
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const res = await fetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[notion.oauth] token exchange ${res.status} :: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    workspace_id: string;
    workspace_name?: string | null;
    workspace_icon?: string | null;
    bot_id?: string | null;
    owner?: { user?: { name?: string | null; person?: { email?: string | null } } };
  };
  const ownerName = json.owner?.user?.name ?? json.owner?.user?.person?.email ?? null;
  return {
    accessToken: json.access_token,
    workspaceId: json.workspace_id,
    workspaceName: json.workspace_name ?? null,
    workspaceIcon: json.workspace_icon ?? null,
    botId: json.bot_id ?? null,
    ownerName,
  };
}
