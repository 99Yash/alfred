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

export type {
  MutatorFollowUp,
  MutatorResult,
  RegisteredServerMutator,
  ServerMutatorCtx,
} from "./mutator";

/**
 * The push registry, one domain file per executor.
 *
 * Each entry pairs its arg schema with its runner under ONE generic `A` (see
 * `RegisteredServerMutator`). The annotation below is load-bearing twice:
 *
 * 1. Assignment checks every entry against its registered schema — an
 *    executor whose declared args drift from its schema's output, a missing
 *    implementation, or an orphaned name are compile errors here, not silent
 *    runtime drops in `push.ts`.
 * 2. Because the target is a mapped template over `MutatorName`, indexing the
 *    registry by one generic name keeps schema and runner correlated (same
 *    `A`), which is what lets push dispatch without casts.
 *
 * KEEP THIS A SHORTHAND-PROPERTY LITERAL over the named imports above.
 * `packages/http/test/type/replicache-mutator-executor.type-test.ts` reads
 * `Parameters<typeof serverMutators.prefSet["run"]>[0]` and requires
 * `DbTransaction`; the mapped template fixes that parameter for every entry,
 * so the pin holds.
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
  // Both policy flips must also bust the dispatcher's in-process policy cache
  // after commit: `row_version` bumps reach browsers via pull, but the gate
  // runs server-side (ADR-0034 amendment).
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
  // Deleting a thread cascades its rows in-transaction, but attachment objects
  // in the bucket aren't reachable by FK — reap them by key prefix post-commit.
  chatThreadDelete: {
    args: chatThreadDeleteArgsSchema,
    run: chatThreadDelete,
    followUp: (_userId, args) => [{ kind: "cleanChatStorage", threadId: args.id }],
  },
  // The DB tag commits in-transaction; the Gmail label reconciles after commit
  // via the relabel job (rfc-triage-tags.md).
  triageTagOverride: {
    args: triageTagOverrideArgsSchema,
    run: triageTagOverride,
    followUp: (_userId, args) => [{ kind: "relabelThread", sourceThreadId: args.threadId }],
  },
};
