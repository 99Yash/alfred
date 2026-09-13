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
 *
 * It also carries `noindex`. Every other route in this app is either marketing
 * (index it) or behind auth (a crawler sees an empty shell), so the crawl rules
 * have never had to think about a third case. This is it: real conversation
 * text, no session, and a URL that is the whole access control. An indexed page
 * removes the need to guess an 80-bit slug. `robots.txt` and the Caddyfile's
 * `X-Robots-Tag` state the same rule for a crawler that never runs this code.
 */
export const Route = createFileRoute("/c/$slug")({
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
