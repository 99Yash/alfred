import {
  humanizeSlug,
  jsonObjectSchema,
  mcpHealthMappingDefinitionSchema,
  MCP_HEALTH_MAPPING_NOTE_MAX,
  OBJECT_STATE_CATEGORIES,
  safeJsonParse,
  toMessage,
  isBuiltInObjectStateProvider,
  type ExternalToolRef,
  type McpHealthMappingDefinition,
  type StateCategory,
} from "@alfred/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  AppButton,
  AppField,
  AppInput,
  AppSelect,
  AppTextarea,
  type AppSelectOption,
} from "~/components/ui/v2";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { MCP_HEALTH_MAPPING_QUERY_KEY, type McpHealthMappingWireState } from "./helpers";

type TokenDrafts = Record<StateCategory, string>;

interface MappingDraft {
  itemsPath: string;
  identityProvider: McpHealthMappingDefinition["identityProvider"] | "";
  identityPath: string;
  statePath: string;
  titlePath: string;
  urlPath: string;
  argumentsText: string;
  tokens: TokenDrafts;
  note: string | null;
}

const EMPTY_TOKENS = {
  active: "",
  resolved: "",
  failed: "",
  abandoned: "",
} satisfies TokenDrafts;

const DEFAULT_DRAFT: MappingDraft = {
  itemsPath: "items",
  identityProvider: "",
  identityPath: "id",
  statePath: "state",
  titlePath: "",
  urlPath: "",
  argumentsText: "{}",
  tokens: EMPTY_TOKENS,
  note: null,
};

const STATE_INPUTS = OBJECT_STATE_CATEGORIES.map((state) => ({
  state,
  label: humanizeSlug(state),
}));

const MAPPING_IDENTITY_PROVIDERS =
  mcpHealthMappingDefinitionSchema.shape.identityProvider.options.filter(
    (provider) => !isBuiltInObjectStateProvider(provider),
  );

const IDENTITY_PROVIDER_OPTIONS: ReadonlyArray<AppSelectOption> = MAPPING_IDENTITY_PROVIDERS.map(
  (provider) => ({ value: provider, label: humanizeSlug(provider) }),
);

function tokensFromDefinition(definition: McpHealthMappingDefinition) {
  const tokens = { ...EMPTY_TOKENS } satisfies TokenDrafts;

  for (const mapping of definition.stateMappings) {
    const existing = tokens[mapping.state];
    tokens[mapping.state] = existing ? `${existing}, ${mapping.token}` : mapping.token;
  }

  return tokens;
}

function draftFromMapping(mapping: McpHealthMappingDefinition, note: string | null): MappingDraft {
  return {
    itemsPath: mapping.itemsPath,
    identityProvider: mapping.identityProvider,
    identityPath: mapping.fields.identity,
    statePath: mapping.fields.state,
    titlePath: mapping.fields.title,
    urlPath: mapping.fields.url,
    argumentsText: JSON.stringify(mapping.arguments, null, 2),
    tokens: tokensFromDefinition(mapping),
    note,
  };
}

function stateMappings(tokens: TokenDrafts) {
  return OBJECT_STATE_CATEGORIES.flatMap((state) =>
    tokens[state]
      .split(/[\n,]/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
      .map((token) => ({ token, state })),
  );
}

export interface McpHealthMappingController {
  readonly state: McpHealthMappingWireState | undefined;
  readonly loading: boolean;
  readonly readError: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onSave: (definition: McpHealthMappingDefinition, note: string | null) => void;
  readonly onClear: () => void;
}

/** Exact descriptor review state plus its two owner mutations. */
export function useMcpHealthMapping(
  connectionId: string,
  ref: ExternalToolRef,
): McpHealthMappingController {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const tools = client.api.integrations.mcp.connections({ id: connectionId }).tools;
  const route = tools["health-mapping"];

  const queryKey = [
    ...MCP_HEALTH_MAPPING_QUERY_KEY,
    connectionId,
    ref.remoteName,
    ref.catalogRevision,
  ] as const;

  const stateQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await route.get({
        query: { remoteName: ref.remoteName, catalogRevision: ref.catalogRevision },
      });

      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Load health mapping"),
        );
      }

      if (!response.data) throw new Error("Could not load the MCP health mapping");

      return response.data;
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: MCP_HEALTH_MAPPING_QUERY_KEY });

  const review = useMutation({
    mutationFn: async (input: { definition: McpHealthMappingDefinition; note: string | null }) => {
      const response = await route.put({
        ref,
        readOnly: true,
        definition: input.definition,
        note: input.note,
      });

      if (response.error) {
        throw new Error(
          responseErrorMessage(
            response.error.value,
            response.error.status,
            "Review health mapping",
          ),
        );
      }

      return response.data;
    },
    onMutate: () => setError(null),
    onSettled: invalidate,
    onError: (cause) => setError(toMessage(cause)),
  });

  const clear = useMutation({
    mutationFn: async () => {
      const response = await route.delete({ ref });

      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Clear health mapping"),
        );
      }

      return response.data;
    },
    onMutate: () => setError(null),
    onSettled: invalidate,
    onError: (cause) => setError(toMessage(cause)),
  });

  return {
    state: stateQuery.data,
    loading: stateQuery.isPending,
    readError: stateQuery.isError,
    pending: review.isPending || clear.isPending,
    error,
    onRetry: () => {
      void stateQuery.refetch();
    },
    onSave: (definition, note) => review.mutate({ definition, note }),
    onClear: () => clear.mutate(),
  };
}

