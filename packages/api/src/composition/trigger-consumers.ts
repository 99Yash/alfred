import { registerTriggerConsumer } from "../modules/triggers";
import { acceptEvent } from "../modules/workflows";

let unregisterWorkflowConsumer: (() => void) | undefined;

/** Connect product trigger consumers without making producers import them. */
export function registerTriggerConsumers(): void {
  if (unregisterWorkflowConsumer) return;
  unregisterWorkflowConsumer = registerTriggerConsumer({
    name: "workflow-event-trigger",
    accept: acceptEvent,
  });
}

export function unregisterTriggerConsumers(): void {
  unregisterWorkflowConsumer?.();
  unregisterWorkflowConsumer = undefined;
}
