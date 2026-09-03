/**
 * One grammar for an OAuth `scope` response field.
 *
 * RFC 6749 §5.1 defines `scope` as a space-delimited list, and Google's token
 * endpoint follows it. GitHub does not: an OAuth App token response returns
 * `scope=repo,read:org` — a COMMA list. A parser that splits on whitespace
 * alone therefore reads GitHub's two scopes as the single opaque string
 * `"repo,read:org"`, which is a scope no server ever grants. Any later
 * "does the grant already carry X" test then answers no forever, so a consent
 * loop that is meant to fire once fires on every authorize.
 *
 * The repo had two copies of this split with two different grammars before
 * this function existed. Splitting on either separator is safe for every
 * provider Alfred talks to, because no real scope value contains a comma.
 */

/**
 * The scopes in an OAuth `scope` field, in the order the server listed them.
 * Accepts a comma list, a space list, or any mix; returns `[]` for an absent,
 * empty, or separator-only value.
 */
export function parseOAuthScopeList(scope: string | null | undefined): string[] {
  return scope?.split(/[,\s]+/).filter(Boolean) ?? [];
}
