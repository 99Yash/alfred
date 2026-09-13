import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { SharedThreadPage } from "./-chat/shared-thread-page";

/**
 * Public shared-thread page — `/c/$slug` (ADR-0102).
 *
 * The only unauthenticated data surface in the app. It deliberately sits at the
 * short `/c/` prefix rather than under `/chat/`, so a published URL is never one
 * typo away from a private thread route and the two are trivially told apart in
 * logs and in a link preview.
 *
 * The `head` carries no thread title. Titles are user-authored and can quote
 * private context, and route `head` output is what a link preview scrapes — so
 * the tab and the preview stay generic, and the title only renders inside the
 * page once the snapshot has actually loaded.
 */
export const Route = createFileRoute("/c/$slug")({
  head: () =>
    pageMeta({
      title: "Shared thread",
      description: "A conversation shared from Alfred.",
    }),
  component: SharedThreadRoute,
});

function SharedThreadRoute() {
  const { slug } = Route.useParams();

  return <SharedThreadPage urlSlug={slug} />;
}
