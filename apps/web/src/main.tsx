import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReplicacheProvider } from "./lib/replicache/context";
import { routeTree } from "./routeTree.gen";
import "./index.css";

// Sentry (incl. the rrweb session-replay recorder) and PostHog are ~200KB gzip
// of analytics that nothing needs before first paint. Dynamically import and
// init them once the browser is idle so they leave the entry chunk and never
// block the initial render.
function deferObservability() {
  void import("./lib/observability").then((m) => m.initObservability());
}
if (typeof requestIdleCallback === "function") {
  requestIdleCallback(deferObservability);
} else {
  setTimeout(deferObservability, 1);
}

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
