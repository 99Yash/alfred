import {
  sharedThreadPageSchema,
  sharedThreadSummarySchema,
  type SharedThreadSummary,
} from "@alfred/contracts";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { responseErrorMessage } from "~/lib/api-error";
import { client, parseEdenBody } from "~/lib/eden";

/**
 * Client half of thread sharing (ADR-0102).
 *
 * Publishing is a mutation and never a render-time effect: a share mints a
 * world-readable URL, so it must happen because the user pressed a button, not
 * because a component mounted or a query refetched.
 *
 * Every failure here travels as a {@link SharingRequestError}, which carries
 * two things a bare `Error` loses. The server's own message — "This thread has
 * no messages to share yet.", the message cap, the size cap — is the only text
 * that tells the user what to DO, and a generic "Could not create a link."
 * throws it away. The status is what lets the public page tell a revoked link
 * (404, and final) apart from a server or network failure (retry, and say so).
 */

/** A failed share request, carrying the server's message and its status. */
export class SharingRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SharingRequestError";
    this.status = status;
  }
}

/** Turn an Eden error into one of ours, keeping the server's wording. */
function sharingError(
  error: { status: number; value: unknown },
  action: string,
): SharingRequestError {
  return new SharingRequestError(
    error.status,
    responseErrorMessage(error.value, error.status, action),
  );
}

const sharesResponseSchema = z.object({ shares: z.array(sharedThreadSummarySchema) });

export const sharesKey = (threadId: string) => ["threads", threadId, "shares"] as const;

const SHARES_STALE_MS = 30_000;

/** Read one thread's live shares. Extracted so the prefetch below hits the same URL + parse. */
export async function fetchThreadShares(threadId: string): Promise<SharedThreadSummary[]> {
  const res = await client.api.threads({ threadId }).shares.get();

  if (res.error) throw sharingError(res.error, "Loading your links");

  return parseEdenBody(sharesResponseSchema, res.data).shares;
}

/**
 * Live shares of one thread. `enabled` is left to the caller so the dialog can
 * hold off until it opens — this list is only ever read inside the dialog, and
 * fetching it for every thread view would be a request per navigation.
 */
export function useThreadShares(threadId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: sharesKey(threadId ?? ""),
    enabled: Boolean(threadId) && enabled,
    queryFn: async () => {
      if (!threadId) throw new Error("thread shares need a thread id");

      return fetchThreadShares(threadId);
    },
    staleTime: SHARES_STALE_MS,
  });
}

/**
 * Warm the shares list before the dialog opens (hover/focus on the Share
 * button). The dialog gates its query on `open`, so a cold first click mounts
 * the entrance animation and the loading spinner in the same frame: the list
 * popping in mid-animation is the first-open jank. A hover prefetch lets the
 * first open read from cache like every later one, with no per-navigation
 * fetch. Fire-and-forget — a miss just falls back to the loading row.
 */
export function prefetchThreadShares(queryClient: QueryClient, threadId: string | undefined): void {
  if (!threadId) return;
  void queryClient.prefetchQuery({
    queryKey: sharesKey(threadId),
    queryFn: () => fetchThreadShares(threadId),
    staleTime: SHARES_STALE_MS,
  });
}

/**
 * Publish the thread. The server reuses an existing share when re-publishing
 * would produce the same page, so the returned summary is not necessarily new —
 * the dialog treats "just minted" and "already published" identically on
 * purpose, because the user asked for a link, not for a fresh one.
 */
export function useShareThread(threadId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<SharedThreadSummary> => {
      if (!threadId) throw new Error("sharing needs a thread id");
      const res = await client.api.threads({ threadId }).share.post();

      if (res.error) throw sharingError(res.error, "Creating the link");

      return parseEdenBody(sharedThreadSummarySchema, res.data);
    },
    onSuccess: () => {
      if (threadId) void queryClient.invalidateQueries({ queryKey: sharesKey(threadId) });
    },
  });
}

/**
 * Revoke a share. The server hard-deletes the row, so this is not reversible.
 * `ShareRow` asks for a second click before calling it — a claim this comment
 * used to make while the dialog revoked on the first one.
 */
export function useRevokeShare(threadId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sharedThreadId: string) => {
      const res = await client.api.shares({ sharedThreadId }).delete();

      if (res.error) throw sharingError(res.error, "Revoking the link");
    },
    onSuccess: () => {
      if (threadId) void queryClient.invalidateQueries({ queryKey: sharesKey(threadId) });
    },
  });
}

/**
 * Read a published thread by slug. This is the one query in the app that runs
 * without a session; a signed-out visitor is the expected caller.
 *
 * `retry: false` only for 404. A revoked or never-existing slug will answer the
 * same way however many times it is asked, so retrying it just delays the page
 * that says so; a 429, a 500, or a dropped connection is worth a second try,
 * and the page offers the visitor a third.
 */
export function useSharedThreadPage(urlSlug: string) {
  return useQuery({
    queryKey: ["shared-thread", urlSlug],
    retry: (failureCount, error) =>
      failureCount < 2 && !(error instanceof SharingRequestError && error.status === 404),
    queryFn: async () => {
      const res = await client.api.shared({ urlSlug }).get();

      if (res.error) throw sharingError(res.error, "Loading this thread");

      return parseEdenBody(sharedThreadPageSchema, res.data);
    },
  });
}

/** The absolute URL a visitor opens. Built from the current origin, so dev and prod each get their own. */
export function sharedThreadUrl(urlSlug: string): string {
  return `${window.location.origin}/c/${urlSlug}`;
}
