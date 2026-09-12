import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MCP_ADD_SERVER_MAX_LABEL_LENGTH,
  MCP_ADD_SERVER_MAX_URL_LENGTH,
  toMessage,
  type McpAddServerBody,
} from "@alfred/contracts";
import { Plus } from "lucide-react";
import { useState } from "react";
import { AppButton, AppInput } from "~/components/ui/v2";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { MCP_CONNECTIONS_QUERY_KEY, MCP_SECTION } from "./helpers";
import { McpTile } from "./mcp-tile";

/**
 * The "sign-in is not supported yet" answer, kept apart from the persisted
 * `auth_required` connection status that shares its name. This one describes an
 * add that created NOTHING; that one describes a stored connection waiting for
 * consent.
 */
type AddNotice = { kind: "unsupported_sign_in" | "error"; message: string };

/**
 * The generic add door (#1004): a URL, an optional label, and the one outcome
 * this slice cannot serve.
 *
 * All three pieces are direct children of the MCP grid. The trigger takes one
 * cell beside the connection cards; the form and the notice take `col-span-full`
 * rows under them.
 *
 * The inputs carry the CONTRACT's bounds. Without them a 101-character label
 * reaches Elysia and comes back as a raw `Validation failed:` sentence, and the
 * two exported constants have no reader outside the schema that declares them.
 */
export function McpAddServerForm() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [endpointUrl, setEndpointUrl] = useState("");
  const [label, setLabel] = useState("");
  const [notice, setNotice] = useState<AddNotice | null>(null);

  const addMutation = useMutation({
    mutationFn: async (input: McpAddServerBody) => {
      const response = await client.api.integrations.mcp.connections.post(input);

      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Add MCP server"),
        );
      }

      if (!response.data) throw new Error("Add MCP server failed");

      return response.data;
    },
    onSuccess: (data) => {
      if (data.outcome === "auth_required") {
        // No rows were created; the server answered with a sign-in challenge,
        // which this slice does not support. The message is the whole state.
        setNotice({
          kind: "unsupported_sign_in",
          message: "This server requires sign-in, which is not supported yet.",
        });

        return;
      }

      setEndpointUrl("");
      setLabel("");
      setNotice(null);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY });
    },
    onError: (error) => {
      setNotice({ kind: "error", message: toMessage(error) });
      // A failed add can still have left a row: the probe commits nothing, but
      // the manager's own session opens AFTER the insert. Refetch, so a stranded
      // connection appears now rather than on the next page load.
      void queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY });
    },
  });

  return (
    <>
      <McpTile
        icon={<Plus size={18} />}
        label={MCP_SECTION.name}
        subtitle={MCP_SECTION.description}
      >
        <AppButton
          size="sm"
          variant="white"
          onClick={() => {
            setOpen((current) => !current);
            setNotice(null);
          }}
        >
          {open ? "Close" : "Add"}
        </AppButton>
      </McpTile>

      {open ? (
        <form
          className="col-span-full flex flex-col gap-2 rounded-2xl bg-app-bg-2 p-3 ring-1 ring-app-bg-3 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            setNotice(null);
            addMutation.mutate({
              endpointUrl: endpointUrl.trim(),
              ...(label.trim() ? { label: label.trim() } : {}),
            });
          }}
        >
          <AppInput
            type="url"
            required
            maxLength={MCP_ADD_SERVER_MAX_URL_LENGTH}
            placeholder="https://mcp.example.com/mcp"
            value={endpointUrl}
            onChange={(event) => setEndpointUrl(event.target.value)}
            aria-label="MCP server URL"
            className="flex-1"
          />
          <AppInput
            maxLength={MCP_ADD_SERVER_MAX_LABEL_LENGTH}
            placeholder="Label (optional)"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            aria-label="MCP server label"
            className="sm:w-48"
          />
          <AppButton
            type="submit"
            variant="primary"
            loading={addMutation.isPending}
            disabled={endpointUrl.trim().length === 0}
          >
            Add server
          </AppButton>
        </form>
      ) : null}

      {notice ? (
        <p
          className={
            notice.kind === "error"
              ? "col-span-full px-1 text-xs text-app-red-4"
              : "col-span-full px-1 text-xs text-app-fg-3"
          }
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      ) : null}
    </>
  );
}