function MappingForm({
  initial,
  pending,
  onSave,
  onClear,
}: {
  initial: MappingDraft;
  pending: boolean;
  onSave: McpHealthMappingController["onSave"];
  onClear?: (() => void) | undefined;
}) {
  const [itemsPath, setItemsPath] = useState(initial.itemsPath);
  const [identityProvider, setIdentityProvider] = useState(initial.identityProvider);
  const [identityPath, setIdentityPath] = useState(initial.identityPath);
  const [statePath, setStatePath] = useState(initial.statePath);
  const [titlePath, setTitlePath] = useState(initial.titlePath);
  const [urlPath, setUrlPath] = useState(initial.urlPath);
  const [argumentsText, setArgumentsText] = useState(initial.argumentsText);
  const [tokens, setTokens] = useState<TokenDrafts>(initial.tokens);
  const [note, setNote] = useState(initial.note ?? "");
  const [readOnlyConfirmed, setReadOnlyConfirmed] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setValidationError(null);

        if (!readOnlyConfirmed) {
          setValidationError("Confirm the exact descriptor is read-only before approving.");

          return;
        }

        const args = jsonObjectSchema.safeParse(
          safeJsonParse(argumentsText.trim().length > 0 ? argumentsText : "{}"),
        );

        if (!args.success) {
          setValidationError("Tool arguments must be one JSON object.");

          return;
        }

        const definition = mcpHealthMappingDefinitionSchema.safeParse({
          itemsPath: itemsPath.trim(),
          identityProvider,
          fields: {
            identity: identityPath.trim(),
            state: statePath.trim(),
            title: titlePath.trim(),
            url: urlPath.trim(),
          },
          stateMappings: stateMappings(tokens),
          arguments: args.data,
        });

        if (!definition.success) {
          setValidationError(definition.error.issues[0]?.message ?? "Invalid health mapping.");

          return;
        }

        const trimmedNote = note.trim();
        onSave(definition.data, trimmedNote.length > 0 ? trimmedNote : null);
      }}
    >
      <p className="text-xs text-app-fg-3">
        Paths are dot-separated object keys. State tokens are exact and case-sensitive. Active and
        failed stay open; resolved and abandoned are eligible for normal store-backed closure.
        Identity provider must be one of:{" "}
        {IDENTITY_PROVIDER_OPTIONS.map(({ value }) => value).join(", ")}. Arguments are stored with
        this review; never put credentials in them.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <AppField label="Items path" optional htmlFor="mcp-health-items-path">
          <AppInput
            id="mcp-health-items-path"
            value={itemsPath}
            disabled={pending}
            placeholder="items or data.items"
            onChange={(event) => setItemsPath(event.target.value)}
          />
        </AppField>
        <AppSelect
          id="mcp-health-identity-provider"
          label="Identity provider"
          placeholder="Select a provider"
          value={identityProvider || undefined}
          options={IDENTITY_PROVIDER_OPTIONS}
          disabled={pending}
          onChange={(value) => {
            const provider = MAPPING_IDENTITY_PROVIDERS.find((candidate) => candidate === value);

            setIdentityProvider(provider ?? "");
          }}
        />
        <AppField label="Arguments JSON" optional htmlFor="mcp-health-arguments">
          <AppTextarea
            id="mcp-health-arguments"
            value={argumentsText}
            disabled={pending}
            onChange={(event) => setArgumentsText(event.target.value)}
          />
        </AppField>
        <AppField label="Identity field" htmlFor="mcp-health-identity-path">
          <AppInput
            id="mcp-health-identity-path"
            value={identityPath}
            disabled={pending}
            placeholder="identifier"
            onChange={(event) => setIdentityPath(event.target.value)}
          />
        </AppField>
        <AppField label="State field" htmlFor="mcp-health-state-path">
          <AppInput
            id="mcp-health-state-path"
            value={statePath}
            disabled={pending}
            placeholder="status"
            onChange={(event) => setStatePath(event.target.value)}
          />
        </AppField>
        <AppField label="Title field" optional htmlFor="mcp-health-title-path">
          <AppInput
            id="mcp-health-title-path"
            value={titlePath}
            disabled={pending}
            placeholder="title"
            onChange={(event) => setTitlePath(event.target.value)}
          />
        </AppField>
        <AppField label="URL field" optional htmlFor="mcp-health-url-path">
          <AppInput
            id="mcp-health-url-path"
            value={urlPath}
            disabled={pending}
            placeholder="url"
            onChange={(event) => setUrlPath(event.target.value)}
          />
        </AppField>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {STATE_INPUTS.map(({ state, label }) => (
          <AppField key={state} label={`${label} tokens`} optional htmlFor={`mcp-health-${state}`}>
            <AppInput
              id={`mcp-health-${state}`}
              value={tokens[state]}
              disabled={pending}
              placeholder="exact, case-sensitive tokens"
              onChange={(event) =>
                setTokens((current) => ({ ...current, [state]: event.target.value }))
              }
            />
          </AppField>
        ))}
      </div>

      <AppField label="Review note" optional htmlFor="mcp-health-note">
        <AppTextarea
          id="mcp-health-note"
          maxLength={MCP_HEALTH_MAPPING_NOTE_MAX}
          value={note}
          disabled={pending}
          onChange={(event) => setNote(event.target.value)}
        />
      </AppField>

      <label className="flex items-start gap-2 text-xs text-app-fg-3">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={readOnlyConfirmed}
          disabled={pending}
          onChange={(event) => setReadOnlyConfirmed(event.target.checked)}
        />
        <span>
          I reviewed this exact descriptor and confirm it is read-only. A catalog change voids this
          approval.
        </span>
      </label>

      {validationError ? (
        <p className="text-xs text-app-red-4" role="alert">
          {validationError}
        </p>
      ) : null}

      <div className="flex items-center gap-1">
        <AppButton
          type="submit"
          size="sm"
          variant="primary"
          disabled={pending || !readOnlyConfirmed}
        >
          Approve health mapping
        </AppButton>
        {onClear ? (
          <AppButton type="button" size="sm" variant="ghost" disabled={pending} onClick={onClear}>
            Clear mapping
          </AppButton>
        ) : null}
      </div>
    </form>
  );
}

