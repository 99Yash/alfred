import { HeadContent, Outlet } from "@tanstack/react-router";
import { LazyMotion, MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { isAuthorizationReturnTab } from "~/lib/integrations/authorization-tab";
import { AppShell, loadMotionFeatures } from "~/lib/shell/app-shell";
import { AuthorizationReturnPage } from "./authorization-return-page";

export function RootLayout() {
  if (isAuthorizationReturnTab()) {
    return <AuthorizationReturnPage />;
  }

  // `strict` throws on a full `motion.*` component: use `m.*`, which loads only these features.
  // The authed shell suspends until the same feature promise resolves, so no `m.*`
  // under it mounts before its features exist.
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <MotionConfig reducedMotion="user">
        <div className="min-h-screen bg-background text-foreground">
          <HeadContent />
          <AppShell>
            <Outlet />
          </AppShell>
          <Toaster theme="dark" position="top-center" gap={10} />
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
