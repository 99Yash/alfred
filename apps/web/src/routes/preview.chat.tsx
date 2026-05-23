import { createFileRoute } from "@tanstack/react-router";
import { PreviewChatRoute } from "./-preview-chat/preview-chat-route";

/**
 * Visitors-now-grammar app shell for the upcoming chat UI.
 *
 * Layout
 * - Fixed 264px left rail: brand · new-chat CTA · search · thread groups · user.
 * - Main column: frost-blurred top bar with thread title + actions, scrollable
 *   conversation, composer pinned to bottom.
 *
 * Everything visitors-feel: rounded-full pills for nav rows, `vs-elevated`
 * surfaces, the masked frost backdrop on chrome, and active:scale-99 press.
 * Theme-aware via VsThemeProvider — toggle lives in the top bar.
 *
 * Mounted at /preview/chat regardless of auth state. Content below the chrome
 * is placeholder so the shell can be reviewed in isolation before /chat lands.
 */
export const Route = createFileRoute("/preview/chat")({
  component: PreviewChatRoute,
});
