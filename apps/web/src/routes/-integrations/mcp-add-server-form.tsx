import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MCP_ADD_SERVER_MAX_LABEL_LENGTH,
  MCP_ADD_SERVER_MAX_URL_LENGTH,
  mcpAddServerBodySchema,
  toMessage,
  type McpAddServerBody,
} from "@alfred/contracts";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
  AppButton,
  AppFieldError,
  AppModal,
  omitBlankStringFields,
  useAppForm,
} from "~/components/ui/v2";
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
 * The form's own field shape. It is not `McpAddServerBody`: an empty `label`
 * input is a blank string here and is absent from the body, so the two shapes
 * differ by exactly that one transform (applied in `onSubmit`).
 */
interface AddServerFields {
  endpointUrl: string;
  label: string;
}

const DEFAULT_FIELDS: AddServerFields = { endpointUrl: "", label: "" };

/**
 * The URL rule is the CONTRACT's own, reused rather than restated, so a client
 * rejection and a server rejection can never disagree. It runs on blur and on
 * submit, never on change — a half-typed `https://` is not yet an error.
 */
const endpointUrlValidator = mcpAddServerBodySchema.shape.endpointUrl;

/**
 * The generic add door (#1004): a URL, an optional label, and the one outcome
 * this slice cannot serve.
 *
 * The trigger takes one cell beside the connection cards. The form itself sits
 * in a modal, so the grid stays a grid; the modal gathers the draft, the
 * outcome notice, and the submit action in one place.
 *
 * The inputs also carry the contract's length bounds. Without them a
 * 101-character label reaches Elysia and comes back as a raw
 * `Validation failed:` sentence, and the two exported constants have no reader
 * outside the schema that declares them.
 */
export function McpAddServerForm() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
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
    // The connection list is the one cache this add can stale. Success appends
    // a row; a failure can still leave one, because the manager's own session
    // opens AFTER the insert. Refetch on both, so a stranded connection appears
    // now rather than on the next page load. An `auth_required` answer creates
    // nothing, so its refetch finds the same list.
    onSettled: () => queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY }),
  });

  const form = useAppForm({
    defaultValues: DEFAULT_FIELDS,
    onSubmit: async ({ value, formApi }) => {
      setNotice(null);

      try {
        const body: McpAddServerBody = {
          endpointUrl: value.endpointUrl.trim(),
          ...omitBlankStringFields({ label: value.label }),
        };

        const data = await addMutation.mutateAsync(body);

        if (data.outcome === "auth_required") {
          // No rows were created; the server answered with a sign-in challenge,
          // which this slice does not support. The message is the whole state.
          // Keep the fields, so the user can retarget the URL instead of
          // retyping it.
          setNotice({
            kind: "unsupported_sign_in",
            message: "This server requires sign-in, which is not supported yet.",
          });

          return;
        }

        formApi.reset();
        setOpen(false);
      } catch (error) {
        setNotice({ kind: "error", message: toMessage(error) });
      }
    },
  });

  // Closing the door discards the draft. Without the reset, reopening it shows
  // a URL the user already walked away from. The modal reports its own
  // dismissals (Escape, overlay, drag) through `onOpenChange`, so they land
  // here too.
  const close = () => {
    form.reset();
    setNotice(null);
    setOpen(false);
  };

  return (
    <>
      <McpTile
        icon={<Plus size={18} />}
        label={MCP_SECTION.name}
        subtitle={MCP_SECTION.description}
      >
        <AppButton size="sm" variant="white" onClick={() => setOpen(true)}>
          Add
        </AppButton>
      </McpTile>

      <AppModal
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={MCP_SECTION.name}
        description={MCP_SECTION.description}
      >
        <form
          className="flex flex-col gap-4 px-6 pt-2 pb-6"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.AppField
            name="endpointUrl"
            validators={{ onBlur: endpointUrlValidator, onSubmit: endpointUrlValidator }}
          >
            {(field) => (
              <field.TextField
                type="url"
                label="Server URL"
                placeholder="https://mcp.example.com/mcp"
                maxLength={MCP_ADD_SERVER_MAX_URL_LENGTH}
              />
            )}
          </form.AppField>

          <form.AppField name="label">
            {(field) => (
              <field.TextField
                label="Label"
                optional
                placeholder="Label (optional)"
                maxLength={MCP_ADD_SERVER_MAX_LABEL_LENGTH}
              />
            )}
          </form.AppField>

          {notice ? (
            notice.kind === "error" ? (
              <AppFieldError role="alert" id="mcp-add-notice">
                {notice.message}
              </AppFieldError>
            ) : (
              <p id="mcp-add-notice" role="status" className="px-1 text-xs text-app-fg-3">
                {notice.message}
              </p>
            )
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <AppButton variant="ghost" onClick={close}>
              Cancel
            </AppButton>
            <form.Subscribe selector={(state) => state.values.endpointUrl.trim().length === 0}>
              {(isBlank) => (
                <AppButton
                  type="submit"
                  variant="primary"
                  loading={addMutation.isPending}
                  disabled={isBlank}
                >
                  Add server
                </AppButton>
              )}
            </form.Subscribe>
          </div>
        </form>
      </AppModal>
    </>
  );
}
