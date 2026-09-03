/**
 * The shape of one integration registry entry (ADR-0093). The record itself is
 * in `./registry`; the derived unions are in `./slugs`; the transitional tables
 * are in `./projections`.
 *
 * `kind` decides the shape. `status` exists only on a provider. A planned or
 * non-provider entry has no credential and no passthrough because its type has
 * no such field, not because a table says `deferred`.
 */

import type { GoogleFeature, GoogleScope } from "../google-scopes";

interface EntryBase {
  /** Display name for prose a user or the model reads. */
  readonly displayName: string;
  /**
   * The tool actions this integration registers. `${slug}.${action}` is the
   * tool name. A planned provider registers none; its type says so.
   */
  readonly actions: readonly string[];
}

/** Alfred's own tools (`system`) and the MCP projection (`mcp`, ADR-0018). */
export interface InternalIntegrationEntry extends EntryBase {
  readonly kind: "internal";
}

/** A local ingest channel with no provider credential (iMessage). */
export interface ChannelIntegrationEntry extends EntryBase {
  readonly kind: "channel";
}

/** A provider that has a page and a brand but no wired credential store yet. */
export interface PlannedIntegrationEntry extends EntryBase {
  readonly kind: "provider";
  readonly status: "planned";
  /** Web asset key (icon, accent); the web owns the asset. */
  readonly brand: string;
  readonly actions: readonly [];
}

/**
 * How a live provider's credential is stored and how "connected" is proved.
 *
 * The credential *provider* (the value in `integration_credentials.provider`
 * and the route family `/api/integrations/<provider>/...`) is not a field. It
 * is `"google"` for a `google_oauth` credential and the slug for every other
 * shape, so the record cannot pair one slug with another slug's route family.
 * Read it with `credentialProviderOf(slug)` from `./slugs`. If a provider ever
 * differs from its slug, add a field then; do not add a key space.
 *
 * - `google_oauth`: refresh-rotated OAuth grant. Connected iff an active
 *   credential carries one of `anyOfScopes`: Google's consent screen lets the
 *   user uncheck individual scopes, so row presence alone proves nothing. The
 *   web's older probe was an AND of ORs; every provider has one requirement,
 *   so the flat OR here is the same predicate.
 * - `github_app`: App installation (ADR-0052). App *permissions* never land in
 *   the credential's `scopes`, so connectedness is an active row with an
 *   `installation_id`; legacy classic-OAuth rows read as not-connected.
 * - `bearer`: one long-lived bearer token (Notion/Vercel OAuth, Railway pasted
 *   API token). No scopes and no installation to probe: an active row IS the
 *   proof. `connect` says how the token arrives; `token_paste` renders a form,
 *   not a redirect.
 */
export type CredentialSpec =
  | {
      readonly shape: "google_oauth";
      /** Consent features the connect route asks for (`?features=`). */
      readonly features: readonly GoogleFeature[];
      /** Connected when an active row holds any one of these. */
      readonly anyOfScopes: readonly GoogleScope[];
    }
  | { readonly shape: "github_app" }
  | { readonly shape: "bearer"; readonly connect: "oauth" | "token_paste" };

/** Transport shape of the general read-only passthrough tier (ADR-0074). */
export type PassthroughTransportKind = "rest" | "graphql";

/** `null` is a live provider with no general-invocation tier. */
export type PassthroughSpec = { readonly transport: PassthroughTransportKind } | null;

export interface LiveIntegrationEntry extends EntryBase {
  readonly kind: "provider";
  readonly status: "live";
  readonly brand: string;
  readonly credential: CredentialSpec;
  readonly passthrough: PassthroughSpec;
  /** One line the model reads in the connected summary (ADR-0053). */
  readonly summaryBlurb: string;
  /** Append the connected account identity to the summary line (ADR-0071 F2). */
  readonly identityInSummary?: true;
  /** Host for favicons and evidence grouping, e.g. `github.com`. */
  readonly domain: string;
}

export type IntegrationEntry =
  | InternalIntegrationEntry
  | ChannelIntegrationEntry
  | PlannedIntegrationEntry
  | LiveIntegrationEntry;
