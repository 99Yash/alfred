import { registerEventConsumer } from "../modules/eventing";
import { acceptEvent } from "../modules/workflows";

let unregisterWorkflowConsumer: (() => void) | undefined;

/** Connect product event consumers without making producers import them. */
export function registerEventConsumers(): void {
  if (unregisterWorkflowConsumer) return;
  unregisterWorkflowConsumer = registerEventConsumer({
    name: "workflow-event-trigger",
    accept: acceptEvent,
  });
}

export function unregisterEventConsumers(): void {
  unregisterWorkflowConsumer?.();
  unregisterWorkflowConsumer = undefined;
}
