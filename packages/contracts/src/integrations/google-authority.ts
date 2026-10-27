/**
 * Google authorities: the named scope sets that a Google call needs. The registry
 * entry owns them (ADR-0093): `anyOfScopes` is the read grant, `grants` the narrower
 * ones. Do not write a Google scope list anywhere else.
 */

import type { GOOGLE_FEATURE_SCOPES, GoogleScope } from "../google-scopes";
import { INTEGRATIONS, type CredentialSpec, type IntegrationEntryOf } from "./registry";
import { GOOGLE_SLUGS, type GoogleSlug } from "./slugs";

type GoogleCredentialOf<S extends GoogleSlug> = IntegrationEntryOf<S>["credential"];

type GrantName<S extends GoogleSlug> = keyof GoogleCredentialOf<S>["grants"] & string;

/** The slug alone is the read grant (`anyOfScopes`). `<slug>_<grant>` is a named grant. */
export type GoogleAuthority = {
  [S in GoogleSlug]: S | `${S}_${GrantName<S>}`;
}[GoogleSlug];

type GoogleOAuthSpec = Extract<CredentialSpec, { shape: "google_oauth" }>;

// Google slugs hold no `_`, so `<slug>_<grant>` keys never collide with a slug.
const AUTHORITY_SCOPES: ReadonlyMap<string, readonly GoogleScope[]> = new Map(
  GOOGLE_SLUGS.flatMap((slug) => {
    const credential: GoogleOAuthSpec = INTEGRATIONS[slug].credential;

    return [
      [slug, credential.anyOfScopes] as const,
      ...Object.entries(credential.grants).map(
        ([grant, scopes]) => [`${slug}_${grant}`, scopes] as const,
      ),
    ];
  }),
);

/** The scopes that satisfy one authority. Any one of them is enough. */
export function googleAuthorityScopes(authority: GoogleAuthority): readonly GoogleScope[] {
  const scopes = AUTHORITY_SCOPES.get(authority);

  // Never `[]` on a miss: an empty list passes every row (`holdsAnyScope`).
  if (scopes === undefined) throw new Error(`Unknown Google authority: ${authority}`);

  return scopes;
}

// ---------------------------------------------------------------------------
// Consent coverage: a grant that no scope of the entry's own `features` satisfies
// is a permanent "needs reconnect", because the targeted reconnect cannot fix it.
// ---------------------------------------------------------------------------

type ConsentScope<S extends GoogleSlug> =
  (typeof GOOGLE_FEATURE_SCOPES)[GoogleCredentialOf<S>["features"][number]][number];

/** `A` when no scope in `Scopes` is one that the consent of `S` asks for. */
type Uncovered<
  S extends GoogleSlug,
  A extends string,
  Scopes,
> = Scopes extends readonly (infer Scope)[]
  ? [Extract<Scope, ConsentScope<S>>] extends [never]
    ? A
    : never
  : A;

/** The authorities that the entry's own consent request cannot satisfy. `never` when all are covered. */
type UncoveredAuthority = {
  [S in GoogleSlug]:
    | Uncovered<S, S, GoogleCredentialOf<S>["anyOfScopes"]>
    | {
        [G in GrantName<S>]: Uncovered<S, `${S}_${G}`, GoogleCredentialOf<S>["grants"][G]>;
      }[GrantName<S>];
}[GoogleSlug];

/** Fails to compile, and names the authority, when a grant is not covered by consent. */
export const GOOGLE_GRANTS_COVERED_BY_CONSENT: [UncoveredAuthority] extends [never]
  ? true
  : UncoveredAuthority = true;
