import type { Redacted } from "@alfred/contracts";

export const GITHUB_API = "https://api.github.com";

/** GitHub returns 403 without a `User-Agent`. */
export const GITHUB_REST_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "alfred-app",
} as const;

/** The only place in `github/` that unwraps a token. */
export function githubHeaders(token: Redacted<string>) {
  return { ...GITHUB_REST_HEADERS, Authorization: `Bearer ${token.unwrap()}` };
}
