import { createFileRoute } from "@tanstack/react-router";
import { PreviewApprovalsPage } from "./-preview-approvals/preview-approvals-page";

/**
 * Visitors-now-grammar port of /approvals.
 *
 * The dimension version subscribes to a Replicache prefix and posts
 * decisions back through Eden. This preview lives on fixture data so
 * the gating UX can be reviewed end-to-end (input JSON editor, reason
 * box, 4 decision buttons) without the auth/eden plumbing. Buttons are
 * stateful no-ops that remove the card from the local list.
 *
 * The card body, tool icon, risk pill, and JSON preview each live in
 * their own modules under components/preview/approvals — keeps each
 * file focused on a single component for fast-refresh and review.
 */
export const Route = createFileRoute("/preview/approvals")({
  component: PreviewApprovalsPage,
});
