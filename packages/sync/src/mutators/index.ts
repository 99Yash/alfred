import { noteCreateArgsSchema, noteCreateClient } from "./notes";
import {
  factConfirmArgsSchema,
  factConfirmClient,
  factCreateArgsSchema,
  factCreateClient,
  factEditArgsSchema,
  factEditClient,
  factRejectArgsSchema,
  factRejectClient,
} from "./facts";
import { prefDeleteArgsSchema, prefDeleteClient, prefSetArgsSchema, prefSetClient } from "./prefs";
import {
  policySetDefaultModeArgsSchema,
  policySetDefaultModeClient,
  policySetIntegrationModeArgsSchema,
  policySetIntegrationModeClient,
} from "./policy";
import { workflowUpdateArgsSchema, workflowUpdateClient } from "./workflows";
import {
  todoCompleteArgsSchema,
  todoCompleteClient,
  todoCreateArgsSchema,
  todoCreateClient,
  todoDismissArgsSchema,
  todoDismissClient,
  todoEditArgsSchema,
  todoEditClient,
  todoPromoteArgsSchema,
  todoPromoteClient,
  todoReopenArgsSchema,
  todoReopenClient,
} from "./todos";
import {
  chatMessageCreateArgsSchema,
  chatMessageCreateClient,
  chatThreadCreateArgsSchema,
  chatThreadCreateClient,
  chatThreadDeleteArgsSchema,
  chatThreadDeleteClient,
  chatThreadRenameArgsSchema,
  chatThreadRenameClient,
  chatThreadSetPinnedArgsSchema,
  chatThreadSetPinnedClient,
} from "./chat";
import { triageTagOverrideArgsSchema, triageTagOverrideClient } from "./triage-tags";

export * from "./notes";
export * from "./facts";
export * from "./prefs";
export * from "./policy";
export * from "./workflows";
export * from "./todos";
export * from "./chat";
export * from "./triage-tags";

/**
 * Client-side mutator bodies, keyed by the name Replicache uses to dispatch
 * push mutations. The server has a parallel map (different signatures, SQL
 * instead of k/v) identified by the same names.
 */
export const clientMutators = {
  noteCreate: noteCreateClient,
  factConfirm: factConfirmClient,
  factReject: factRejectClient,
  factCreate: factCreateClient,
  factEdit: factEditClient,
  prefSet: prefSetClient,
  prefDelete: prefDeleteClient,
  policySetIntegrationMode: policySetIntegrationModeClient,
  policySetDefaultMode: policySetDefaultModeClient,
  workflowUpdate: workflowUpdateClient,
  todoCreate: todoCreateClient,
  todoComplete: todoCompleteClient,
  todoReopen: todoReopenClient,
  todoPromote: todoPromoteClient,
  todoDismiss: todoDismissClient,
  todoEdit: todoEditClient,
  chatThreadCreate: chatThreadCreateClient,
  chatMessageCreate: chatMessageCreateClient,
  chatThreadRename: chatThreadRenameClient,
  chatThreadSetPinned: chatThreadSetPinnedClient,
  chatThreadDelete: chatThreadDeleteClient,
  triageTagOverride: triageTagOverrideClient,
};

export type ClientMutators = typeof clientMutators;
export type MutatorName = keyof ClientMutators;

/**
 * Arg schemas indexed by mutator name. The server validates push payloads
 * against these before dispatching.
 */
export const mutatorArgsSchemas = {
  noteCreate: noteCreateArgsSchema,
  factConfirm: factConfirmArgsSchema,
  factReject: factRejectArgsSchema,
  factCreate: factCreateArgsSchema,
  factEdit: factEditArgsSchema,
  prefSet: prefSetArgsSchema,
  prefDelete: prefDeleteArgsSchema,
  policySetIntegrationMode: policySetIntegrationModeArgsSchema,
  policySetDefaultMode: policySetDefaultModeArgsSchema,
  workflowUpdate: workflowUpdateArgsSchema,
  todoCreate: todoCreateArgsSchema,
  todoComplete: todoCompleteArgsSchema,
  todoReopen: todoReopenArgsSchema,
  todoPromote: todoPromoteArgsSchema,
  todoDismiss: todoDismissArgsSchema,
  todoEdit: todoEditArgsSchema,
  chatThreadCreate: chatThreadCreateArgsSchema,
  chatMessageCreate: chatMessageCreateArgsSchema,
  chatThreadRename: chatThreadRenameArgsSchema,
  chatThreadSetPinned: chatThreadSetPinnedArgsSchema,
  chatThreadDelete: chatThreadDeleteArgsSchema,
  triageTagOverride: triageTagOverrideArgsSchema,
};
