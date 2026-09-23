import { type SentryIssueNativeState } from "@alfred/contracts";
import { z } from "zod";

import { authedJson } from "../shared/authed-json";
import { getActiveBearerCredential } from "../shared/credentials";
import { SENTRY_API } from "./client";

/**
 * Fresh provider-state confirmation for a Sentry issue (ADR-0103) — the proof
 * behind `INTEGRATION_OBJECT_DEFS.sentry.issue.closesAskFrom`.
 *
 * The store orders by OBSERVATION time and the lifecycle payload carries no
 * transition version, so stored `resolved` alone may never suppress an ask: a
 * delayed `issue_resolved` arriving after an `issue_unresolved` would falsely
 * restore it. This read kills that hazard structurally — closure stops
 * depending on delivery order and depends on live truth instead. The one
 * consumer is the briefing drop (`dropClosedLoops` in
 * `@alfred/assistant/briefings`). A synchronous reader cannot call this, which
 * is exactly why the kind declares `closesAskFrom: "live_confirmation"`: the
 * registry then reads as closing nothing for such a reader, instead of leaving
 * it to assert a closure it has no proof of.
 *
 * The read goes UNDER the stored org slug, never `GET /organizations/` (no
 * slug): an internal-integration token cannot list organizations (see the
 * module comment in `./client`).
 */

/**
 * Sentry's REST issue statuses. This is NOT the webhook lifecycle vocabulary
 * the object-state reducer writes: REST says `ignored` where the webhook says
 * `archived`, so a pass-through would leave the reducer's `archived` arm dead
 * on this path and make a live `ignored` indistinguishable from a read
 * failure.
 *
 * A `z.enum` rather than `z.string()` for the reason that matters to the
 * caller: if Sentry ever renames a status, the boundary parse FAILS and the
 * briefing's keep-on-failure path keeps the ask and warns. A `z.string()`
 * would instead map the unknown token to "not closed", so the feature would
 * close nothing, forever, with no signal.
 */
const SENTRY_REST_STATUSES = ["resolved", "unresolved", "ignored"] as const;

/**
 * REST status to stored native token, stated one member at a time. `satisfies`
 * over the REST vocabulary, so a status added to the list above does not
 * compile until this map says which lifecycle token it means.
 */
const NATIVE_STATE_BY_REST_STATUS = {
  resolved: "resolved",
  unresolved: "unresolved",
  ignored: "archived",
} satisfies Record<(typeof SENTRY_REST_STATUSES)[number], SentryIssueNativeState>;

const liveSentryIssueSchema = z.object({
  id: z.string(),
  status: z.enum(SENTRY_REST_STATUSES),
});

/**
 * One live issue, in the vocabulary the object-state registry reads. The REST
 * status is translated here, at the boundary that owns the REST payload, so no
 * consumer holds both vocabularies at once.
 */
export interface LiveSentryIssue {
  id: string;
  nativeState: SentryIssueNativeState;
}

export async function readLiveSentryIssue(args: {
  userId: string;
  accountRef?: string | undefined;
  issueId: string;
  signal?: AbortSignal | undefined;
}): Promise<LiveSentryIssue> {
  const cred = await getActiveBearerCredential(args.userId, "sentry", args.accountRef);

  // The org slug the connect flow stored (`sentry-routes.ts`); the token is
  // scoped to this one organization, so it is the only namespace this read
  // may run under.
  const organization = cred.accountLabel?.trim();

  if (!organization) {
    throw new Error(
      "[sentry.issue-read] the active sentry credential names no organization — reconnect sentry in settings",
    );
  }

  const path = `/organizations/${encodeURIComponent(organization)}/issues/${encodeURIComponent(args.issueId)}/`;

  const raw = await authedJson(
    { headers: { Authorization: `Bearer ${cred.accessToken}`, Accept: "application/json" } },
    { url: `${SENTRY_API}${path}`, signal: args.signal },
    { provider: "sentry", urlLabel: path, bodyPolicy: "summarize" },
  );

  const issue = liveSentryIssueSchema.parse(raw);

  // A syntactically valid response for a different issue is ambiguous, not a
  // reading of the requested one. Keep the identity check at the provider
  // boundary so every caller fails closed instead of borrowing another issue's
  // lifecycle state.
  if (issue.id !== args.issueId) {
    throw new Error("[sentry.issue-read] response issue id did not match the requested issue");
  }

  return { id: issue.id, nativeState: NATIVE_STATE_BY_REST_STATUS[issue.status] };
}
