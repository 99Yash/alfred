/**
 * Realtime event bridge.
 *
 * Boot order:
 *   1. Init the user-events Redis pub/sub bus (publisher + subscriber).
 *   2. Start the outbox relay (LISTEN/NOTIFY + backstop poll).
 *   3. Start the outbox reaper (hourly retention pass, #533).
 *
 * Shutdown reverses that order: stop the reaper so no DELETE is open, then the
 * relay so we don't enqueue frames into a torn-down bus, then close the bus.
 */
import { startOutboxReaper, stopOutboxReaper } from "./outbox-reaper";
import { startOutboxRelay, stopOutboxRelay } from "./outbox-relay";
import { closeUserEventsBus, initUserEventsBus } from "./user-events-bus";

export async function initEventBridge(): Promise<void> {
  await initUserEventsBus();
  await startOutboxRelay();
  startOutboxReaper();
}

export async function closeEventBridge(): Promise<void> {
  await stopOutboxReaper();
  await stopOutboxRelay();
  await closeUserEventsBus();
}