/** Health mapping review presentation, separated from its query/mutation hook. */
export function McpHealthMappingView({
  state,
  loading,
  readError,
  pending,
  error,
  onRetry,
  onSave,
  onClear,
}: McpHealthMappingController) {
  return (
    <div className="space-y-2 rounded-lg bg-app-bg-2 p-2">
      <p className="text-xs font-medium text-app-fg-4">Briefing health mapping</p>

      {loading ? (
        <p className="text-xs text-app-fg-3" role="status">
          Loading health mapping…
        </p>
      ) : readError ? (
        <div className="flex items-center gap-2" role="alert">
          <p className="text-xs text-red-600">Could not load the MCP health mapping.</p>
          <AppButton size="sm" variant="white" onClick={onRetry}>
            Retry
          </AppButton>
        </div>
      ) : state === undefined ? null : state.status === "catalog_stale" ? (
        <p className="text-xs text-app-fg-3">
          The catalog changed. Refresh and inspect this tool again before approving a mapping.
        </p>
      ) : state.status === "not_found" ? (
        <p className="text-xs text-app-fg-3">This tool is not in the current catalog.</p>
      ) : state.status === "not_read_only" ? (
        <p className="text-xs text-app-red-4" role="alert">
          This descriptor is not marked read-only, so Alfred will not run a health mapping for it.
        </p>
      ) : state.status === "invalid" ? (
        <div className="space-y-2">
          <p className="text-xs text-app-red-4" role="alert">
            The saved mapping is invalid and grants no authority. Clear it and review the descriptor
            again.
          </p>
          <AppButton size="sm" variant="ghost" disabled={pending} onClick={onClear}>
            Clear invalid mapping
          </AppButton>
        </div>
      ) : state.status === "drifted" ? (
        <div className="space-y-2">
          <p className="text-xs text-app-amber-4" role="status">
            The descriptor changed, so the earlier health mapping is void. Review the current
            descriptor to replace it.
          </p>
          <MappingForm
            key={`drifted:${state.previous.mappingRevision}`}
            initial={draftFromMapping(state.previous.definition, state.previous.note)}
            pending={pending}
            onSave={onSave}
          />
        </div>
      ) : state.status === "reviewed" ? (
        <div className="space-y-2">
          <p className="text-xs text-app-fg-3" role="status">
            Reviewed for this descriptor (revision {state.mapping.mappingRevision}).
          </p>
          <MappingForm
            key={`reviewed:${state.mapping.mappingRevision}`}
            initial={draftFromMapping(state.mapping.definition, state.mapping.note)}
            pending={pending}
            onSave={onSave}
            onClear={onClear}
          />
        </div>
      ) : (
        <MappingForm key="unreviewed" initial={DEFAULT_DRAFT} pending={pending} onSave={onSave} />
      )}

      {error ? (
        <p className="text-xs text-app-red-4" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function McpHealthMappingReview({
  connectionId,
  toolRef,
}: {
  connectionId: string;
  toolRef: ExternalToolRef;
}) {
  const controller = useMcpHealthMapping(connectionId, toolRef);

  return <McpHealthMappingView {...controller} />;
}
