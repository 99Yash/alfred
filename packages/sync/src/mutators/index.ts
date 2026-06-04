import { noteCreateArgsSchema, noteCreateClient } from "./notes";
import {
  factConfirmArgsSchema,
  factConfirmClient,
  factEditArgsSchema,
  factEditClient,
  factRejectArgsSchema,
  factRejectClient,
} from "./facts";
import { prefDeleteArgsSchema, prefDeleteClient, prefSetArgsSchema, prefSetClient } from "./prefs";
import { policySetIntegrationModeArgsSchema, policySetIntegrationModeClient } from "./policy";
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

export * from "./notes";
export * from "./facts";
export * from "./prefs";
export * from "./policy";
export * from "./workflows";
export * from "./todos";

/**
 * Client-side mutator bodies, keyed by the name Replicache uses to dispatch
 * push mutations. The server has a parallel map (different signatures, SQL
 * instead of k/v) identified by the same names.
 */
export const clientMutators = {
  noteCreate: noteCreateClient,
  factConfirm: factConfirmClient,
  factReject: factRejectClient,
  factEdit: factEditClient,
  prefSet: prefSetClient,
  prefDelete: prefDeleteClient,
  policySetIntegrationMode: policySetIntegrationModeClient,
  workflowUpdate: workflowUpdateClient,
  todoCreate: todoCreateClient,
  todoComplete: todoCompleteClient,
  todoReopen: todoReopenClient,
  todoPromote: todoPromoteClient,
  todoDismiss: todoDismissClient,
  todoEdit: todoEditClient,
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
  factEdit: factEditArgsSchema,
  prefSet: prefSetArgsSchema,
  prefDelete: prefDeleteArgsSchema,
  policySetIntegrationMode: policySetIntegrationModeArgsSchema,
  workflowUpdate: workflowUpdateArgsSchema,
  todoCreate: todoCreateArgsSchema,
  todoComplete: todoCompleteArgsSchema,
  todoReopen: todoReopenArgsSchema,
  todoPromote: todoPromoteArgsSchema,
  todoDismiss: todoDismissArgsSchema,
  todoEdit: todoEditArgsSchema,
};
