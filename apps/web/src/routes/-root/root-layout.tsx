import { HeadContent, Outlet } from "@tanstack/react-router";
import { LazyMotion, MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { isAuthorizationReturnTab } from "~/lib/integrations/authorization-tab";
import { AppShell } from "~/lib/shell/app-shell";
import { AuthorizationReturnPage } from "./authorization-return-page";

const loadMotionFeatures = () => import("./motion-features").then((mod) => mod.domAnimation);

export function RootLayout() {
  if (isAuthorizationReturnTab()) {
    return <AuthorizationReturnPage />;
  }

  // `strict` throws on a full `motion.*` component: use `m.*`, which loads only these features.
  // `m.*` renders its `initial` values until the features load.
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
