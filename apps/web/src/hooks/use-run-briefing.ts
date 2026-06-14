import { useMutation, useQueryClient } from "@tanstack/react-query";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";

/**
 * Trigger an on-demand briefing run (the rail "Generate briefing" button).
 * POSTs `/api/me/briefings/run`; the server picks the slot by time of day
 * and runs it with `reason: "manual"` (always sends — no suppression).
 *
 * The run is a multi-agent compose and takes minutes, so the caller owns a
 * "composing" state and polls `useLatestBriefing({ poll })` until today's
 * briefing row appears. On success this invalidates the latest-briefing
 * query so polling picks up immediately.
 */
export interface RunBriefingResult {
  status: "queued" | "running" | "exists";
  slot: "morning" | "evening";
  runId?: string;
}

export function useRunBriefing() {
  const queryClient = useQueryClient();
  return useMutation<RunBriefingResult, Error, void>({
    mutationFn: async () => {
      const res = await client.api.me.briefings.run.post();
      if (res.error) {
        throw new Error(responseErrorMessage(res.error.value, res.status, "Generate briefing"));
      }
      return res.data as RunBriefingResult;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["me", "briefings", "latest"] });
    },
  });
}
