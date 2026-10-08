import { type SentryIssueNativeState } from "@alfred/contracts";
import { z } from "zod";

import { authedJson } from "../shared/authed-json";
import { getActiveBearerCredential } from "../shared/credentials";
import { SENTRY_API } from "./client";

/**
 * Live check that a Sentry issue is closed (ADR-0103), behind `closesAskFrom: "live_confirmation"`.
 * Webhooks carry no version, so a late `issue_resolved` can arrive after `issue_unresolved`.
 * Stored state alone must never close an ask.
 */

/**
 * REST says `ignored` where the webhook says `archived`.
 * A `z.enum`, so a renamed status fails the parse and the briefing keeps the ask.
 */
const SENTRY_REST_STATUSES = ["resolved", "unresolved", "ignored"] as const;

/** `satisfies` forces a mapping for every REST status. */
const NATIVE_STATE_BY_REST_STATUS = {
  resolved: "resolved",
  unresolved: "unresolved",
  ignored: "archived",
} satisfies Record<(typeof SENTRY_REST_STATUSES)[number], SentryIssueNativeState>;

const liveSentryIssueSchema = z.object({
  id: z.string(),
  status: z.enum(SENTRY_REST_STATUSES),
});

/** Uses the stored lifecycle vocabulary, not the REST one. */
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

  // The token is scoped to this org and cannot list organizations.
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

  // Fail closed rather than borrow another issue's state.
  if (issue.id !== args.issueId) {
    throw new Error("[sentry.issue-read] response issue id did not match the requested issue");
  }

  return { id: issue.id, nativeState: NATIVE_STATE_BY_REST_STATUS[issue.status] };
}
