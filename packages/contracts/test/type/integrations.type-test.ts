/**
 * Compile-only fixture for the integration registry (ADR-0093, plan section 6
 * item 1). The registry's promise is that a per-integration fact cannot be
 * omitted, cannot land on the wrong kind of entry, and that the derived unions
 * are exactly as narrow as the record. Each `@ts-expect-error` below is one of
 * those doors; the `check-types` second pass (`tsc -p tsconfig.test.json`) turns
 * an unused directive into TS2578, so a widened type fails the build.
 *
 * Mutation-tested on 2026-09-02 by removing every directive and reading each
 * probe's own error code, then by widening the source four ways (`displayName`
 * optional, `credential` on a planned entry, `domain` optional, an action on
 * `slack`) and reading TS2578 on exactly the matching probe. See the PR body.
 */
import {
  INTEGRATION_ACTIONS,
  INTEGRATIONS,
  integrationEntry,
  type ActionSlug,
  type BearerSlug,
  type CredentialProvider,
  type IntegrationEntry,
  type LiveProviderSlug,
  type LoadableIntegrationSlug,
  type PlannedSlug,
  type SupportedGraphqlSlug,
} from "@alfred/contracts";

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;

// ---------------------------------------------------------------------------
// The record is precise. Without this half every negative below could pass
// vacuously against `any`.
// ---------------------------------------------------------------------------

export const recordIsNotAny: IsAny<typeof INTEGRATIONS> = false;
export const liveSlugIsNotAny: IsAny<LiveProviderSlug> = false;
export const providerIsNotAny: IsAny<CredentialProvider> = false;

/** The typed index narrows to the entry's own literals. */
export const githubShape: "github_app" = integrationEntry("github").credential.shape;
export const railwayConnect: "token_paste" = integrationEntry("railway").credential.connect;
export const railwayIsTheGraphqlSlug: SupportedGraphqlSlug = "railway";
export const graphqlIsOnlyRailway: IsNever<Exclude<SupportedGraphqlSlug, "railway">> = true;

// ---------------------------------------------------------------------------
// Entry shape doors.
// ---------------------------------------------------------------------------

// @ts-expect-error every entry needs a displayName; a slug with no name is copy that reads `undefined`.
export const entryWithoutDisplayName: IntegrationEntry = { kind: "internal" };

export const plannedEntryWithCredential: IntegrationEntry = {
  kind: "provider",
  status: "planned",
  displayName: "Slack",
  brand: "slack",
  // @ts-expect-error a planned provider has no credential field at all — not `deferred`, absent.
  credential: { shape: "github_app", provider: "github" },
};

// @ts-expect-error a live provider needs a domain for favicons and evidence grouping.
export const liveEntryWithoutDomain: IntegrationEntry = {
  kind: "provider",
  status: "live",
  displayName: "Notion",
  brand: "notion",
  credential: { shape: "bearer", provider: "notion", connect: "oauth" },
  passthrough: { transport: "rest" },
  summaryBlurb: "the user's Notion pages",
};

// ---------------------------------------------------------------------------
// Derived unions are exactly as narrow as the record.
// ---------------------------------------------------------------------------

// @ts-expect-error `slack` is planned: it has no credential, so it is not a provider value.
export const plannedIsNotACredentialProvider: CredentialProvider = "slack";

// @ts-expect-error GitHub is an App installation, not a bearer token.
export const githubIsNotBearer: BearerSlug = "github";

// @ts-expect-error a planned provider is not live.
export const plannedIsNotLive: LiveProviderSlug = "slack";

// @ts-expect-error `system` is Alfred's own machinery, never a loadable connection.
export const systemIsNotLoadable: LoadableIntegrationSlug = "system";

// ---------------------------------------------------------------------------
// A planned provider registers no tool action (plan section 6 item 1).
// ---------------------------------------------------------------------------

declare const planned: PlannedSlug;

// The union is real (otherwise the two lines after it hold vacuously)…
export const thereArePlannedSlugs: IsNever<PlannedSlug> = false;
// …and no planned entry registers a tool action.
export const plannedActionsAreNever: IsNever<ActionSlug<PlannedSlug>> = true;
// @ts-expect-error every planned row is the empty tuple, so it has no element to read.
export const plannedRowHasNoFirstAction = INTEGRATION_ACTIONS[planned][0];

export const slackHasNoActions: readonly [] = INTEGRATION_ACTIONS["slack"];
export const linearHasNoActions: readonly [] = INTEGRATION_ACTIONS["linear"];
