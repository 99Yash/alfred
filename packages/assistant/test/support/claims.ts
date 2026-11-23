import type { UserClaimProvenance } from "@alfred/contracts";
import { claimColumns } from "../../src/knowledge/facts";

/**
 * The provenance of a user claim in a DB-backed test: a chat turn that the test does not store.
 * `user_facts.evidence` has no foreign key, so the id need not exist (ADR-0123).
 */
export const TEST_USER_CLAIM: UserClaimProvenance = {
  author: "user",
  evidence: [{ kind: "chat_message", id: "msg_test" }],
  producer: { pipeline: "test", runId: null, commit: null, model: null },
};

/** The same provenance as `user_facts` insert columns. */
export const TEST_USER_CLAIM_COLUMNS = claimColumns(TEST_USER_CLAIM);
