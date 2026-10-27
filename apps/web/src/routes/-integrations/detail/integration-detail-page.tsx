import { useRouteContext } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useResolvedIntegration } from "~/lib/integrations/use-integration-status";
import { BackLink } from "./back-link";
import { NotFound } from "./not-found";
import { ProviderDetail } from "./provider-detail";
import { integrationPage } from "~/lib/integrations/integrations";

export function IntegrationDetailPage() {
  // `beforeLoad` proves the slug and throws `notFound()` for any other value.
  const { slug } = useRouteContext({ from: "/integrations/$slug" });
  const provider = useResolvedIntegration(slug) ?? integrationPage(slug);

  return (
    <DetailFrame>
      <ProviderDetail provider={provider} />
    </DetailFrame>
  );
}

/** The route's `notFoundComponent`: an unknown slug keeps the page frame and its back link. */
export function IntegrationNotFoundPage() {
  return (
    <DetailFrame>
      <NotFound />
    </DetailFrame>
  );
}

function DetailFrame({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-stable min-w-0 flex-1 overflow-y-auto">
      <main className="mx-auto w-full max-w-[700px] px-4 py-10 sm:px-6 sm:py-14">
        <BackLink />
        {children}
      </main>
    </div>
  );
}
