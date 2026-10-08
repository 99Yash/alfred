import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { NotesPage } from "./-notes/notes-page";

/** Notes. They live in component state for now; no sync. */
export const Route = createFileRoute("/notes")({
  head: () => pageMeta({ title: "Notes", path: "/notes" }),
  component: NotesPage,
});
