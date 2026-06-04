import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { PreviewMemoryPage } from "./-preview-memory/preview-memory-page";

/**
 * Visitors-now-grammar port of /memory.
 *
 * Two sections (Proposed / Confirmed) over fixture facts. Replicache
 * subscribe + factConfirm/Reject/Edit are stubbed — actions mutate
 * local state so the page can be reviewed in isolation. The toast
 * stack from the dimension version is dropped (no event bridge to
 * subscribe to in preview).
 */
export const Route = createFileRoute("/memory")({
  head: () => pageMeta({ title: "Memory" }),
  component: PreviewMemoryPage,
});
