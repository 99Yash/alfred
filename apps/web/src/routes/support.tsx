import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { SupportPage } from "./-legal/support-page";

/**
 * Public support page — `/support`. Linked as the Support URL on Alfred's
 * marketplace listings (e.g. the Vercel integration), so it must be reachable
 * without authentication. Renders chromeless via its own `staticData: {
 * publicRoute: true }`. Mirrors the legal pages' standalone dark canvas.
 */
export const Route = createFileRoute("/support")({
  staticData: { publicRoute: true },
  head: () => pageMeta({ title: "Support", path: "/support" }),
  component: SupportPage,
});
