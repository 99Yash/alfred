import { registerChatMedia, unregisterChatMedia } from "./chat-media";
import { registerGmailTriage, unregisterGmailTriage } from "./gmail-triage";
import { registerGmailUserModel, unregisterGmailUserModel } from "./gmail-user-model";
import {
  registerGoogleCredentialLifecycle,
  unregisterGoogleCredentialLifecycle,
} from "./google-credential-lifecycle";
import {
  registerReplicachePokeAdapter,
  unregisterReplicachePokeAdapter,
} from "./replicache-poke-adapter";
import { registerTriggerConsumers, unregisterTriggerConsumers } from "./trigger-consumers";
import { registerWorkflowReadiness, unregisterWorkflowReadiness } from "./workflow-readiness";
import { registerWorkflowRecovery, unregisterWorkflowRecovery } from "./workflow-recovery";

export interface RuntimeAdapterDefinition {
  name: string;
  register(): void;
  unregister(): void;
  retainIfIngestionWorkerActive: boolean;
  shutdownOrder: number;
}

interface RuntimeAdapterLifecycle {
  register(): void;
  unregister(input: { ingestionWorkerStopped: boolean }): void;
}

export function createRuntimeAdapterLifecycle(
  definitions: readonly RuntimeAdapterDefinition[],
): RuntimeAdapterLifecycle {
  const startupAdapters = [...definitions];
  const shutdownAdapters = [...definitions].sort(
    (left, right) => left.shutdownOrder - right.shutdownOrder,
  );

  return {
    register() {
      for (const adapter of startupAdapters) adapter.register();
    },
    unregister({ ingestionWorkerStopped }) {
      for (const adapter of shutdownAdapters) {
        if (!ingestionWorkerStopped && adapter.retainIfIngestionWorkerActive) continue;
        adapter.unregister();
      }
    },
  };
}

export const RUNTIME_ADAPTERS = [
  {
    name: "chat-media",
    register: registerChatMedia,
    unregister: unregisterChatMedia,
    retainIfIngestionWorkerActive: true,
    shutdownOrder: 1,
  },
  {
    name: "gmail-triage",
    register: registerGmailTriage,
    unregister: unregisterGmailTriage,
    retainIfIngestionWorkerActive: true,
    shutdownOrder: 2,
  },
  {
    name: "gmail-user-model",
    register: registerGmailUserModel,
    unregister: unregisterGmailUserModel,
    retainIfIngestionWorkerActive: true,
    shutdownOrder: 3,
  },
  {
    name: "google-credential-lifecycle",
    register: registerGoogleCredentialLifecycle,
    unregister: unregisterGoogleCredentialLifecycle,
    retainIfIngestionWorkerActive: false,
    shutdownOrder: 4,
  },
  {
    name: "replicache-poke-adapter",
    register: registerReplicachePokeAdapter,
    unregister: unregisterReplicachePokeAdapter,
    retainIfIngestionWorkerActive: false,
    shutdownOrder: 7,
  },
  {
    name: "trigger-consumers",
    register: registerTriggerConsumers,
    unregister: unregisterTriggerConsumers,
    retainIfIngestionWorkerActive: true,
    shutdownOrder: 0,
  },
  {
    name: "workflow-recovery",
    register: registerWorkflowRecovery,
    unregister: unregisterWorkflowRecovery,
    retainIfIngestionWorkerActive: false,
    shutdownOrder: 5,
  },
  {
    name: "workflow-readiness",
    register: registerWorkflowReadiness,
    unregister: unregisterWorkflowReadiness,
    retainIfIngestionWorkerActive: true,
    shutdownOrder: 6,
  },
] as const satisfies readonly RuntimeAdapterDefinition[];

const runtimeAdapterLifecycle = createRuntimeAdapterLifecycle(RUNTIME_ADAPTERS);

export function registerRuntimeAdapters(): void {
  runtimeAdapterLifecycle.register();
}

export function unregisterRuntimeAdapters(input: { ingestionWorkerStopped: boolean }): void {
  runtimeAdapterLifecycle.unregister(input);
}
