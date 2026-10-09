import {
  boundPassthroughBody,
  canonicalJson,
  enumGuard,
  isIndexable,
  isRecord,
  jsonObjectSchema,
  mcpContentKindValues,
  toMessage,
  type BoundedPassthroughBody,
  type ExternalToolRef,
  type JsonObject,
  type JsonValue,
  type McpContentKind,
  type McpResultProvenance,
} from "@alfred/contracts";
import type {
  CacheScope,
  JsonSchemaType,
  JsonSchemaValidator,
  Tool,
} from "@modelcontextprotocol/client";
import { InsufficientScopeError } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { McpClientError } from "./errors";
import type {
  McpApiKeyCredentialReader,
  McpAuthorizedEndpoint,
  McpAuthorizedProtocol,
  McpEndpointAuthorizer,
  McpEndpointConnection,
  McpEndpointOAuthPolicy,
} from "./endpoint-authorization";
import { compareMcpToolNames, sha256Canonical } from "./hash";
import {
  McpOAuthAuthorizationRequiredError,
  type McpBoundOAuthSession,
  type McpOAuthSessionFactory,
} from "./oauth";
import type { McpTraceContext } from "./trace";
import {
  isMcpDescriptorMismatchError,
  isMcpSessionExpiredError,
  parseMcpNegotiatedServer,
  SdkMcpProtocolClient,
  type McpNegotiatedServer,
  type McpProtocolCallResult,
  type McpProtocolClient,
  type McpProtocolPage,
  type SdkMcpProtocolClientOptions,
} from "./protocol";

export interface McpCatalogSnapshot {
  connectionId: string;
  revision: string;
  tools: readonly Tool[];
  ttlMs: number;
  cacheScope: CacheScope;
}

export interface McpCallEnvelope {
  connectionId: string;
  toolName: string;
  catalogRevision: string;
  outcome: "completed" | "tool_error";
  result: unknown;
  truncation?: BoundedPassthroughBody["truncation"];
  /** Payload-free record of what the server returned. The broker stores it in the ledger. */
  provenance: McpResultProvenance;
}

export interface McpPreparedToolCall {
  catalog: McpCatalogSnapshot;
  call(
    ref: ExternalToolRef,
    args: unknown,
    options?: { signal?: AbortSignal; trace?: McpTraceContext },
  ): Promise<McpCallEnvelope>;
}

/** Tunable limits against a slow or hostile server. Fixed caps like `MAX_CATALOG_BYTES` are not tunable. */
export interface McpClientLimits {
  requestTimeoutMs?: number;
  maxCatalogPages?: number;
  maxCatalogTools?: number;
}

/**
 * A connection's single auth mode. Required, so a caller cannot forget it.
 * In production only `resolveMcpClientAuth` in `manager.ts` picks it.
 */
export type McpClientAuth =
  | { readonly mode: "none" }
  | { readonly mode: "api_key"; readonly reader: McpApiKeyCredentialReader }
  | { readonly mode: "oauth"; readonly provider: McpOAuthSessionFactory };

export interface McpRawClientOptions extends McpClientLimits {
  connectionId: string;
  /** The authorizer validates this on every connect. */
  endpoint: McpEndpointConnection;
  endpointAuthorizer: McpEndpointAuthorizer;
  /** Built-in OAuth endpoint policy; absent for user-added servers. */
  oauthPolicy?: McpEndpointOAuthPolicy | undefined;
  /** For `oauth`, the transport gets only the token, so it cannot refresh and replay `tools/call`. */
  auth: McpClientAuth;
  authProvider?: SdkMcpProtocolClientOptions["authProvider"];
  onAuthorizationRequired?: () => void | Promise<void>;
  onInsufficientScope?: (requiredScopes: string[]) => void | Promise<void>;
  now?: () => number;
  protocolFactory?: (authorization: McpAuthorizedProtocol) => McpProtocolClient;
  /**
   * Refuse the whole catalog unless every tool asserts `readOnlyHint === true` (ADR-0094).
   * Refuse, not drop: a write tool here means the server broke its contract.
   * Injected from `builtInClientPolicy`; this class does not know the registry.
   */
  readOnlyCatalog?: boolean | undefined;
  /** Negotiate the legacy `2025-11-25` era, which makes `x-mcp-header` inert (ADR-0095). */
  pinLegacyProtocol?: boolean | undefined;
}

