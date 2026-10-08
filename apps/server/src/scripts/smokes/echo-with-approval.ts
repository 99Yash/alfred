import type { Workflow } from "@alfred/assistant/execution";
import { getStringPath } from "@alfred/contracts";
import { z } from "zod";

/**
 * Smoke workflow for the runtime: say-hello, await-approval (HIL interrupt), finalize.
 * No external calls. It checks checkpoints, interrupt and resume, idempotent
 * retries, and survival of a restart.
 */
const stateSchema = z.object({
  greeting: z.string(),
  approval: z.enum(["pending", "received"]),
  echoed: z.string().optional(),
});

type State = z.infer<typeof stateSchema>;

export const echoWithApprovalWorkflow: Workflow<State> = {
  slug: "echo-with-approval",
  name: "Echo with approval (smoke)",
  description: "Greet → wait for HIL approval → echo back. Smoke test for the durable runtime.",
  trigger: { kind: "manual" },
  initialStep: "say-hello",
  closure: { kind: "none" },
  stateSchema,
  initialState(input) {
    const greeting = getStringPath(input.input, "greeting") ?? "hello";

    return { greeting, approval: "pending" };
  },
  steps: {
    "say-hello": {
      id: "say-hello",
      async run(ctx) {
        await ctx.log(`greeting=${ctx.state.greeting}`);

        return { kind: "next", state: ctx.state, nextStep: "await-approval" };
      },
    },
    "await-approval": {
      id: "await-approval",
      async run(ctx) {
        // The first attempt parks. The resume sets 'received', so the second advances.
        if (ctx.state.approval === "pending") {
          const approvalId = `${ctx.runId}:approve`;

          return {
            kind: "interrupt",
            state: { ...ctx.state, approval: "received" },
            wake: {
              kind: "hil",
              approvalId,
              approvalKind: "step",
              prompt: `Approve echo of "${ctx.state.greeting}"?`,
            },
          };
        }

        return { kind: "next", state: ctx.state, nextStep: "finalize" };
      },
    },
    finalize: {
      id: "finalize",
      async run(ctx) {
        const echoed = ctx.state.greeting.toUpperCase();

        return {
          kind: "done",
          state: { ...ctx.state, echoed },
          output: { echoed },
        };
      },
    },
  },
};
