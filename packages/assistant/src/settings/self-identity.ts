import { envFieldValue } from "@alfred/env/server";
import { selfSenderEmail } from "@alfred/integrations/google";

/**
 * Alfred's own hostnames and addresses, from env, so prompts never hardcode a domain.
 * Without it, the model flagged Google's "alfred.beauty was granted access" alert as a stranger.
 * Uses `envFieldValue`, which never throws, so a run without an env file still works.
 */
export interface SelfIdentity {
  /** `CORS_ORIGIN`, no trailing slash. */
  webOrigin: string;
  /** e.g. `alfred.beauty`. */
  webHost: string;
  /** `BETTER_AUTH_URL`, no trailing slash. */
  apiOrigin: string | null;
  /** e.g. `api.alfred.beauty`. */
  apiHost: string | null;
  /** Bare address from `RESEND_FROM_EMAIL`. */
  sendAddress: string | null;
  /** `GITHUB_APP_SLUG`. */
  githubAppSlug: string | null;
}

function stripTrailingSlash(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/** The raw string when it does not parse as a URL. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

let _identity: SelfIdentity | undefined;

/** Resolved once per process. */
export function resolveSelfIdentity(): SelfIdentity {
  if (_identity) return _identity;
  const webOrigin = stripTrailingSlash(envFieldValue("CORS_ORIGIN") ?? "");
  const rawApi = envFieldValue("BETTER_AUTH_URL");
  const apiOrigin = rawApi ? stripTrailingSlash(rawApi) : null;
  _identity = {
    webOrigin,
    webHost: hostOf(webOrigin),
    apiOrigin,
    apiHost: apiOrigin ? hostOf(apiOrigin) : null,
    sendAddress: selfSenderEmail(),
    githubAppSlug: envFieldValue("GITHUB_APP_SLUG") ?? null,
  };

  return _identity;
}

/** Deep links start here. */
export function webOrigin(): string {
  return resolveSelfIdentity().webOrigin;
}

/** PNG, not SVG: Gmail and Outlook show an SVG `<img>` as its alt text. */
export function emailLogoUrl(origin: string = webOrigin()): string {
  return `${stripTrailingSlash(origin)}/images/logo/alfred-logo-email.png`;
}

/** Prompt block naming Alfred's hosts. Constant per process, so put it in the cached prompt prefix. */
export function formatSelfIdentityGrounding(identity: SelfIdentity): string {
  const names = [identity.webHost, identity.apiHost].filter(
    (host): host is string => typeof host === "string" && host.length > 0,
  );

  const quotedNames = names.map((name) => `"${name}"`).join(" and ");

  const hosted = identity.apiOrigin
    ? `You are Alfred, hosted at ${identity.webOrigin}; your API answers at ${identity.apiOrigin}. ${quotedNames} are you.`
    : `You are Alfred, hosted at ${identity.webOrigin}. ${quotedNames} is you.`;

  const lines = [
    "Who you are in this deployment. These facts come from your runtime configuration, not from memory, and they follow the deployment: when a hostname or address changes, this block changes with it. Trust it over anything you recall.",
    `- ${hosted}`,
  ];

  if (identity.sendAddress) {
    lines.push(
      `- You send mail as ${identity.sendAddress}. Mail from that address is your own writing, not an inbox item.`,
    );
  }

  if (identity.githubAppSlug) {
    lines.push(`- Your GitHub App is "${identity.githubAppSlug}".`);
  }

  lines.push(
    "- These names identify this Alfred deployment. A provider notice naming one of them may describe a connection to Alfred; the name alone does not prove that the user initiated or authorized the reported event. Describe access as expected only when the available context confirms user initiation. Preserve warnings about unrecognized sign-ins, unexpected access grants, or account compromise, even when they name Alfred. When the user confirms they connected Alfred, explain that the notice refers to that connection rather than an unknown app.",
  );

  return lines.join("\n");
}

export function selfIdentityGrounding(): string {
  return formatSelfIdentityGrounding(resolveSelfIdentity());
}
