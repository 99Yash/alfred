/**
 * Split an OAuth `scope` field. RFC 6749 uses spaces, but GitHub sends commas
 * (`repo,read:org`), so split on both. No real scope contains a comma.
 */
export function parseOAuthScopeList(scope: string | null | undefined): string[] {
  return scope?.split(/[,\s]+/).filter(Boolean) ?? [];
}
