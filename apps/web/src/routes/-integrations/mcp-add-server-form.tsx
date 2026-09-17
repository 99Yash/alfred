import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MCP_ADD_SERVER_MAX_LABEL_LENGTH,
  MCP_ADD_SERVER_MAX_URL_LENGTH,
  MCP_API_KEY_MAX_LENGTH,
  MCP_API_KEY_MAX_PLACEMENT_NAME_LENGTH,
  mcpAddServerBodySchema,
  toMessage,
  type McpAddServerBody,
} from "@alfred/contracts";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
  AppButton,
  AppField,
  AppFieldError,
  AppInput,
  AppModal,
  AppSegmented,
  omitBlankStringFields,
  useAppForm,
  type AppSegmentedItem,
} from "~/components/ui/v2";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { mcpAuthorizeUrl, MCP_CONNECTIONS_QUERY_KEY, MCP_SECTION } from "./helpers";
import { McpTile } from "./mcp-tile";

/**
 * The add door's authentication choice. `oauth` is not "OAuth required": it is
 * "no key supplied", and the server's pre-persist probe answers with the real
 * variant — a no-auth server connects, one that answers a challenge lands in
 * `auth_required` and the form navigates to consent. `api_key` names the
 * placement explicitly and sends the key in the create body.
 */
export type McpAddServerAuthMode = "oauth" | "api_key";

export type McpApiKeyPlacementIn = "header" | "query";

/**
 * The form's own field shape. It is not `McpAddServerBody`: an empty `label`
 * input is a blank string here and is absent from the body, and the API-key
 * fields collapse into one `auth` union. {@link buildAddServerBody} owns both
 * transforms.
 */
export interface AddServerFields {
  endpointUrl: string;
  label: string;
  authMode: McpAddServerAuthMode;
  apiKey: {
    placementIn: McpApiKeyPlacementIn;
    placementName: string;
    value: string;
  };
}

const DEFAULT_API_KEY = {
  placementIn: "header" as McpApiKeyPlacementIn,
  placementName: "",
  value: "",
};

const DEFAULT_FIELDS = { endpointUrl: "", label: "" };

const AUTH_MODE_ITEMS = [
  { value: "oauth", label: "OAuth / no key" },
  { value: "api_key", label: "API key" },
] as const satisfies ReadonlyArray<AppSegmentedItem<McpAddServerAuthMode>>;

const PLACEMENT_ITEMS = [
  { value: "header", label: "Header" },
  { value: "query", label: "Query" },
] as const satisfies ReadonlyArray<AppSegmentedItem<McpApiKeyPlacementIn>>;

/**
 * The one transform from form fields to the create body.
 *
 * It is pure and exported so the `auth` union can be proven without a DOM: the
 * `oauth` arm omits `auth` (the probe decides), and the `api_key` arm narrows
 * exhaustively to the contract's single arm. The compiler checks the shape; a
 * runtime form still needs the branch pinned.
 */
export function buildAddServerBody(fields: AddServerFields): McpAddServerBody {
  const base: McpAddServerBody = {
    endpointUrl: fields.endpointUrl.trim(),
    ...omitBlankStringFields({ label: fields.label }),
  };

  if (fields.authMode === "oauth") return base;

  return {
    ...base,
    auth: {
      kind: "api_key",
      placement: { in: fields.apiKey.placementIn, name: fields.apiKey.placementName.trim() },
      value: fields.apiKey.value,
    },
  };
}

/**
 * The URL rule is the CONTRACT's own, reused rather than restated, so a client
 * rejection and a server rejection can never disagree. It runs on blur and on
 * submit, never on change — a half-typed `https://` is not yet an error.
 */
const endpointUrlValidator = mcpAddServerBodySchema.shape.endpointUrl;

