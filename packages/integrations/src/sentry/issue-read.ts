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

const liveSentryIssueSchema = z.object({
  id: z.string(),
  status: z.string(),
});

export type LiveSentryIssue = z.infer<typeof liveSentryIssueSchema>;

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

  return liveSentryIssueSchema.parse(raw);
}
