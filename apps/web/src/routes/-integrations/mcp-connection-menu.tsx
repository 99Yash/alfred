import { MCP_ADD_SERVER_MAX_LABEL_LENGTH } from "@alfred/contracts";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis, Pencil, PlugZap, Trash2, Wrench } from "lucide-react";
import { use, useRef, useState } from "react";
import {
  AppButton,
  AppInput,
  AppModal,
  appMenuDangerItemClass,
  appMenuItemClass,
  appMenuSeparatorClass,
  appMenuSurfaceClass,
} from "~/components/ui/v2";
import { AppThemeContext } from "~/components/ui/v2/theme";
import { cn } from "~/lib/utils";
import type { McpConnection } from "~/lib/integrations/mcp-connections";
import type { McpConnectionActions } from "./mcp-connection-actions";
import { McpConnectionCatalogPanel } from "./mcp-connection-catalog";
import { mcpConnectionHealthText } from "./mcp-server-status";

/** The modal this menu has open. One value, so two modals cannot stack. */
type McpMenuDialog = "tools" | "rename" | "remove" | null;

/** The last action error, in the tile subtitle. A blocked removal links to the recovery list. */
export function McpActionErrorText({
  error,
}: {
  error: NonNullable<McpConnectionActions["error"]>;
}) {
  return (
    <span role="alert" className="text-app-red-4">
      {error.message}
      {error.kind === "blocked_remove" ? (
        <>
          {" "}
          <a href="#mcp-recovery" className="underline">
            Resolve the pending operation
          </a>
        </>
      ) : null}
    </span>
  );
}

/**
 * The secondary actions of one MCP connection behind a "..." trigger, so every
 * MCP tile has one main button. Built-in rows cannot be renamed (the server
 * refuses it), and they keep their row, so `custom` gates Rename and Remove.
 */
export function McpConnectionMenu({
  connection,
  actions,
  custom,
}: {
  connection: McpConnection;
  actions: McpConnectionActions;
  custom: boolean;
}) {
  // The menu portals outside `.app`; stamp the resolved theme so tokens resolve.
  const resolved = use(AppThemeContext)?.resolved;
  const [dialog, setDialog] = useState<McpMenuDialog>(null);
  const [draftLabel, setDraftLabel] = useState(connection.label);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const busy = actions.pending !== null;

  const closeDialog = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={`${connection.label} actions`}
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-control-sm",
              "app-press text-app-fg-3 transition-colors",
              "hover:bg-app-bg-a2 hover:text-app-fg-4 data-[state=open]:bg-app-bg-a2",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
            )}
          >
            <Ellipsis size={14} aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            data-app-theme={resolved}
            className={cn(appMenuSurfaceClass, "min-w-[168px]")}
            align="end"
            sideOffset={4}
          >
            <DropdownMenu.Item className={appMenuItemClass} onSelect={() => setDialog("tools")}>
              <Wrench size={14} aria-hidden className="text-app-fg-2" />
              View tools
            </DropdownMenu.Item>
            {custom ? (
              <DropdownMenu.Item
                className={appMenuItemClass}
                disabled={busy}
                onSelect={() => {
                  setDraftLabel(connection.label);
                  setDialog("rename");
                }}
              >
                <Pencil size={14} aria-hidden className="text-app-fg-2" />
                Rename
              </DropdownMenu.Item>
            ) : null}
            {connection.status !== "disconnected" ? (
              <DropdownMenu.Item
                className={appMenuItemClass}
                disabled={busy}
                onSelect={actions.onDisconnect}
              >
                <PlugZap size={14} aria-hidden className="text-app-fg-2" />
                Disconnect
              </DropdownMenu.Item>
            ) : null}
            {custom ? (
              <>
                <DropdownMenu.Separator className={appMenuSeparatorClass} />
                <DropdownMenu.Item
                  className={appMenuDangerItemClass}
                  disabled={busy}
                  onSelect={() => setDialog("remove")}
                >
                  <Trash2 size={14} aria-hidden />
                  Remove
                </DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <AppModal
        open={dialog === "tools"}
        onOpenChange={closeDialog}
        returnFocusTo={triggerRef}
        title={`${connection.label} tools`}
        // A non-ready status shows in the panel, above the list (ADR-0094).
        description={
          connection.status === "ready" ? mcpConnectionHealthText(connection) : undefined
        }
        className="sm:max-w-2xl"
      >
        <McpConnectionCatalogPanel connection={connection} />
      </AppModal>

      {custom ? (
        <AppModal
          open={dialog === "rename"}
          onOpenChange={closeDialog}
          returnFocusTo={triggerRef}
          title="Rename connection"
          description="Alfred shows this name on the integrations page."
        >
          <form
            className="flex items-center gap-2 px-6 pb-6"
            onSubmit={(event) => {
              event.preventDefault();
              const label = draftLabel.trim();

              if (label.length === 0) return;

              actions.onRename(label);
              setDialog(null);
            }}
          >
            <AppInput
              autoFocus
              aria-label="Connection label"
              className="min-w-0 flex-1"
              maxLength={MCP_ADD_SERVER_MAX_LABEL_LENGTH}
              value={draftLabel}
              onChange={(event) => setDraftLabel(event.target.value)}
            />
            <AppButton
              variant="primary"
              type="submit"
              disabled={busy || draftLabel.trim().length === 0}
            >
              Save
            </AppButton>
          </form>
        </AppModal>
      ) : null}

      {custom ? (
        <AppModal
          open={dialog === "remove"}
          onOpenChange={closeDialog}
          returnFocusTo={triggerRef}
          title={`Remove ${connection.label}?`}
          description="Alfred stops using this server and forgets its tools. You can add it again later."
        >
          <div className="flex justify-end gap-2 px-6 pb-6">
            <AppButton variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </AppButton>
            <AppButton
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setDialog(null);
                actions.onRemove();
              }}
            >
              Remove
            </AppButton>
          </div>
        </AppModal>
      ) : null}
    </>
  );
}
