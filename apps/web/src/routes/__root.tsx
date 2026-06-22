import { createRootRouteWithContext } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { siteMeta } from "~/lib/page-meta";
import { RootLayout } from "./-root/root-layout";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: siteMeta,
  component: RootLayout,
});
