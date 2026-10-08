import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { SupportPage } from "./-legal/support-page";

/** Public `/support`, the Support URL on marketplace listings, so no auth. */
export const Route = createFileRoute("/support")({
  staticData: { publicRoute: true },
  head: () => pageMeta({ title: "Support", path: "/support" }),
  component: SupportPage,
});
