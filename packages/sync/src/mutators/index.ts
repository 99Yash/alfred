import { noteCreateArgsSchema, noteCreateClient } from "./notes";
import {
  factConfirmArgsSchema,
  factConfirmClient,
  factEditArgsSchema,
  factEditClient,
  factRejectArgsSchema,
  factRejectClient,
} from "./facts";

export * from "./notes";
export * from "./facts";

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
};
