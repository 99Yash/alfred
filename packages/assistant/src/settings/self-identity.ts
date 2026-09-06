import { envFieldValue } from "@alfred/env/server";
import { selfSenderEmail } from "@alfred/integrations/google";

/**
 * Alfred's own deployment identity: the names under which Alfred exists in the
 * outside world. Read from the runtime configuration once per process, so the
 * value follows the deployment. When the hosted domain changes, every prompt
 * that grounds on this block changes with it and nothing in the repo has to
 * name the domain.
 *
 * Why this exists (2026-09-06): the evening briefing surfaced Google's
 * "alfred.beauty was granted access to your Google Account" alert as a stranger
 * to revoke, minutes after the user connected Alfred on production. The model
 * had the connected catalog (ADR-0053) but no fact that said "alfred.beauty is
 * you". The first slice of runtime capability awareness
 * (`docs/plans/runtime-capability-awareness-decision-map.md`, #1 and #5) is
 * therefore the cheapest one: tell every prose builder and the triage
 * classifier who Alfred is, from configuration.
 *
 * Reads go through `envFieldValue` (single-field, never throws) rather than
 * `serverEnv()`: a booted process has already validated the whole environment,
 * and a bare test run without an env file still gets a truthful block for the
 * fields that are set (`CORS_ORIGIN` has a default) instead of a throw.
 */
export interface SelfIdentity {
  /** Public web origin, no trailing slash (`CORS_ORIGIN`). */
  webOrigin: string;
  /** Hostname of {@link SelfIdentity.webOrigin}, e.g. `alfred.beauty`. */
  webHost: string;
  /** Public API origin (`BETTER_AUTH_URL`), no trailing slash; null when unset. */
  apiOrigin: string | null;
  /** Hostname of {@link SelfIdentity.apiOrigin}, e.g. `api.alfred.beauty`. */
  apiHost: string | null;
  /** Bare address Alfred sends mail from (`RESEND_FROM_EMAIL`); null when unset. */
  sendAddress: string | null;
  /** GitHub App slug the user installs (`GITHUB_APP_SLUG`); null when unset. */
  githubAppSlug: string | null;
}

function stripTrailingSlash(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/** Hostname of a URL-ish string; the raw string when it does not parse as a URL. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

let _identity: SelfIdentity | undefined;

/** Alfred's deployment identity, resolved once per process. */
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

/** Public web origin, no trailing slash. The one place deep links start from. */
export function webOrigin(): string {
  return resolveSelfIdentity().webOrigin;
}

/**
 * System-prompt block that tells the model who it is in this deployment. Pure
 * over {@link SelfIdentity}, so a caller can render a fixture. Configuration
 * identifies Alfred; it does not prove that the user initiated an access event.
 * Constant per process, so it sits in the cache-stable part of a prompt.
 */
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

/** {@link formatSelfIdentityGrounding} over the live {@link resolveSelfIdentity}. */
export function selfIdentityGrounding(): string {
  return formatSelfIdentityGrounding(resolveSelfIdentity());
}
