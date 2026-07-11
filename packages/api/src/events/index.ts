/**
 * Realtime event bridge.
 *
 * Boot order:
 *   1. Init the user-events Redis pub/sub bus (publisher + subscriber).
 *   2. Start the outbox relay (LISTEN/NOTIFY + backstop poll).
 *
 * Shutdown reverses that order: stop the relay first so we don't enqueue
 * frames into a torn-down bus, then close the bus.
 */
import { startOutboxRelay, stopOutboxRelay } from "./outbox-relay";
import { closeUserEventsBus, initUserEventsBus } from "./user-events-bus";

export async function initEventBridge(): Promise<void> {
  await initUserEventsBus();
  await startOutboxRelay();
}

export async function closeEventBridge(): Promise<void> {
  await stopOutboxRelay();
  await closeUserEventsBus();
}
