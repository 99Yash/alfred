import { Elysia, t } from "elysia";
import { authMacro } from "./middleware/auth";
import {
  stagedAction,
  type StagedActionDecision,
  type StagedActionRefusal,
} from "@alfred/assistant/execution";
import { Errors, jsonValueSchema, type JsonValue } from "@alfred/contracts";
import { prepareStagedApproval } from "@alfred/assistant/automation";
import { requireOnboarded } from "./middleware/onboarding";

type Decision = StagedActionDecision["decision"];

/** Records a decision on an `action_stagings` row, then wakes or cancels the parked run. */
export const approvalsRoutes = new Elysia({ prefix: "/api/approvals", normalize: "typebox" })
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app.post(
      "/:stagingId/decision",
      async ({ params, body, user }) => {
        const reason = body.reason?.trim();

        const editedInput =
          body.editedInput === undefined ? undefined : jsonValueSchema.parse(body.editedInput);

        const { expectedRowVersion } = body;
        const action = stagedAction({ userId: user.id, stagingId: params.stagingId });

        const outcome = await action.decide(
          await toStagedActionDecision({
            decision: body.decision,
            reason,
            editedInput,
            expectedRowVersion,
            userId: user.id,
            stagingId: params.stagingId,
          }),
        );

        if (outcome.kind === "refused") throw refusalError(outcome.reason);

        if (outcome.kind === "invalid") throw Errors.BadRequestError(outcome.message);

        // A refreshed contract keeps the card pending, and the owner approves it again.
        if (outcome.kind === "restaged") {
          return { status: "restaged" as const, runId: outcome.runId };
        }

        return { status: outcome.status, runId: outcome.runId, enqueued: outcome.enqueued };
      },
      {
        params: t.Object({ stagingId: t.String({ minLength: 1, maxLength: 120 }) }),
        body: t.Object({
          // `t.UnionEnum` defaults to its first member, so a missing decision would become "approve".
          decision: t.UnionEnum(
            ["approve", "reject", "cancel_run"] as const satisfies readonly Decision[],
            { default: undefined },
          ),
          expectedRowVersion: t.Integer({ minimum: 1 }),
          editedInput: t.Optional(t.Unknown()),
          reason: t.Optional(t.String({ maxLength: 2_000 })),
        }),
      },
    ),
  );

/** The checks that need no row lock. The plain-reject reason check needs the row, so it is in `decide`. */
async function toStagedActionDecision(args: {
  decision: Decision;
  reason: string | undefined;
  editedInput: JsonValue | undefined;
  expectedRowVersion: number;
  userId: string;
  stagingId: string;
}): Promise<StagedActionDecision> {
  const { decision, reason, expectedRowVersion } = args;

  if (decision === "cancel_run") {
    if (!reason) throw Errors.BadRequestError("Rejecting an action requires a reason");

    return { decision, expectedRowVersion, reason };
  }

  if (decision === "reject") return { decision, expectedRowVersion, reason };

  const prepared = await prepareStagedApproval({
    userId: args.userId,
    stagingId: args.stagingId,
    expectedRowVersion,
    editedInput: args.editedInput,
  });

  if (prepared.kind === "invalid") throw Errors.BadRequestError(prepared.message);

  return { decision, expectedRowVersion, approval: prepared.approval };
}

/** `not_found` is a 404. Every other refusal is a 409 conflict with the card's current state. */
function refusalError(reason: StagedActionRefusal): Error {
  switch (reason.refusal) {
    case "not_found":
      return Errors.NotFoundError("Approval not found");
    case "not_gated":
      return Errors.ConflictError("Action does not require approval");
    case "already_decided":
      return Errors.ConflictError(`Action is already ${reason.status}`);
    case "stale_version":
      return Errors.ConflictError("The approval changed. Review the latest contract.");
    case "run_unavailable":
      return Errors.ConflictError(runUnavailableMessage(reason.run));
  }
}

function runUnavailableMessage(
  run: Extract<StagedActionRefusal, { refusal: "run_unavailable" }>["run"],
): string {
  switch (run) {
    case "not_found":
      return "Run not found";
    case "not_waiting":
      return "Run is not waiting for an approval";
    case "wake_mismatch":
      return "Run is not waiting for this approval";
    case "already_terminal":
      return "Run has already finished";
  }
}
