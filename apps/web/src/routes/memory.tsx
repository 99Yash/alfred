import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { MemoryPage } from "./-memory/memory-page";

/** Production memory review over Replicache-synced proposed and confirmed facts. */
export const Route = createFileRoute("/memory")({
  head: () => pageMeta({ title: "Memory", path: "/memory" }),
  component: MemoryPage,
});
