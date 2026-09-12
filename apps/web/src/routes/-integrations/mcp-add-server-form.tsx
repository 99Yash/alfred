import { useForm } from "@tanstack/react-form";
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
import { AppButton, AppField, AppInput, omitBlankStringFields } from "~/components/ui/v2";
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
 * All three pieces are direct children of the MCP grid. The trigger takes one
 * cell beside the connection cards; the form and the notice take `col-span-full`
 * rows under them.
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
  });

  const form = useForm({
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
        void queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY });
      } catch (error) {
        setNotice({ kind: "error", message: toMessage(error) });
        // A failed add can still have left a row: the probe commits nothing, but
        // the manager's own session opens AFTER the insert. Refetch, so a
        // stranded connection appears now rather than on the next page load.
        void queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY });
      }
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
            // Closing the door discards the draft. Without the reset, reopening
            // it shows a URL the user already walked away from.
            if (open) form.reset();
            setOpen((current) => !current);
            setNotice(null);
          }}
        >
          {open ? "Close" : "Add"}
        </AppButton>
      </McpTile>

      {open ? (
        <form
          className="col-span-full flex flex-col gap-2 rounded-2xl bg-app-bg-2 p-3 ring-1 ring-app-bg-3 sm:flex-row sm:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field
            name="endpointUrl"
            validators={{ onBlur: endpointUrlValidator, onSubmit: endpointUrlValidator }}
          >
            {(field) => {
              const error = field.state.meta.isBlurred ? field.state.meta.errors[0] : undefined;
              const errorId = `${field.name}-error`;

              return (
                <AppField className="flex-1" error={error?.message} errorId={errorId}>
                  <AppInput
                    type="url"
                    maxLength={MCP_ADD_SERVER_MAX_URL_LENGTH}
                    placeholder="https://mcp.example.com/mcp"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                    aria-label="MCP server URL"
                    aria-invalid={error ? true : undefined}
                    aria-errormessage={error ? errorId : undefined}
                  />
                </AppField>
              );
            }}
          </form.Field>

          <form.Field name="label">
            {(field) => (
              <AppField className="sm:w-48">
                <AppInput
                  maxLength={MCP_ADD_SERVER_MAX_LABEL_LENGTH}
                  placeholder="Label (optional)"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  aria-label="MCP server label"
                />
              </AppField>
            )}
          </form.Field>

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