/** Default per-request timeout. The OAuth routes use it too. */
export const MCP_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_MAX_CATALOG_PAGES = 100;

const DEFAULT_MAX_CATALOG_TOOLS = 1_000;

const MAX_CATALOG_BYTES = 1024 * 1024;

const MAX_TOOL_DESCRIPTOR_BYTES = 128 * 1024;

const MAX_SCHEMA_DEPTH = 32;

const MAX_SCHEMA_NODES = 5_000;

const MAX_SCHEMA_REGEX_CHARS = 2_048;

const encoder = new TextEncoder();

/** Ajv compiles patterns with `/u`. Fall back to non-Unicode only for a pattern that fails to compile. */
const MCP_SCHEMA_2020_12_URIS = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft/2020-12/schema",
]);

const MCP_SCHEMA_2019_09_URIS = new Set([
  "https://json-schema.org/draft/2019-09/schema",
  "http://json-schema.org/draft/2019-09/schema",
]);

const MCP_SCHEMA_DRAFT_07_URIS = new Set([
  "https://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-07/schema",
]);

const MCP_SCHEMA_DRAFT_06_URIS = new Set([
  "https://json-schema.org/draft-06/schema",
  "http://json-schema.org/draft-06/schema",
]);

interface McpSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T>;
}

function createSchemaValidator(): McpSchemaValidator {
  const unicodeFirstRegExp = Object.assign(
    (pattern: string, flags: string) => {
      try {
        return new RegExp(pattern, flags);
      } catch (error) {
        if (error instanceof SyntaxError) {
          return new RegExp(pattern);
        }

        throw error;
      }
    },
    {
      code: "new RegExp" as const,
    },
  );

  const options = {
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
    code: {
      regExp: unicodeFirstRegExp,
    },
  } as const;

  const draft7 = new Ajv(options);
  const draft2019 = new Ajv2019(options);
  const draft2020 = new Ajv2020(options);
  addFormats(draft7);
  addFormats(draft2019);
  addFormats(draft2020);

  const validators = {
    draft7: new AjvJsonSchemaValidator(draft7),
    draft2019: new AjvJsonSchemaValidator(draft2019),
    draft2020: new AjvJsonSchemaValidator(draft2020),
  };

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      const declaredSchema = "$schema" in schema ? schema.$schema : undefined;

      if (declaredSchema === undefined) {
        return validators.draft2020.getValidator<T>(schema);
      }

      const dialect = declaredSchema.replace(/#$/, "");

      if (MCP_SCHEMA_2020_12_URIS.has(dialect)) {
        return validators.draft2020.getValidator<T>(schema);
      }

      if (MCP_SCHEMA_2019_09_URIS.has(dialect)) {
        return validators.draft2019.getValidator<T>(schema);
      }

      if (MCP_SCHEMA_DRAFT_07_URIS.has(dialect) || MCP_SCHEMA_DRAFT_06_URIS.has(dialect)) {
        return validators.draft7.getValidator<T>(schema);
      }

      throw new Error(`Unsupported MCP JSON Schema dialect: ${dialect}`);
    },
  };
}

interface McpClientGeneration {
  readonly authorization: McpAuthorizedEndpoint;
  readonly protocol: McpProtocolClient;
  readonly oauth: McpBoundOAuthSession | null;
  negotiated: McpNegotiatedServer | null;
  unhealthy: Error | null;
  closeFlight: Promise<void> | null;
}

