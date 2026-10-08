/**
 * Boot: user-events bus, then outbox relay, then reaper. Shutdown runs in reverse.
 * Stop awaits each in-flight pass, so the runtime can close the DB pool after this resolves.
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
