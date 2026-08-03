import { withDefaults } from "@alfred/contracts";
import { isDuplicateRunIndex } from "@alfred/db/schemas";
import { uniqueViolationConstraint } from "../lib/pg-errors";
import { createRun, enqueueRun } from "../modules/agent";
import { COLD_START_WORKFLOW_SLUG } from "../modules/cold-start";
import {
  registerGoogleColdStartResearchHandler,
  type GoogleColdStartResearchHandler,
} from "../modules/integrations";

interface GoogleColdStartResearchAdapterDeps {
  createRun: typeof createRun;
  enqueueRun: typeof enqueueRun;
  isDuplicate(error: unknown): boolean;
}

const DEFAULT_DEPS: GoogleColdStartResearchAdapterDeps = {
  createRun,
  enqueueRun,
  isDuplicate(error) {
    return isDuplicateRunIndex(uniqueViolationConstraint(error));
  },
};

/** Build the Google callback adapter. Overrides are an internal test seam. */
export function createGoogleColdStartResearchHandler(
  overrides: Partial<GoogleColdStartResearchAdapterDeps> = {},
): GoogleColdStartResearchHandler {
  const deps = withDefaults(DEFAULT_DEPS, overrides);

  return async (request) => {
    try {
      // The workflow's constant dedup key enforces one eligible research run
      // per user. Its event identity separately blocks concurrent callbacks
      // for the same credential. Either relevant index can win the race; the
      // shared classifier accepts both and rejects unrelated unique failures.
      const eventId = `google.callback:${request.credentialId}`;
      const { runId } = await deps.createRun({
        userId: request.userId,
        workflowSlug: COLD_START_WORKFLOW_SLUG,
        input: { reason: "signup" },
        trigger: {
          kind: "event",
          source: "google.oauth.callback",
          type: "completed",
          eventId,
        },
        workflowRevisionId: null,
        occurrence: {
          kind: "event",
          workflowId: COLD_START_WORKFLOW_SLUG,
          provider: "google.oauth.callback",
          eventId,
        },
      });
      await deps.enqueueRun(runId);
      return { status: "enqueued" };
    } catch (error) {
      if (deps.isDuplicate(error)) return { status: "duplicate" };
      throw error;
    }
  };
}

let unregisterGoogleColdStartResearchHandler: (() => void) | undefined;

export function registerGoogleColdStartResearch(): void {
  if (unregisterGoogleColdStartResearchHandler) return;
  unregisterGoogleColdStartResearchHandler = registerGoogleColdStartResearchHandler(
    createGoogleColdStartResearchHandler(),
  );
}

export function unregisterGoogleColdStartResearch(): void {
  unregisterGoogleColdStartResearchHandler?.();
  unregisterGoogleColdStartResearchHandler = undefined;
}
