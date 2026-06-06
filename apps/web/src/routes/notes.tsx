import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { PreviewNotesPage } from "./-preview-notes/preview-notes-page";

/**
 * App-grammar port of /notes.
 *
 * Composer at the top + reverse-chronological list. Replicache wiring is
 * intentionally stubbed — notes live in component state so the page can
 * be reviewed in isolation. The Save button + Enter-to-save both push
 * into the local list.
 */
export const Route = createFileRoute("/notes")({
  head: () => pageMeta({ title: "Notes", path: "/notes" }),
  component: PreviewNotesPage,
});
