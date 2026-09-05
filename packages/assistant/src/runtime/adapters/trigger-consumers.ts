import { registerTriggerConsumer } from "@alfred/assistant/triggers";
import { acceptEvent } from "@alfred/assistant/automation";
import { replyDraftingTriggerConsumer } from "@alfred/assistant/reply-drafting";
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
    // Post-triage reply-drafting gate (ADR-0097): reacts to `email-triage.classified`.
    registerTriggerConsumer(replyDraftingTriggerConsumer()),
  ];
}

export function unregisterTriggerConsumers(): void {
  for (const unregister of unregisterConsumers ?? []) unregister();
  unregisterConsumers = undefined;
}
