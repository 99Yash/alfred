import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { IntegrationsRoute } from "./-integrations/integrations-route";

/** The integrations catalog: a hero of connected logos above the category rows. */
export const Route = createFileRoute("/integrations")({
  head: () => pageMeta({ title: "Integrations", path: "/integrations" }),
  component: IntegrationsRoute,
});
