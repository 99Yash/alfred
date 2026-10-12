import { registerTriggerConsumer } from "@alfred/assistant/triggers";
import { acceptEvent } from "@alfred/assistant/automation";
import { replyDraftingTriggerConsumer } from "@alfred/assistant/reply-drafting";
import { objectStateFoldConsumers } from "@alfred/assistant/connections";
import { gmailIngestedTriggerConsumers } from "./gmail-ingested-consumers";

let unregisterConsumers: (() => void)[] | undefined;

/** Connect product trigger consumers without making producers import them. */
export function registerTriggerConsumers(): void {
  if (unregisterConsumers) return;
  unregisterConsumers = [
    registerTriggerConsumer({
      name: "workflow-event-trigger",
      mode: "propagate",
      // The publish reads only fulfilled or rejected; tests read the result directly.
      accept: async (event) => {
        await acceptEvent(event);
      },
    }),
    ...gmailIngestedTriggerConsumers().map((consumer) => registerTriggerConsumer(consumer)),
    ...objectStateFoldConsumers().map((consumer) => registerTriggerConsumer(consumer)),
    // Post-triage reply-drafting gate (ADR-0098): reacts to `email-triage.classified`.
    registerTriggerConsumer(replyDraftingTriggerConsumer()),
  ];
}

export function unregisterTriggerConsumers(): void {
  for (const unregister of unregisterConsumers ?? []) unregister();
  unregisterConsumers = undefined;
}
