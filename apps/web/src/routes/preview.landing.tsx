import { createFileRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";

const PreviewLandingPage = import.meta.env.DEV
  ? lazyRouteComponent(
      () => import("./-preview-landing/preview-landing-page"),
      "PreviewLandingPage",
    )
  : () => null;

/**
 * Preview of the logged-out marketing landing — accessible at /preview/landing
 * regardless of auth state. Handy for iterating on the Dimension-grammar
 * primitives in components/landing/* without signing out.
 */
export const Route = createFileRoute("/preview/landing")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: PreviewLandingPage,
});
