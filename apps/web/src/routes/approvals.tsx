import { createFileRoute } from "@tanstack/react-router";
import { ApprovalsPage } from "~/components/approvals/approvals-page";

/**
 * Live `/approvals` surface. Subscribes to pending `action_stagings` via
 * Replicache and posts approve / reject / cancel decisions through the Eden
 * decision API (`POST /api/approvals/:stagingId/decision`).
 *
 * The fixture-driven design reference still lives at
 * `routes/-preview-approvals` for visual iteration without the auth/sync
 * plumbing.
 */
export const Route = createFileRoute("/approvals")({
  component: ApprovalsPage,
});
