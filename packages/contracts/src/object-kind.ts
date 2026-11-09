/**
 * What a source declares about the things it owns (ADR-0122 decision 1): each kind, how it lives and
 * dies, and how its native states map to a `StateCategory`. A leaf under the integration registry, so
 * a registry entry can declare its kinds and `integration-objects.ts` can read them with no cycle.
 */

import { z } from "zod";
import { enumGuard } from "./guards";

export const OBJECT_STATE_CATEGORIES = ["active", "resolved", "failed", "abandoned"] as const;

export type StateCategory = (typeof OBJECT_STATE_CATEGORIES)[number];

/**
 * Categories that may close an open ask. `failed` is out: it usually opens a CI loop.
 * Each kind narrows this, so decide closure with `closesOpenAsk`, not this tuple.
 */
export const LOOP_CLOSING_STATE_CATEGORIES = ["resolved", "abandoned"] as const;

export type LoopClosingStateCategory = (typeof LOOP_CLOSING_STATE_CATEGORIES)[number];

/**
 * The reading a kind needs before it may assert a closure (ADR-0103).
 * - `stored_projection`: the stored row is enough.
 * - `live_confirmation`: the row only nominates. A pull-only row can be older than the failure
 *   an email reports (`railway.deployment_target`).
 * A sync reader with no IO can only pass `stored_projection`.
 */
export const CLOSURE_PROOFS = ["stored_projection", "live_confirmation"] as const;

export type ClosureProof = (typeof CLOSURE_PROOFS)[number];

/** One attribute of `integration_objects.attributes` that names the object. */
export const identityAttributeSchema = z
  .strictObject({
    attribute: z.string().min(1),
    /** A prefix the provider removes in its links (Vercel `dpl_`). The bare value then also counts. */
    droppedPrefix: z.string().min(1).optional(),
    /**
     * The path segment or query parameter that precedes the value in a provider link: `service` in
     * `/service/<id>`, `environmentId` in `?environmentId=<id>`. It tells which kind the value
     * names. Absent: the value may sit anywhere in the link, so the link only nominates the object.
     */
    linkLabel: z.string().min(1).optional(),
  })
  .readonly();

export type IdentityAttribute = z.infer<typeof identityAttributeSchema>;

/**
 * The identity a kind declares (ADR-0109 rule 2). Two or more strong values, or one value the
 * provider guarantees unique. The tuple schema also rejects repeated attribute names.
 * All values must occur in one provider link. A link proves the object only when each value has a
 * `linkLabel` (see `identityProvesLink`).
 */
export const objectIdentityDeclSchema = z.union([
  z.strictObject({ uniqueKey: identityAttributeSchema }).readonly(),
  z
    .strictObject({
      tuple: z
        .tuple([identityAttributeSchema, identityAttributeSchema], identityAttributeSchema)
        .refine(
          (attributes) =>
            new Set(attributes.map(({ attribute }) => attribute)).size === attributes.length,
          { message: "identity tuple attributes must be distinct" },
        )
        .readonly(),
    })
    .readonly(),
]);

export type ObjectIdentityDecl = z.infer<typeof objectIdentityDeclSchema>;

/**
 * One kind that a source owns (ADR-0122 decision 1). Lifecycle policy is per kind, not per source,
 * because it differs per kind (#1093).
 * - `closesAskOn`: categories that close an open ask.
 * - `closesAskFrom`: the weakest reading that may assert them. No default, on purpose.
 * - `absorbing`: categories no later delivery may leave (a merged PR).
 *   Kinds that close by succession (CI runs, deployments) declare `[]`.
 */
export interface ObjectKindDef {
  readonly closesAskOn: readonly LoopClosingStateCategory[];
  readonly closesAskFrom: ClosureProof;
  readonly absorbing: readonly StateCategory[];
  /**
   * True when one identity names one piece of work, so a todo may carry it as a source ref: a
   * live todo merges on it and a resolved todo suppresses it (ADR-0092 A1). A target (a branch, a
   * service) fails again and again, so one dismissed todo would hide the next failure. Each declares
   * `false`. No default, on purpose.
   */
  readonly todoIdentity: boolean;
  /**
   * The provider's native state tokens for this kind, each mapped to a category. It replaces the
   * per-provider `normalize` function. An unlisted token maps to nothing, and nothing never closes.
   */
  readonly states: Readonly<Record<string, StateCategory>>;
  /** Links evidence to a row of this kind with no grammar (ADR-0109 rule 2). Absent: it cannot. */
  readonly identity?: ObjectIdentityDecl;
}

/** The object state that a source declares on its registry entry (ADR-0122 decision 1). */
export interface SourceDecl {
  /**
   * Domains that send this source's notification mail and serve its links. A mail from one may
   * be `about` an object of the source, and only a link on one can name an identity. A subdomain
   * also counts.
   */
  readonly domains: readonly string[];
  readonly kinds: Readonly<Record<string, ObjectKindDef>>;
  /** Minimum prefix length per key kind that allows abbreviated lookup (a 7-hex sha). Absent means exact only. */
  readonly prefixableKeys: Readonly<Record<string, number>>;
}

const DEPLOYMENT_STATUSES = ["success", "failure", "pending"] as const;

/** A deployment's verdict, from a Vercel dispatch or a verified Railway/Vercel pull. */
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** Narrows a stored `nativeState` value to a declared deployment status. */
export const isDeploymentStatus = enumGuard(DEPLOYMENT_STATUSES);

/**
 * The tokens that reducers collapse a build or a deployment to: GitHub CI, Railway, and Vercel
 * share one table.
 */
export const DEPLOYMENT_STATE_CATEGORIES = {
  success: "resolved",
  failure: "failed",
  pending: "active",
} as const satisfies Record<DeploymentStatus, StateCategory>;
