import { createFileRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";

const PreviewVirtuosoRoute = import.meta.env.DEV
  ? lazyRouteComponent(
      () => import("./-preview-virtuoso/preview-virtuoso-page"),
      "PreviewVirtuosoPage",
    )
  : () => null;

/** Dev-only harness for the virtualized chat feed (`?count=500`). Production-gated. */
export const Route = createFileRoute("/preview/virtuoso")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: PreviewVirtuosoRoute,
});
