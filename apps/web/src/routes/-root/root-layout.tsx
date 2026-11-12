import { HeadContent, Outlet } from "@tanstack/react-router";
import { LazyMotion, MotionConfig } from "motion/react";
import { useEffect } from "react";
import { Toaster } from "sonner";
import {
  isAuthorizationReturnTab,
  readAuthorizationError,
} from "~/lib/integrations/authorization-tab";
import { AppShell, loadMotionFeatures } from "~/lib/shell/app-shell";
import { toast } from "~/lib/toast";
import { AuthorizationReturnPage } from "./authorization-return-page";

export function RootLayout() {
  const returnTab = isAuthorizationReturnTab();

  // A blocked tab sends the callback to this tab, so a refused authorization shows here.
  // The callback is a full page load, so this runs once for it.
  useEffect(() => {
    if (returnTab) return;
    const error = readAuthorizationError(window.location.search);

    if (error) toast.error({ message: "Not connected", description: error });
  }, [returnTab]);

  if (returnTab) {
    return <AuthorizationReturnPage />;
  }

  // `strict` throws on a full `motion.*` component: use `m.*`, which loads only these features.
  // The outer `LazyMotion` loads async for the public `/c/$slug` page. The authed
  // shell brings its own resolved bundle, so its first render has the renderer.
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <MotionConfig reducedMotion="user">
        <div className="min-h-screen bg-background text-foreground">
          <HeadContent />
          <AppShell>
            <Outlet />
          </AppShell>
          <Toaster theme="dark" position="bottom-right" gap={10} />
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