/** MCP client: lifecycle, catalog, schema validation, bounded results. No approvals, registry, or retries. */
export class McpRawClient {
  readonly #options: Omit<McpRawClientOptions, keyof McpClientLimits | "now"> & {
    now: () => number;
  };
  /** Limits with defaults applied. */
  readonly #limits: Required<McpClientLimits>;
  readonly #schemaValidator = createSchemaValidator();
  #generation: McpClientGeneration | null = null;
  /** Why the server dropped the last generation, so `not_connected` can name the real cause. */
  #lostError: Error | null = null;
  #catalog: McpCatalogSnapshot | null = null;
  #catalogExpiresAt = 0;
  #catalogGeneration = 0;
  #catalogInvalidatedHandler: (() => void) | null = null;
  #toolsByName = new Map<string, Tool>();
  #inputValidators = new Map<string, JsonSchemaValidator<JsonObject>>();
  #outputValidators = new Map<string, JsonSchemaValidator<JsonValue>>();
  #authorizationBlocked: McpClientError | null = null;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #cleanupTail: Promise<void> = Promise.resolve();

  constructor(options: McpRawClientOptions) {
    // Copy the endpoint so a caller's later mutation cannot change ours.
    const { requestTimeoutMs, maxCatalogPages, maxCatalogTools, now, ...wiring } = options;
    this.#options = {
      ...wiring,
      endpoint: {
        endpointUrl: options.endpoint.endpointUrl,
        endpointOrigin: options.endpoint.endpointOrigin,
      },
      now: now ?? Date.now,
    };
    this.#limits = {
      requestTimeoutMs: requestTimeoutMs ?? MCP_DEFAULT_REQUEST_TIMEOUT_MS,
      maxCatalogPages: maxCatalogPages ?? DEFAULT_MAX_CATALOG_PAGES,
      maxCatalogTools: maxCatalogTools ?? DEFAULT_MAX_CATALOG_TOOLS,
    };
  }

  get catalog(): McpCatalogSnapshot | null {
    return this.#catalog;
  }

  get negotiatedServer(): McpNegotiatedServer | null {
    return this.#generation?.negotiated ?? null;
  }

  onCatalogInvalidated(handler: () => void): void {
    this.#catalogInvalidatedHandler = handler;
  }

  /** Forget the local catalog so the next call fetches again. Used after a lost compare-and-set. */
  invalidateCatalogAuthority(): void {
    this.#invalidateCatalog();
  }

  connect(trace?: McpTraceContext): Promise<void> {
    return this.#runLifecycle(() => this.#connect(trace));
  }

  async #connect(trace?: McpTraceContext): Promise<void> {
    await this.#drainCleanup();

    if (this.#generation) return;
    let authorized: McpAuthorizedEndpoint | null = null;
    let protocol: McpProtocolClient | undefined;
    let oauth: McpBoundOAuthSession | null = null;

    try {
      const auth = this.#options.auth;

      authorized = await this.#options.endpointAuthorizer.authorize(
        this.#options.endpoint,
        {
          requestTimeoutMs: this.#limits.requestTimeoutMs,
        },
        auth.mode === "api_key" ? auth.reader : undefined,
        this.#options.oauthPolicy,
      );

      switch (auth.mode) {
        case "none":
        case "api_key":
          // An API key never contacts an authorization server, so no OAuth session.
          break;
        case "oauth":
          oauth = auth.provider(authorized.oauth);
          break;
        default: {
          const _exhaustive: never = auth;

          throw new Error(`unknown MCP auth mode: ${JSON.stringify(_exhaustive)}`);
        }
      }

      if (oauth) await oauth.authorize();
      const boundOAuth = oauth;
      protocol = this.#options.protocolFactory
        ? this.#options.protocolFactory(authorized.protocol)
        : new SdkMcpProtocolClient({
            authorization: authorized.protocol,
            requestTimeoutMs: this.#limits.requestTimeoutMs,
            schemaValidator: this.#schemaValidator,
            pinLegacyProtocol: this.#options.pinLegacyProtocol === true,
            ...(boundOAuth
              ? {
                  authProvider: {
                    token: () => boundOAuth.accessToken(),
                  },
                }
              : this.#options.authProvider
                ? { authProvider: this.#options.authProvider }
                : {}),
          });
    } catch (error) {
      if (protocol) await protocol.close(false).catch(() => undefined);
      await this.#closeAuthorization(authorized);
      throw error;
    }

    const generation: McpClientGeneration = {
      authorization: authorized,
      protocol,
      oauth,
      negotiated: null,
      unhealthy: null,
      closeFlight: null,
    };

    protocol.onToolsChanged(() => {
      if (this.#generation === generation) this.#announceCatalogInvalidated();
    });
    protocol.onConnectionUnhealthy((error) => {
      generation.unhealthy = error;
      const wasCurrent = this.#generation === generation;

      if (wasCurrent) {
        this.#generation = null;
        this.#lostError = error;
      }

      const cleanup = this.#closeGeneration(generation, false).catch(() => undefined);
      this.#registerCleanup(cleanup);

      if (wasCurrent) this.#announceCatalogInvalidated();
    });

    try {
      const server = await protocol.connect(trace);
      let negotiated: McpNegotiatedServer;

      try {
        negotiated = parseMcpNegotiatedServer(server);
      } catch (err) {
        throw new McpClientError("unsupported_protocol_version", toMessage(err));
      }

      if (generation.unhealthy) throw generation.unhealthy;

      if (!negotiated.hasTools) {
        throw new McpClientError(
          "missing_tools_capability",
          "The MCP server did not advertise the tools capability",
        );
      }

      generation.negotiated = negotiated;
    } catch (err) {
      await this.#closeGeneration(generation, false).catch(() => undefined);
      throw err;
    }

    this.#generation = generation;
    this.#lostError = null;
  }

  close(options: { terminateSession?: boolean } = {}): Promise<void> {
    return this.#runLifecycle(() => this.#close(options));
  }

  async #close(options: { terminateSession?: boolean }): Promise<void> {
    await this.#drainCleanup();
    const generation = this.#generation;
    this.#generation = null;
    this.#invalidateCatalog();

    if (generation) await this.#closeGeneration(generation, options.terminateSession === true);
  }

  async refreshCatalog(signal?: AbortSignal, trace?: McpTraceContext): Promise<McpCatalogSnapshot> {
    const generation = this.#requireGeneration();
    const protocol = generation.protocol;

    if (this.#catalog && this.#options.now() < this.#catalogExpiresAt) {
      return this.#catalog;
    }

    const refreshGeneration = this.#catalogGeneration;
    const tools: Tool[] = [];
    const names = new Set<string>();
    const seenCursors = new Set<string>();
    let catalogBytes = 0;
    let ttlMs = 0;
    let cacheScope: CacheScope = "private";
    let cursor: string | undefined;

    for (let pageNumber = 1; ; pageNumber++) {
      if (pageNumber > this.#limits.maxCatalogPages) {
        throw new McpClientError(
          "catalog_limit",
          `MCP catalog exceeded ${this.#limits.maxCatalogPages} pages`,
        );
      }

      const page: McpProtocolPage = await protocol
        .listTools(cursor, signal, trace)
        .catch((err: unknown) => this.#throwProtocolError(err, generation));

      if (pageNumber === 1) {
        ttlMs = page.ttlMs;
        cacheScope = page.cacheScope;
      }

      for (const tool of page.tools) {
        assertAdmissibleToolDescriptor(tool, {
          readOnlyCatalog: this.#options.readOnlyCatalog === true,
          // Read the negotiated era, not the pin. `!== false` keeps the gate closed with no negotiation.
          mirrorsParamHeaders: generation.negotiated?.mirrorsParamHeaders !== false,
        });
        const descriptorBytes = encodedBytes(canonicalJson(tool));

        if (descriptorBytes > MAX_TOOL_DESCRIPTOR_BYTES) {
          throw new McpClientError(
            "catalog_limit",
            `MCP tool '${tool.name}' descriptor exceeded ${MAX_TOOL_DESCRIPTOR_BYTES} bytes`,
          );
        }

        catalogBytes += descriptorBytes;

        if (catalogBytes > MAX_CATALOG_BYTES) {
          throw new McpClientError(
            "catalog_limit",
            `MCP catalog exceeded ${MAX_CATALOG_BYTES} descriptor bytes`,
          );
        }

        if (names.has(tool.name)) {
          throw new McpClientError("duplicate_tool", `MCP catalog repeated tool '${tool.name}'`);
        }

        names.add(tool.name);
        tools.push(tool);

        if (tools.length > this.#limits.maxCatalogTools) {
          throw new McpClientError(
            "catalog_limit",
            `MCP catalog exceeded ${this.#limits.maxCatalogTools} tools`,
          );
        }
      }

      const nextCursor = page.nextCursor;

      if (!nextCursor) break;

      if (seenCursors.has(nextCursor)) {
        throw new McpClientError("catalog_limit", "MCP catalog repeated a pagination cursor");
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    const sortedTools = Object.freeze(
      tools
        .map((tool) => deepFreeze(structuredClone(tool)))
        // Code-point order, not `localeCompare`: ICU collation varies by host and would change the hash.
        .sort((a, b) => compareMcpToolNames(a.name, b.name)),
    );

    const revision = sha256Canonical(sortedTools);
    const nextToolsByName = new Map(sortedTools.map((tool) => [tool.name, tool]));
    const nextInputValidators = new Map<string, JsonSchemaValidator<JsonObject>>();
    const nextOutputValidators = new Map<string, JsonSchemaValidator<JsonValue>>();

    for (const tool of sortedTools) {
      let validator: JsonSchemaValidator<JsonObject>;

      try {
        validator = this.#schemaValidator.getValidator<JsonObject>(
          // SAFETY: `inputSchema` is the MCP JSON Schema envelope the validator expects.
          tool.inputSchema as JsonSchemaType,
        );
      } catch (err) {
        throw new McpClientError(
          "invalid_schema",
          `MCP tool '${tool.name}' has an input schema Alfred cannot compile: ${toMessage(err)}`,
        );
      }

      nextInputValidators.set(tool.name, validator);

      if (tool.outputSchema) {
        try {
          nextOutputValidators.set(
            tool.name,
            // SAFETY: same MCP schema-envelope view as the input validator.
            this.#schemaValidator.getValidator<JsonValue>(tool.outputSchema as JsonSchemaType),
          );
        } catch (err) {
          throw new McpClientError(
            "invalid_schema",
            `MCP tool '${tool.name}' has an output schema Alfred cannot compile: ${toMessage(err)}`,
          );
        }
      }
    }

    if (refreshGeneration !== this.#catalogGeneration) {
      throw new McpClientError(
        "catalog_stale",
        "The MCP catalog changed while Alfred was refreshing it; retry the refresh",
      );
    }

    this.#toolsByName = nextToolsByName;
    this.#inputValidators = nextInputValidators;
    this.#outputValidators = nextOutputValidators;
    this.#catalog = Object.freeze({
      connectionId: this.#options.connectionId,
      revision,
      tools: sortedTools,
      ttlMs,
      cacheScope,
    });
    this.#catalogExpiresAt = this.#options.now() + ttlMs;

    return this.#catalog;
  }

  async callTool(
    ref: ExternalToolRef,
    args: unknown,
    options: { signal?: AbortSignal; trace?: McpTraceContext } = {},
  ): Promise<McpCallEnvelope> {
    const prepared = await this.prepareToolCall(options.signal, options.trace);

    return prepared.call(ref, args, options);
  }

  async prepareToolCall(
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpPreparedToolCall> {
    const generation = this.#requireGeneration();

    if (generation.oauth) {
      try {
        await generation.oauth.refreshIfNeeded();
      } catch (error) {
        if (error instanceof McpOAuthAuthorizationRequiredError) {
          await this.#options.onAuthorizationRequired?.();
        }

        throw error;
      }
    }

    const catalog = await this.refreshCatalog(signal, trace);
    const catalogGeneration = this.#catalogGeneration;

    return Object.freeze({
      catalog,
      call: (
        ref: ExternalToolRef,
        args: unknown,
        options: { signal?: AbortSignal; trace?: McpTraceContext } = {},
      ) => this.#callPreparedTool(catalogGeneration, catalog, ref, args, options),
    });
  }

  async #callPreparedTool(
    catalogGeneration: number,
    catalog: McpCatalogSnapshot,
    ref: ExternalToolRef,
    args: unknown,
    options: { signal?: AbortSignal; trace?: McpTraceContext },
  ): Promise<McpCallEnvelope> {
    const generation = this.#requireGeneration();
    const protocol = generation.protocol;

    if (this.#authorizationBlocked) throw this.#authorizationBlocked;

    if (catalogGeneration !== this.#catalogGeneration || this.#catalog !== catalog) {
      throw new McpClientError(
        "catalog_required",
        "The MCP catalog changed after this tool call was prepared; refresh and reselect it",
      );
    }

    if (ref.connectionId !== this.#options.connectionId) {
      throw new McpClientError("unknown_tool", "The MCP tool belongs to another connection");
    }

    if (ref.catalogRevision !== catalog.revision) {
      throw new McpClientError(
        "catalog_stale",
        "The MCP catalog changed after this tool was selected; refresh and reselect it",
      );
    }

    const tool = this.#toolsByName.get(ref.remoteName);
    const validator = this.#inputValidators.get(ref.remoteName);

    if (!tool || !validator) {
      throw new McpClientError("unknown_tool", `Unknown MCP tool '${ref.remoteName}'`);
    }

    const jsonArgs = jsonObjectSchema.safeParse(args);

    if (!jsonArgs.success) {
      throw new McpClientError(
        "invalid_arguments",
        `Arguments for MCP tool '${tool.name}' must be a JSON object`,
      );
    }

    const validated = validator(jsonArgs.data);

    if (!validated.valid) {
      throw new McpClientError(
        "invalid_arguments",
        `Arguments for MCP tool '${tool.name}' failed its imported schema: ${validated.errorMessage}`,
      );
    }

    const result: McpProtocolCallResult = await protocol
      .callTool(tool, validated.data, options.signal, options.trace)
      .catch((err: unknown) => this.#throwProtocolError(err, generation));

    const isToolError = result.isError === true;
    const outputValidator = this.#outputValidators.get(tool.name);
    let outputSchemaValidated = false;

    if (!isToolError && outputValidator) {
      const structuredContent = result.structuredContent;
      const output = outputValidator(structuredContent);

      if (!output.valid) {
        // A response arrived, so attach provenance for the broker's ambiguous branch.
        throw new McpClientError(
          "invalid_output",
          `Result from MCP tool '${tool.name}' failed its declared output schema: ${output.errorMessage}`,
          {
            provenance: resultProvenance(result, {
              isToolError,
              outputSchemaValidated: false,
              truncated: false,
            }),
          },
        );
      }

      outputSchemaValidated = true;
    }

    const bounded = boundPassthroughBody(result);

    return {
      connectionId: this.#options.connectionId,
      toolName: tool.name,
      catalogRevision: catalog.revision,
      outcome: isToolError ? "tool_error" : "completed",
      result: bounded.value,
      provenance: resultProvenance(result, {
        isToolError,
        outputSchemaValidated,
        truncated: Boolean(bounded.truncation),
      }),
      ...(bounded.truncation ? { truncation: bounded.truncation } : {}),
    };
  }

  #requireGeneration(): McpClientGeneration {
    if (!this.#generation) {
      // `boundedMcpErrorText` renders the cause chain, so the lost error rides as the cause.
      throw this.#lostError
        ? new McpClientError("not_connected", "The MCP client lost its connection", {
            cause: this.#lostError,
          })
        : new McpClientError("not_connected", "The MCP client is not connected");
    }

    return this.#generation;
  }

  #invalidateCatalog(): void {
    this.#catalogGeneration += 1;
    this.#catalog = null;
    this.#catalogExpiresAt = 0;
    this.#toolsByName.clear();
    this.#inputValidators.clear();
    this.#outputValidators.clear();
  }

  #announceCatalogInvalidated(): void {
    this.#invalidateCatalog();
    this.#catalogInvalidatedHandler?.();
  }

  async #throwProtocolError(err: unknown, generation: McpClientGeneration): Promise<never> {
    if (err instanceof InsufficientScopeError) {
      const requiredScopes =
        err.requiredScope
          ?.split(/\s+/)
          .filter((scope) => /^[A-Za-z0-9._:/-]{1,200}$/.test(scope))
          .slice(0, 50) ?? [];

      await this.#options.onInsufficientScope?.(requiredScopes);

      const detail =
        requiredScopes.length > 0
          ? ` Additional permissions required: ${requiredScopes.join(", ")}.`
          : "";

      this.#authorizationBlocked = new McpClientError(
        "insufficient_scope",
        `The MCP connection needs renewed consent.${detail}`,
      );
      throw this.#authorizationBlocked;
    }

    if (isMcpDescriptorMismatchError(err)) {
      this.#announceCatalogInvalidated();
      throw new McpClientError(
        "descriptor_mismatch",
        "The MCP server rejected the admitted tool descriptor; refresh and reselect it",
      );
    }

    if (generation.negotiated?.protocolEra !== "pre_2026_07_28" || !isMcpSessionExpiredError(err)) {
      throw err;
    }

    if (this.#generation === generation) {
      this.#generation = null;
      this.#invalidateCatalog();
    }

    const cleanup = this.#closeGeneration(generation, false).catch(() => undefined);
    this.#registerCleanup(cleanup);
    await cleanup;
    throw new McpClientError(
      "session_expired",
      "The MCP session expired; reconnect and refresh the catalog before retrying",
    );
  }

  #closeGeneration(generation: McpClientGeneration, terminateSession: boolean): Promise<void> {
    return (generation.closeFlight ??= (async () => {
      try {
        await generation.protocol.close(terminateSession);
      } finally {
        await this.#closeAuthorization(generation.authorization);
      }
    })());
  }

  async #closeAuthorization(authorization: McpAuthorizedEndpoint | null): Promise<void> {
    await authorization?.close().catch(() => undefined);
  }

  #registerCleanup(cleanup: Promise<void>): void {
    const prior = this.#cleanupTail;
    this.#cleanupTail = Promise.all([prior, cleanup]).then(() => undefined);
  }

  async #drainCleanup(): Promise<void> {
    for (;;) {
      const cleanup = this.#cleanupTail;
      await cleanup;

      if (cleanup === this.#cleanupTail) return;
    }
  }

  #runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#lifecycleTail.then(operation, operation);
    this.#lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}

