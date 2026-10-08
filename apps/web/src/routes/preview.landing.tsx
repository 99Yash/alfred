import { createFileRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";

const PreviewLandingPage = import.meta.env.DEV
  ? lazyRouteComponent(
      () => import("./-preview-landing/preview-landing-page"),
      "PreviewLandingPage",
    )
  : () => null;

/** The logged-out landing at /preview/landing, whatever the auth state. */
export const Route = createFileRoute("/preview/landing")({
  staticData: { publicRoute: true },
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: PreviewLandingPage,
});
