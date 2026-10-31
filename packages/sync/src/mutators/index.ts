import type { ZodType } from "zod";
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
  policySetToolModeArgsSchema,
  policySetToolModeClient,
} from "./policy";
import { workflowUpdateArgsSchema, workflowUpdateClient } from "./workflows";
import {
  todoClearArgsSchema,
  todoClearClient,
  todoCompleteArgsSchema,
  todoCompleteClient,
  todoCompleteSuggestionArgsSchema,
  todoCompleteSuggestionClient,
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
  chatAttachmentCreateArgsSchema,
  chatAttachmentCreateClient,
  chatMessageCreateArgsSchema,
  chatMessageCreateClient,
  chatThreadCreateArgsSchema,
  chatThreadCreateClient,
  chatThreadDeleteArgsSchema,
  chatThreadDeleteClient,
  chatThreadRenameArgsSchema,
  chatThreadRenameClient,
  chatThreadSetApprovalModeArgsSchema,
  chatThreadSetApprovalModeClient,
  chatThreadSetPinnedArgsSchema,
  chatThreadSetPinnedClient,
} from "./chat";
import { triageTagOverrideArgsSchema, triageTagOverrideClient } from "./triage-tags";

export { noteCreateArgsSchema, type NoteCreateArgs } from "./notes";

export {
  factConfirmArgsSchema,
  type FactConfirmArgs,
  factRejectArgsSchema,
  type FactRejectArgs,
  factCreateArgsSchema,
  type FactCreateArgs,
  factEditArgsSchema,
  type FactEditArgs,
} from "./facts";

export {
  prefSetArgsSchema,
  type PrefSetArgs,
  prefDeleteArgsSchema,
  type PrefDeleteArgs,
} from "./prefs";

export {
  policySetIntegrationModeArgsSchema,
  type PolicySetIntegrationModeArgs,
  policySetToolModeArgsSchema,
  type PolicySetToolModeArgs,
  policySetDefaultModeArgsSchema,
  type PolicySetDefaultModeArgs,
} from "./policy";

export {
  isLikelyValidWorkflowCron,
  workflowUpdateArgsSchema,
  type WorkflowUpdateArgs,
} from "./workflows";

export {
  todoCreateArgsSchema,
  type TodoCreateArgs,
  todoCompleteArgsSchema,
  type TodoCompleteArgs,
  todoReopenArgsSchema,
  type TodoReopenArgs,
  todoPromoteArgsSchema,
  type TodoPromoteArgs,
  todoDismissArgsSchema,
  type TodoDismissArgs,
  todoClearArgsSchema,
  type TodoClearArgs,
  todoCompleteSuggestionArgsSchema,
  type TodoCompleteSuggestionArgs,
  todoEditArgsSchema,
  type TodoEditArgs,
  todoCompleteClient,
  todoReopenClient,
  todoCompleteSuggestionClient,
  todoPromoteClient,
  todoDismissClient,
  todoClearClient,
} from "./todos";

export {
  chatThreadCreateArgsSchema,
  type ChatThreadCreateArgs,
  chatMessageCreateArgsSchema,
  type ChatMessageCreateArgs,
  chatThreadRenameArgsSchema,
  type ChatThreadRenameArgs,
  chatThreadSetPinnedArgsSchema,
  type ChatThreadSetPinnedArgs,
  chatThreadSetApprovalModeArgsSchema,
  type ChatThreadSetApprovalModeArgs,
  type ChatApprovalMode,
  chatThreadDeleteArgsSchema,
  type ChatThreadDeleteArgs,
  chatAttachmentCreateArgsSchema,
  type ChatAttachmentCreateArgs,
  toSyncedChatAttachment,
  toSyncedUserMessage,
} from "./chat";

export {
  triageTagOverrideArgsSchema,
  type TriageTagOverrideArgs,
  triageTagOverrideClient,
} from "./triage-tags";

/** Client mutators by Replicache name. The server map uses the same names. */
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
  policySetToolMode: policySetToolModeClient,
  workflowUpdate: workflowUpdateClient,
  todoCreate: todoCreateClient,
  todoComplete: todoCompleteClient,
  todoCompleteSuggestion: todoCompleteSuggestionClient,
  todoReopen: todoReopenClient,
  todoPromote: todoPromoteClient,
  todoDismiss: todoDismissClient,
  todoClear: todoClearClient,
  todoEdit: todoEditClient,
  chatThreadCreate: chatThreadCreateClient,
  chatMessageCreate: chatMessageCreateClient,
  chatAttachmentCreate: chatAttachmentCreateClient,
  chatThreadRename: chatThreadRenameClient,
  chatThreadSetPinned: chatThreadSetPinnedClient,
  chatThreadSetApprovalMode: chatThreadSetApprovalModeClient,
  chatThreadDelete: chatThreadDeleteClient,
  triageTagOverride: triageTagOverrideClient,
};

export type ClientMutators = typeof clientMutators;

export type MutatorName = keyof ClientMutators;

/** Push arg schemas. `satisfies` makes a missing, extra, or mismatched schema a compile error. */
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
  policySetToolMode: policySetToolModeArgsSchema,
  workflowUpdate: workflowUpdateArgsSchema,
  todoCreate: todoCreateArgsSchema,
  todoComplete: todoCompleteArgsSchema,
  todoCompleteSuggestion: todoCompleteSuggestionArgsSchema,
  todoReopen: todoReopenArgsSchema,
  todoPromote: todoPromoteArgsSchema,
  todoDismiss: todoDismissArgsSchema,
  todoClear: todoClearArgsSchema,
  todoEdit: todoEditArgsSchema,
  chatThreadCreate: chatThreadCreateArgsSchema,
  chatMessageCreate: chatMessageCreateArgsSchema,
  chatAttachmentCreate: chatAttachmentCreateArgsSchema,
  chatThreadRename: chatThreadRenameArgsSchema,
  chatThreadSetPinned: chatThreadSetPinnedArgsSchema,
  chatThreadSetApprovalMode: chatThreadSetApprovalModeArgsSchema,
  chatThreadDelete: chatThreadDeleteArgsSchema,
  triageTagOverride: triageTagOverrideArgsSchema,
} satisfies {
  [N in MutatorName]: ZodType<Parameters<ClientMutators[N]>[1]>;
};
