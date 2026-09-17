import { MCP_ADD_SERVER_MAX_LABEL_LENGTH } from "@alfred/contracts";
import { AlertTriangle, Plug, Wrench } from "lucide-react";
import { useState } from "react";
import { AppButton, AppInput } from "~/components/ui/v2";
import { mcpAuthorizeUrl, type McpConnection } from "./helpers";
import { useMcpConnectionActions, type McpConnectionActions } from "./mcp-connection-actions";
import { McpConnectionCatalogPanel } from "./mcp-connection-catalog";
import { McpTile } from "./mcp-tile";
import { mcpConnectionHealthText } from "./mcp-server-status";

export interface McpConnectionCardViewProps {
  connection: McpConnection;
  actions: McpConnectionActions;
}

/**
 * One user-added MCP server: health, and every action that acts on its row.
 *
 * Presentation only. The four lifecycle mutations live behind
 * {@link useMcpConnectionActions}, so this half renders from props and the
 * `renderToStaticMarkup` seam can pin the closed confirm step, the
 * `auth_required` action set, and a 409's recovery anchor without a DOM or a
 * QueryClient.
 *
 * The remove confirm is inline state, not a browser dialog: it renders inside
 * the same tree (so static markup sees the closed state) and puts the question
 * next to the row it is about, matching `McpRecoveryList`.
 *
 * `auth_required` is the one state no mutation can repair: the row holds no
 * usable credential, so `reconnect` throws and answers 400. Only a consent
 * round trip helps, so that state replaces Reconnect with a browser NAVIGATION
 * to the same door the built-in tile uses.
 */
export function McpConnectionCardView({ connection, actions }: McpConnectionCardViewProps) {
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

  const needsConsent = connection.status === "auth_required";
  const busy = actions.pending !== null;

  const subtitle = actions.error ? (
    <span role="alert" className="text-app-red-4">
      {actions.error.message}
      {actions.error.kind === "blocked_remove" ? (
        <>
          {" "}
          <a href="#mcp-recovery" className="underline">
            Resolve the pending operation
          </a>
        </>
      ) : null}
    </span>
  ) : (
    mcpConnectionHealthText(connection)
  );

  return (
    <div className="space-y-2">
      <McpTile icon={{ glyph: <Plug size={18} /> }} label={connection.label} subtitle={subtitle}>
        {editingLabel !== null ? (
          <form
            className="flex shrink-0 items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const label = editingLabel.trim();

              if (label.length === 0) return;

              actions.onRename(label);
              setEditingLabel(null);
            }}
          >
            <AppInput
              // Autofocus is a user-visible focus move on a control the click
              // just revealed; without it the editor opens unfocused.
              autoFocus
              aria-label="Connection label"
              className="h-7 w-32 text-[13px]"
              maxLength={MCP_ADD_SERVER_MAX_LABEL_LENGTH}
              value={editingLabel}
              onChange={(event) => setEditingLabel(event.target.value)}
            />
            <AppButton size="sm" variant="primary" type="submit" disabled={busy}>
              Save
            </AppButton>
            <AppButton size="sm" variant="ghost" onClick={() => setEditingLabel(null)}>
              Cancel
            </AppButton>
          </form>
        ) : confirmingRemove ? (
          <div className="flex shrink-0 items-center gap-1" role="group">
            <span className="text-xs text-app-fg-3">Remove this connection?</span>
            <AppButton
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmingRemove(false);
                actions.onRemove();
              }}
            >
              Confirm
            </AppButton>
            <AppButton size="sm" variant="ghost" onClick={() => setConfirmingRemove(false)}>
              Cancel
            </AppButton>
          </div>
        ) : (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            {needsConsent ? (
              <AppButton
                size="sm"
                variant="white"
                leading={<AlertTriangle size={12} />}
                onClick={() => {
                  window.location.href = mcpAuthorizeUrl(connection.id);
                }}
              >
                Grant access
              </AppButton>
            ) : (
              <AppButton
                size="sm"
                variant="ghost"
                loading={actions.pending === "reconnect"}
                disabled={busy && actions.pending !== "reconnect"}
                onClick={actions.onReconnect}
              >
                {connection.status === "disconnected" ? "Connect" : "Reconnect"}
              </AppButton>
            )}
            {connection.status !== "disconnected" ? (
              <AppButton
                size="sm"
                variant="ghost"
                loading={actions.pending === "disconnect"}
                disabled={busy && actions.pending !== "disconnect"}
                onClick={actions.onDisconnect}
              >
                Disconnect
              </AppButton>
            ) : null}
            <AppButton
              size="sm"
              variant="ghost"
              leading={<Wrench size={12} />}
              disabled={busy}
              onClick={() => setToolsOpen((open) => !open)}
            >
              {toolsOpen ? "Hide tools" : "View tools"}
            </AppButton>
            <AppButton
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditingLabel(connection.label)}
            >
              Rename
            </AppButton>
            <AppButton
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmingRemove(true)}
            >
              Remove
            </AppButton>
          </div>
        )}
      </McpTile>

      {toolsOpen ? <McpConnectionCatalogPanel connection={connection} /> : null}
    </div>
  );
}

/**
 * The container the section renders. It owns the lifecycle hook and hands the
 * flattened actions to the view, so the view stays hook-free.
 */
export function McpConnectionCard({ connection }: { connection: McpConnection }) {
  const actions = useMcpConnectionActions(connection);

  return <McpConnectionCardView connection={connection} actions={actions} />;
}
