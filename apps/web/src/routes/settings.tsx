import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { SettingsPage } from "./-settings/settings-page";

/** Settings: User, Features, and Preferences, one card per setting. */
export const Route = createFileRoute("/settings")({
  head: () => pageMeta({ title: "Settings", path: "/settings" }),
  component: SettingsPage,
});
