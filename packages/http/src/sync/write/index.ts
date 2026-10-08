import type { z } from "zod";
import {
  chatAttachmentCreateArgsSchema,
  chatMessageCreateArgsSchema,
  chatThreadCreateArgsSchema,
  chatThreadDeleteArgsSchema,
  chatThreadRenameArgsSchema,
  chatThreadSetPinnedArgsSchema,
  factConfirmArgsSchema,
  factCreateArgsSchema,
  factEditArgsSchema,
  factRejectArgsSchema,
  mutatorArgsSchemas,
  noteCreateArgsSchema,
  policySetDefaultModeArgsSchema,
  policySetIntegrationModeArgsSchema,
  prefDeleteArgsSchema,
  prefSetArgsSchema,
  todoClearArgsSchema,
  todoCompleteArgsSchema,
  todoCompleteSuggestionArgsSchema,
  todoCreateArgsSchema,
  todoDismissArgsSchema,
  todoEditArgsSchema,
  todoPromoteArgsSchema,
  todoReopenArgsSchema,
  triageTagOverrideArgsSchema,
  workflowUpdateArgsSchema,
  type MutatorName,
} from "@alfred/sync";
import {
  chatAttachmentCreate,
  chatMessageCreate,
  chatThreadCreate,
  chatThreadDelete,
  chatThreadRename,
  chatThreadSetPinned,
} from "./chat";
import { factConfirm, factCreate, factEdit, factReject } from "./facts";
import type { RegisteredServerMutator } from "./mutator";
import { noteCreate } from "./notes";
import { policySetDefaultMode, policySetIntegrationMode } from "./action-policies";
import { prefDelete, prefSet } from "./preferences";
import {
  todoClear,
  todoComplete,
  todoCompleteSuggestion,
  todoCreate,
  todoDismiss,
  todoEdit,
  todoPromote,
  todoReopen,
} from "./todos";
import { triageTagOverride } from "./triage-tags";
import { workflowUpdate } from "./workflows";

export type { MutatorFollowUp, MutatorResult, RegisteredServerMutator } from "./mutator";

/**
 * The push registry. The mapped type makes a missing, extra or drifted mutator a
 * compile error, and keeps schema and runner correlated so push needs no cast.
 */
export type ServerMutatorsRegistry = {
  [N in MutatorName]: RegisteredServerMutator<z.output<(typeof mutatorArgsSchemas)[N]>>;
};

export const serverMutators: ServerMutatorsRegistry = {
  noteCreate: { args: noteCreateArgsSchema, run: noteCreate },
  factConfirm: { args: factConfirmArgsSchema, run: factConfirm },
  factCreate: { args: factCreateArgsSchema, run: factCreate },
  factReject: { args: factRejectArgsSchema, run: factReject },
  factEdit: { args: factEditArgsSchema, run: factEdit },
  prefSet: { args: prefSetArgsSchema, run: prefSet },
  prefDelete: { args: prefDeleteArgsSchema, run: prefDelete },
  // The policy gate runs server-side, so a pull alone does not refresh it (ADR-0034 amendment).
  policySetIntegrationMode: {
    args: policySetIntegrationModeArgsSchema,
    run: policySetIntegrationMode,
    followUp: () => [{ kind: "bustPolicyCache" }],
  },
  policySetDefaultMode: {
    args: policySetDefaultModeArgsSchema,
    run: policySetDefaultMode,
    followUp: () => [{ kind: "bustPolicyCache" }],
  },
  workflowUpdate: { args: workflowUpdateArgsSchema, run: workflowUpdate },
  todoCreate: { args: todoCreateArgsSchema, run: todoCreate },
  todoComplete: { args: todoCompleteArgsSchema, run: todoComplete },
  todoCompleteSuggestion: {
    args: todoCompleteSuggestionArgsSchema,
    run: todoCompleteSuggestion,
  },
  todoReopen: { args: todoReopenArgsSchema, run: todoReopen },
  todoPromote: { args: todoPromoteArgsSchema, run: todoPromote },
  todoDismiss: { args: todoDismissArgsSchema, run: todoDismiss },
  todoClear: { args: todoClearArgsSchema, run: todoClear },
  todoEdit: { args: todoEditArgsSchema, run: todoEdit },
  chatThreadCreate: { args: chatThreadCreateArgsSchema, run: chatThreadCreate },
  chatMessageCreate: { args: chatMessageCreateArgsSchema, run: chatMessageCreate },
  chatAttachmentCreate: {
    args: chatAttachmentCreateArgsSchema,
    run: chatAttachmentCreate,
  },
  chatThreadRename: { args: chatThreadRenameArgsSchema, run: chatThreadRename },
  chatThreadSetPinned: {
    args: chatThreadSetPinnedArgsSchema,
    run: chatThreadSetPinned,
  },
  // Bucket objects have no FK cascade, so delete them by key prefix after commit.
  chatThreadDelete: {
    args: chatThreadDeleteArgsSchema,
    run: chatThreadDelete,
    followUp: (_userId, args) => [{ kind: "cleanChatStorage", threadId: args.id }],
  },
  triageTagOverride: {
    args: triageTagOverrideArgsSchema,
    run: triageTagOverride,
    followUp: (_userId, args) => [{ kind: "relabelThread", sourceThreadId: args.threadId }],
  },
};
