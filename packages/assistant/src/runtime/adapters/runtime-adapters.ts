import {
  registerChatAttachmentEnrichmentScheduler,
  unregisterChatAttachmentEnrichmentScheduler,
} from "./chat-attachment-enrichment-adapter";
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
import {
  registerSystemToolProductAdapters,
  unregisterSystemToolProductAdapters,
} from "./system-tool-product";
import { registerSystemToolAgent, unregisterSystemToolAgent } from "./system-tool-agent";
import { registerSystemToolChat, unregisterSystemToolChat } from "./system-tool-chat";
import {
  registerSystemToolWorkflows,
  unregisterSystemToolWorkflows,
} from "./system-tool-workflows";

export interface RuntimeAdapterDefinition {
  name: string;
  register(): void;
  unregister(): void;
  retainIfAgentWorkerActive: boolean;
  retainIfIngestionWorkerActive: boolean;
  shutdownOrder: number;
}

interface RuntimeAdapterLifecycle {
  register(): void;
  unregister(input: { agentWorkerStopped: boolean; ingestionWorkerStopped: boolean }): void;
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
    unregister({ agentWorkerStopped, ingestionWorkerStopped }) {
      for (const adapter of shutdownAdapters) {
        if (!agentWorkerStopped && adapter.retainIfAgentWorkerActive) continue;
        if (!ingestionWorkerStopped && adapter.retainIfIngestionWorkerActive) continue;
        adapter.unregister();
      }
    },
  };
}

export const RUNTIME_ADAPTERS = [
  {
    name: "system-tool-agent",
    register: registerSystemToolAgent,
    unregister: unregisterSystemToolAgent,
    retainIfAgentWorkerActive: true,
    retainIfIngestionWorkerActive: false,
    shutdownOrder: 12,
  },
  {
    name: "system-tool-chat",
    register: registerSystemToolChat,
    unregister: unregisterSystemToolChat,
    retainIfAgentWorkerActive: true,
    retainIfIngestionWorkerActive: false,
    shutdownOrder: 11,
  },
  {
    name: "system-tool-workflows",
    register: registerSystemToolWorkflows,
    unregister: unregisterSystemToolWorkflows,
    retainIfAgentWorkerActive: true,
    retainIfIngestionWorkerActive: false,
    shutdownOrder: 10,
  },
  {
    name: "system-tool-product",
    register: registerSystemToolProductAdapters,
    unregister: unregisterSystemToolProductAdapters,
    retainIfAgentWorkerActive: true,
    retainIfIngestionWorkerActive: false,
    shutdownOrder: 9,
  },
  {
    name: "chat-attachment-enrichment",
    register: registerChatAttachmentEnrichmentScheduler,
    unregister: unregisterChatAttachmentEnrichmentScheduler,
    retainIfAgentWorkerActive: false,
    retainIfIngestionWorkerActive: true,
    shutdownOrder: 8,
  },
  {
    name: "chat-media",
    register: registerChatMedia,
    unregister: unregisterChatMedia,
    retainIfAgentWorkerActive: false,
    retainIfIngestionWorkerActive: true,
    shutdownOrder: 1,
  },
  {
    name: "gmail-triage",
    register: registerGmailTriage,
    unregister: unregisterGmailTriage,
    retainIfAgentWorkerActive: false,
    retainIfIngestionWorkerActive: true,
    shutdownOrder: 2,
  },
  {
    name: "gmail-user-model",
    register: registerGmailUserModel,
    unregister: unregisterGmailUserModel,
    retainIfAgentWorkerActive: false,
    retainIfIngestionWorkerActive: true,
    shutdownOrder: 3,
  },
  {
    name: "google-credential-lifecycle",
    register: registerGoogleCredentialLifecycle,
    unregister: unregisterGoogleCredentialLifecycle,
    retainIfAgentWorkerActive: false,
    retainIfIngestionWorkerActive: false,
    shutdownOrder: 4,
  },
  {
    name: "replicache-poke-adapter",
    register: registerReplicachePokeAdapter,
    unregister: unregisterReplicachePokeAdapter,
    retainIfAgentWorkerActive: false,
    retainIfIngestionWorkerActive: false,
    shutdownOrder: 7,
  },
  {
    name: "trigger-consumers",
    register: registerTriggerConsumers,
    unregister: unregisterTriggerConsumers,
    retainIfAgentWorkerActive: false,
    retainIfIngestionWorkerActive: true,
    shutdownOrder: 0,
  },
  {
    name: "workflow-recovery",
    register: registerWorkflowRecovery,
    unregister: unregisterWorkflowRecovery,
    retainIfAgentWorkerActive: false,
    retainIfIngestionWorkerActive: false,
    shutdownOrder: 5,
  },
  {
    name: "workflow-readiness",
    register: registerWorkflowReadiness,
    unregister: unregisterWorkflowReadiness,
    retainIfAgentWorkerActive: false,
    retainIfIngestionWorkerActive: true,
    shutdownOrder: 6,
  },
] as const satisfies readonly RuntimeAdapterDefinition[];

const runtimeAdapterLifecycle = createRuntimeAdapterLifecycle(RUNTIME_ADAPTERS);

export function registerRuntimeAdapters(): void {
  runtimeAdapterLifecycle.register();
}

export function unregisterRuntimeAdapters(input: {
  agentWorkerStopped: boolean;
  ingestionWorkerStopped: boolean;
}): void {
  runtimeAdapterLifecycle.unregister(input);
}
