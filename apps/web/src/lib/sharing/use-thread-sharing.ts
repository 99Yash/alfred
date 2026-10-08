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
 * Thread sharing (ADR-0102). Publish only on a button press, never in an effect:
 * it mints a public URL.
 */

/** Keeps the server's message (it tells the user what to do) and the status (404 means revoked). */
export class SharingRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SharingRequestError";
    this.status = status;
  }
}

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

/** Shared by the query and the prefetch, so both hit the same URL and parse. */
export async function fetchThreadShares(threadId: string): Promise<SharedThreadSummary[]> {
  const res = await client.api.threads({ threadId }).shares.get();

  if (res.error) throw sharingError(res.error, "Loading your links");

  return parseEdenBody(sharesResponseSchema, res.data).shares;
}

/** The caller sets `enabled`, so the dialog fetches only when it opens. */
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

/** Prefetch on hover or focus, so the first open does not pop the list in mid-animation. */
export function prefetchThreadShares(queryClient: QueryClient, threadId: string | undefined): void {
  if (!threadId) return;
  void queryClient.prefetchQuery({
    queryKey: sharesKey(threadId),
    queryFn: () => fetchThreadShares(threadId),
    staleTime: SHARES_STALE_MS,
  });
}

/** The server can return an existing share for the same page. The dialog treats both the same. */
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

/** Not reversible: the server deletes the row. */
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

/** Runs without a session. A 404 is final, so only it skips retry. */
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

/** Uses the current origin, so dev and prod each get their own URL. */
export function sharedThreadUrl(urlSlug: string): string {
  return `${window.location.origin}/c/${urlSlug}`;
}
