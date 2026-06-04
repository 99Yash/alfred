import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReplicacheProvider } from "./lib/replicache/context";
import { routeTree } from "./routeTree.gen";
import "./index.css";

const queryClient = new QueryClient();

const router = createRouter({
  routeTree,
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Drop the static SEO/social baseline from index.html now that the app owns the
// head via <HeadContent />. The baseline exists only for no-JS crawlers; React
// 19 does not dedupe metadata, so leaving these in place would double every
// title/description/og tag. Removing them before the first render keeps exactly
// one set of router-managed tags in the DOM.
for (const el of document.querySelectorAll("[data-seo-baseline]")) el.remove();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ReplicacheProvider>
        <RouterProvider router={router} />
      </ReplicacheProvider>
    </QueryClientProvider>
  </StrictMode>,
);

scheduleObservabilityInit();

function scheduleObservabilityInit() {
  const load = () =>
    void import("./lib/observability")
      .then(({ initObservability }) => {
        initObservability();
      })
      .catch(() => {});

  const requestIdle = window.requestIdleCallback;
  if (typeof requestIdle === "function") {
    requestIdle(load, { timeout: 2_000 });
    return;
  }
  globalThis.setTimeout(load, 1_000);
}