/**
 * The generic add door (#1004): a URL, an optional label, an authentication
 * choice, and a handoff to a consent screen when the server asks for one.
 *
 * The trigger takes one cell beside the connection cards. The form itself sits
 * in a modal, so the grid stays a grid; the modal gathers the draft, the
 * failure message, and the submit action in one place.
 *
 * The API-key value lives only in form state. It is a password input, it is
 * never logged, and closing the modal resets it, so the plaintext does not
 * outlive the one submit that carries it.
 */
export function McpAddServerForm() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<McpAddServerAuthMode>("oauth");
  const [apiKey, setApiKey] = useState(DEFAULT_API_KEY);

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
    // The connection list is the one cache this add can stale. Every answer
    // appends a row, and a failure can still leave one, because the manager's
    // own session opens AFTER the insert. Refetch on both, so a stranded
    // connection appears now rather than on the next page load.
    onSettled: () => queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY }),
  });

  const form = useAppForm({
    defaultValues: DEFAULT_FIELDS,
    onSubmit: async ({ value, formApi }) => {
      setError(null);

      try {
        const body = buildAddServerBody({
          endpointUrl: value.endpointUrl,
          label: value.label,
          authMode,
          apiKey,
        });

        const data = await addMutation.mutateAsync(body);

        if (data.outcome === "auth_required") {
          // The row exists and waits for consent. Hand the browser to the
          // connection's authorize route, which redirects to the server's own
          // authorization server; its callback returns here. Nothing is reset
          // and the modal stays open, because this frame is leaving the page.
          window.location.href = mcpAuthorizeUrl(data.connectionId);

          return;
        }

        formApi.reset();
        setOpen(false);
      } catch (submitError) {
        setError(toMessage(submitError));
      }
    },
  });

  // Closing the door discards the draft. Without the reset, reopening it shows
  // a URL the user already walked away from, and an API key that was already
  // typed. The modal reports its own dismissals (Escape, overlay, drag)
  // through `onOpenChange`, so they land here too.
  const close = () => {
    form.reset();
    setError(null);
    setAuthMode("oauth");
    setApiKey(DEFAULT_API_KEY);
    setOpen(false);
  };

  const apiKeyIncomplete =
    authMode === "api_key" &&
    (apiKey.placementName.trim().length === 0 || apiKey.value.length === 0);

  return (
    <>
      <McpTile
        icon={{ glyph: <Plus size={18} /> }}
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

          <AppField label="Authentication">
            <AppSegmented
              value={authMode}
              onValueChange={setAuthMode}
              items={AUTH_MODE_ITEMS}
              label="Authentication"
            />
          </AppField>

          {authMode === "api_key" ? (
            <>
              <AppField label="Send key in">
                <AppSegmented
                  value={apiKey.placementIn}
                  onValueChange={(placementIn) =>
                    setApiKey((current) => ({ ...current, placementIn }))
                  }
                  items={PLACEMENT_ITEMS}
                  label="API key placement"
                />
              </AppField>

              <AppField
                label="Placement name"
                htmlFor="mcp-api-key-name"
                helperText="The header or query parameter the key is sent as."
              >
                <AppInput
                  id="mcp-api-key-name"
                  value={apiKey.placementName}
                  maxLength={MCP_API_KEY_MAX_PLACEMENT_NAME_LENGTH}
                  onChange={(event) =>
                    setApiKey((current) => ({ ...current, placementName: event.target.value }))
                  }
                />
              </AppField>

              <AppField label="API key" htmlFor="mcp-api-key-value">
                <AppInput
                  id="mcp-api-key-value"
                  type="password"
                  autoComplete="off"
                  value={apiKey.value}
                  maxLength={MCP_API_KEY_MAX_LENGTH}
                  onChange={(event) =>
                    setApiKey((current) => ({ ...current, value: event.target.value }))
                  }
                />
              </AppField>
            </>
          ) : null}

          {error ? (
            <AppFieldError role="alert" id="mcp-add-error">
              {error}
            </AppFieldError>
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
                  disabled={isBlank || apiKeyIncomplete}
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
