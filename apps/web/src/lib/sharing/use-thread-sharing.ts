import {
  sharedThreadPageSchema,
  sharedThreadSummarySchema,
  type SharedThreadSummary,
} from "@alfred/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { client, parseEdenBody } from "~/lib/eden";

/**
 * Client half of thread sharing (ADR-0102).
 *
 * Publishing is a mutation and never a render-time effect: a share mints a
 * world-readable URL, so it must happen because the user pressed a button, not
 * because a component mounted or a query refetched.
 */

const sharesResponseSchema = z.object({ shares: z.array(sharedThreadSummarySchema) });

const sharesKey = (threadId: string) => ["threads", threadId, "shares"] as const;

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
      const res = await client.api.threads({ threadId }).shares.get();

      if (res.error) throw new Error(`share list failed (${res.error.status})`);

      return parseEdenBody(sharesResponseSchema, res.data).shares;
    },
    staleTime: 30_000,
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

      if (res.error) throw new Error(`share failed (${res.error.status})`);

      return parseEdenBody(sharedThreadSummarySchema, res.data);
    },
    onSuccess: () => {
      if (threadId) void queryClient.invalidateQueries({ queryKey: sharesKey(threadId) });
    },
  });
}

/**
 * Revoke a share. The server hard-deletes the row, so this is not reversible
 * and the dialog confirms before calling it.
 */
export function useRevokeShare(threadId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sharedThreadId: string) => {
      const res = await client.api.shares({ sharedThreadId }).delete();

      if (res.error) throw new Error(`revoke failed (${res.error.status})`);
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
 * `retry: false` because the only interesting failure is 404 (revoked or never
 * existed) and retrying it just delays the "not available" page.
 */
export function useSharedThreadPage(urlSlug: string) {
  return useQuery({
    queryKey: ["shared-thread", urlSlug],
    retry: false,
    queryFn: async () => {
      const res = await client.api.shared({ urlSlug }).get();

      if (res.error) throw new Error(`shared thread failed (${res.error.status})`);

      return parseEdenBody(sharedThreadPageSchema, res.data);
    },
  });
}

/** The absolute URL a visitor opens. Built from the current origin, so dev and prod each get their own. */
export function sharedThreadUrl(urlSlug: string): string {
  return `${window.location.origin}/c/${urlSlug}`;
}