const isMcpContentKind = enumGuard(mcpContentKindValues);

/** Map a content block to a closed kind. `unknown` is the fallback, never the server's own string. */
function contentKindOf(block: McpProtocolCallResult["content"][number]): McpContentKind {
  return isMcpContentKind(block.type) ? block.type : "unknown";
}

/** Count content blocks by `type` and record validity. Never stores content or follows a resource link. */
function resultProvenance(
  result: McpProtocolCallResult,
  facts: { isToolError: boolean; outputSchemaValidated: boolean; truncated: boolean },
): McpResultProvenance {
  const content = result.content;
  const contentKinds: Partial<Record<McpContentKind, number>> = {};

  for (const block of content) {
    const kind = contentKindOf(block);
    contentKinds[kind] = (contentKinds[kind] ?? 0) + 1;
  }

  return {
    isError: facts.isToolError,
    hasStructuredContent: result.structuredContent !== undefined,
    outputSchemaValidated: facts.outputSchemaValidated,
    contentBlockCount: content.length,
    contentKinds,
    truncated: facts.truncated,
  };
}

function encodedBytes(value: string): number {
  return encoder.encode(value).length;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
  }

  // Freeze every object, not only plain records: `structuredClone` keeps Dates.
  if (isIndexable(value)) Object.freeze(value);

  return value;
}

