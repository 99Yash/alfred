import type { MutatorName } from "@alfred/sync";
import {
  chatAttachmentCreate,
  chatMessageCreate,
  chatThreadCreate,
  chatThreadDelete,
  chatThreadRename,
  chatThreadSetPinned,
} from "./chat";
import { factConfirm, factCreate, factEdit, factReject } from "./facts";
import type { ServerMutator } from "./mutator";
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

export type { ServerMutatorCtx } from "./mutator";

/**
 * The push registry, one file per domain.
 *
 * `satisfies Record<MutatorName, ServerMutator>` is the module interface: a
 * client mutator with no server implementation is a compile error here, not a
 * silent runtime drop in `push.ts`. This is the only place the check runs.
 *
 * KEEP THIS A SHORTHAND-PROPERTY LITERAL over the named declarations above.
 * `packages/http/test/type/replicache-mutator-executor.type-test.ts` reads
 * `Parameters<typeof serverMutators.prefSet>[0]` and requires `DbTransaction`; a
 * wrapper, a cast or an `as const` would break that pin. ADR-0061:21 records the
 * `as const` this literal already replaced — do not regress it.
 */
export const serverMutators = {
  noteCreate,
  factConfirm,
  factCreate,
  factReject,
  factEdit,
  prefSet,
  prefDelete,
  policySetIntegrationMode,
  policySetDefaultMode,
  workflowUpdate,
  todoCreate,
  todoComplete,
  todoCompleteSuggestion,
  todoReopen,
  todoPromote,
  todoDismiss,
  todoClear,
  todoEdit,
  chatThreadCreate,
  chatMessageCreate,
  chatAttachmentCreate,
  chatThreadRename,
  chatThreadSetPinned,
  chatThreadDelete,
  triageTagOverride,
} satisfies Record<MutatorName, ServerMutator>;
