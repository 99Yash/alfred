import { createFileRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";

const PreviewVirtuosoRoute = import.meta.env.DEV
  ? lazyRouteComponent(
      () => import("./-preview-virtuoso/preview-virtuoso-page"),
      "PreviewVirtuosoPage",
    )
  : () => null;

/**
 * Dev-only verification harness for the virtualized chat feed (issue #496) at
 * `/preview/virtuoso`. Feeds a synthetic long thread (`?count=500`) and a
 * simulated stream into the production `Conversation`. Production-gated.
 */
export const Route = createFileRoute("/preview/virtuoso")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: PreviewVirtuosoRoute,
});