interface ToolAdmissionPolicy {
  /** Every descriptor must assert `annotations.readOnlyHint === true` (ADR-0094). */
  readOnlyCatalog: boolean;
  /** The negotiated era turns `x-mcp-header` into `Mcp-Param-*` headers, so refuse it (ADR-0095). */
  mirrorsParamHeaders: boolean;
}

function assertAdmissibleToolDescriptor(tool: Tool, policy: ToolAdmissionPolicy): void {
  if (tool.name.length === 0 || tool.name.length > 128 || hasAsciiControlCharacter(tool.name)) {
    throw new McpClientError(
      "invalid_schema",
      "MCP tool name must be 1-128 characters with no control characters",
    );
  }

  // A missing hint fails like `false`: annotations are optional, so silence claims nothing.
  if (policy.readOnlyCatalog && tool.annotations?.readOnlyHint !== true) {
    throw new McpClientError(
      "write_tool",
      `MCP tool '${tool.name}' does not assert annotations.readOnlyHint, and this endpoint serves a read-only catalog`,
    );
  }

  assertSafeSchema(tool.name, "input", tool.inputSchema, policy);

  if (tool.outputSchema) assertSafeSchema(tool.name, "output", tool.outputSchema, policy);
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }

  return false;
}

function assertSafeSchema(
  toolName: string,
  direction: "input" | "output",
  schema: unknown,
  policy: ToolAdmissionPolicy,
): void {
  let nodes = 0;

  const visit = (value: unknown, depth: number): void => {
    nodes += 1;

    if (depth > MAX_SCHEMA_DEPTH || nodes > MAX_SCHEMA_NODES) {
      throw new McpClientError(
        "invalid_schema",
        `MCP tool '${toolName}' ${direction} schema exceeds Alfred's complexity limits`,
      );
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);

      return;
    }

    if (!isRecord(value)) return;

    for (const [key, child] of Object.entries(value)) {
      // Refuse `$id`/`$anchor`: Ajv caches validators by `$id`, so a later tool
      // could reuse a lenient cached schema instead of its own.
      if (key === "$id" || key === "$anchor") {
        throw new McpClientError(
          "invalid_schema",
          `MCP tool '${toolName}' ${direction} schema declares a forbidden ${key}`,
        );
      }

      // `x-mcp-header` copies model-filled arguments into `Mcp-Param-*` headers, an
      // unreviewed channel. Only the modern era does this; the legacy era is safe (ADR-0095).
      if (key === "x-mcp-header" && policy.mirrorsParamHeaders) {
        throw new McpClientError(
          "invalid_schema",
          `MCP tool '${toolName}' ${direction} schema declares x-mcp-header, which the negotiated protocol era mirrors into a request header`,
        );
      }

      if (
        (key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") &&
        (typeof child !== "string" || !child.startsWith("#"))
      ) {
        throw new McpClientError(
          "invalid_schema",
          `MCP tool '${toolName}' ${direction} schema contains a non-local ${key}`,
        );
      }

      if (key === "pattern" && typeof child === "string" && child.length > MAX_SCHEMA_REGEX_CHARS) {
        throw new McpClientError(
          "invalid_schema",
          `MCP tool '${toolName}' ${direction} schema contains an oversized regex`,
        );
      }

      if (key === "patternProperties" && isRecord(child)) {
        for (const pattern of Object.keys(child)) {
          if (pattern.length > MAX_SCHEMA_REGEX_CHARS) {
            throw new McpClientError(
              "invalid_schema",
              `MCP tool '${toolName}' ${direction} schema contains an oversized regex`,
            );
          }
        }
      }

      visit(child, depth + 1);
    }
  };

  visit(schema, 0);
}
