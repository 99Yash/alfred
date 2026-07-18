import { useMutation, useQueryClient } from "@tanstack/react-query";
import { responseErrorMessage } from "~/lib/api-error";
import { client, type EdenData } from "~/lib/eden";

export type RunBriefingResult = EdenData<typeof client.api.me.briefings.run.post>;

export function useRunBriefing() {
  const queryClient = useQueryClient();
  return useMutation<RunBriefingResult, Error, void>({
    mutationFn: async () => {
      const res = await client.api.me.briefings.run.post();
      if (res.error) {
        throw new Error(responseErrorMessage(res.error.value, res.status, "Generate briefing"));
      }
      return res.data;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["me", "briefings", "latest"] });
    },
  });
}
