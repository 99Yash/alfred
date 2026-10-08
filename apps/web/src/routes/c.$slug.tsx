import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { SharedThreadPage } from "./-chat/shared-thread-page";

/**
 * Public shared thread at `/c/$slug` (ADR-0102), the only unauthenticated data page.
 * `/c/`, not `/chat/`, so a typo never reaches a private route.
 * `head` has no title: titles can quote private context, and link previews read `head`.
 * `noindex`, because the 80-bit slug is the only access control. robots.txt and
 * the Caddyfile's `X-Robots-Tag` say the same for crawlers that skip this code.
 */
export const Route = createFileRoute("/c/$slug")({
  staticData: { publicRoute: true },
  head: () =>
    pageMeta({
      title: "Shared thread",
      description: "A conversation shared from Alfred.",
      noindex: true,
    }),
  component: SharedThreadRoute,
});

function SharedThreadRoute() {
  const { slug } = Route.useParams();

  return <SharedThreadPage urlSlug={slug} />;
}
