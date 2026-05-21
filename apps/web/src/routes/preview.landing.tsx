import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "~/components/landing/landing-page";

/**
 * Preview of the logged-out marketing landing — accessible at /preview/landing
 * regardless of auth state. Handy for iterating on the Dimension-grammar
 * primitives in components/landing/* without signing out.
 */
export const Route = createFileRoute("/preview/landing")({
  component: () => <LandingPage healthOk={true} healthLoading={false} />,
});
