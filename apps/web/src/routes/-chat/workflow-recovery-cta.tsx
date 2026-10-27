import { workflowRecoveryNavigationSchema } from "@alfred/contracts";
import { ArrowRight } from "lucide-react";

import type { ResolvedToolCall } from "~/lib/chat/resolved-tool-call";
import { API_URL } from "~/lib/eden";

/** Executable recovery returned by system.author_workflow or system.recover_workflow. */
export function WorkflowRecoveryCta({ tools }: { tools: readonly ResolvedToolCall[] }) {
  for (let index = tools.length - 1; index >= 0; index--) {
    const tool = tools[index];

    if (
      !tool ||
      tool.status !== "succeeded" ||
      (tool.toolName !== "system.author_workflow" && tool.toolName !== "system.recover_workflow")
    ) {
      continue;
    }

    const recovery = workflowRecoveryNavigationSchema.safeParse(tool.result?.recovery);

    if (!recovery.success) continue;

    return (
      <a
        href={`${API_URL}${recovery.data.path}`}
        className="inline-flex w-fit items-center gap-1.5 rounded-control bg-app-purple-1 px-3 py-2 text-[13px] font-medium text-app-purple-4 transition-colors hover:bg-app-purple-2 focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:outline-none"
      >
        {recovery.data.label}
        <ArrowRight size={13} aria-hidden />
      </a>
    );
  }

  return null;
}
