import { registerTriggerConsumer } from "@alfred/assistant/triggers";
import { acceptEvent } from "../modules/workflows";
import { gmailIngestedTriggerConsumers } from "./gmail-ingested-consumers";

let unregisterConsumers: (() => void)[] | undefined;

/** Connect product trigger consumers without making producers import them. */
export function registerTriggerConsumers(): void {
  if (unregisterConsumers) return;
  unregisterConsumers = [
    registerTriggerConsumer({
      name: "workflow-event-trigger",
      mode: "propagate",
      accept: acceptEvent,
    }),
    ...gmailIngestedTriggerConsumers().map((consumer) => registerTriggerConsumer(consumer)),
  ];
}

export function unregisterTriggerConsumers(): void {
  for (const unregister of unregisterConsumers ?? []) unregister();
  unregisterConsumers = undefined;
}
