import type { Workflow } from "@alfred/api";
import { z } from "zod";

/**
 * Smoke-test workflow proving the m5 runtime end-to-end:
 *
 *   say-hello  →  await-approval  (interrupts on HIL)  →  finalize  →  done
 *
 * Each step does cheap work and writes to state. No external calls; no
 * real LLM. This exists to verify checkpoint persistence, interrupt /
 * resume, idempotent retries, and survival of a server restart.
 *
 * Real workflows replace this file once we have integrations + the AI
 * SDK call sites in m6/m7.
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
  stateSchema,
  initialState(input) {
    const greeting =
      typeof input.input === "object" &&
      input.input !== null &&
      "greeting" in input.input &&
      typeof (input.input as { greeting: unknown }).greeting === "string"
        ? (input.input as { greeting: string }).greeting
        : "hello";
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
        // First attempt parks; the resume flips approval to 'received'
        // before re-entering. Second attempt advances.
        if (ctx.state.approval === "pending") {
          const approvalId = `${ctx.runId}:approve`;
          return {
            kind: "interrupt",
            state: { ...ctx.state, approval: "received" },
            wake: {
              kind: "hil",
              approvalId,
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
