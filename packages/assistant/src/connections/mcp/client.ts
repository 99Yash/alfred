import {
  assertNever,
  canonicalJson,
  enumGuard,
  isIndexable,
  isNonEmptyString,
  isRecord,
  jsonObjectSchema,
  mcpContentKindValues,
  sanitizeToolResult,
  toMessage,
  type ExternalToolRef,
  type JsonObject,
  type JsonValue,
  type McpContentKind,
  type McpResultProvenance,
} from "@alfred/contracts";
import { sha256Canonical } from "@alfred/db/hash";
import { AsyncLocalStorage } from "node:async_hooks";
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
import RE2 from "re2";
import {
  boundedMcpErrorText,
  isMcpAuthorizationChallenge,
  McpClientError,
  type McpClientErrorCode,
} from "./errors";
import type {
  McpApiKeyCredentialReader,
  McpAuthorizedEndpoint,
  McpAuthorizedProtocol,
  McpEndpointAuthorizer,
  McpEndpointConnection,
} from "./endpoint-authorization";
import { compareMcpToolNames } from "./hash";
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
  /**
   * Set only for a connection with a read endpoint (ADR-0130 decision 9): the tools whose
   * descriptor came from that endpoint, in `compareMcpToolNames` order. A call to one of them goes
   * to the read endpoint. Empty when this refresh dropped the read side.
   */
  readEndpointTools?: readonly string[];
  /** Why this refresh dropped the read side, for the owner. Not part of the revision. */
  readEndpointFault?: string;
}

interface McpCallEnvelopeFields {
  connectionId: string;
  toolName: string;
  catalogRevision: string;
  outcome: "completed" | "tool_error";
  /** Payload-free record of what the server returned. The broker stores it in the ledger. */
  provenance: McpResultProvenance;
  /** A raw response held bytes. Computed before bounds; absent when it held none. */
  hasBinaryContent?: true;
}

/**
 * The whole sanitized response. The client does not bound its size: the recipient does (ADR-0124
 * amendment 2026-11-18 (b)). A direct `mcp.call` applies the ADR-0074 bounds before the model
 * sees the result, and a script read gets the value up to the host's delivery cap.
 */
export type McpCallEnvelope = McpCallEnvelopeFields & { result: McpProtocolCallResult };

interface McpToolCallOptions {
  signal?: AbortSignal;
  trace?: McpTraceContext;
  /**
   * `structured`: the caller is code that parses only `structuredContent`. When the server sent it,
   * the client drops `content` before the bounds. The MCP spec asks a server to repeat the structured
   * result as text, and a clipped text copy must not reject a whole structured result.
   */
  result?: "full" | "structured";
}

export interface McpPreparedToolCall {
  catalog: McpCatalogSnapshot;
  call(ref: ExternalToolRef, args: unknown, options?: McpToolCallOptions): Promise<McpCallEnvelope>;
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
  | { readonly mode: "oauth"; readonly provider: McpOAuthSessionFactory }
  | { readonly mode: "borrowed"; readonly session: McpTokenSession };

/**
 * The token half of a session: what the transport and the 401 path read. An OAuth session is one.
 * A `borrowed` session reads another credential's token and holds no grant (ADR-0126).
 * `refreshIfNeeded` runs before each call, so it must throw `McpOAuthAuthorizationRequiredError`
 * when only the user can repair the credential. The call then never starts.
 */
export type McpTokenSession = Pick<
  McpBoundOAuthSession,
  "refreshIfNeeded" | "renewRejectedToken" | "accessToken"
>;

export interface McpRawClientOptions extends McpClientLimits {
  connectionId: string;
  /** The authorizer validates this on every connect. */
  endpoint: McpEndpointConnection;
  endpointAuthorizer: McpEndpointAuthorizer;
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
  /**
   * A built-in read-only resource beside this endpoint (ADR-0130 decision 9). The client lists it
   * with this connection's token and the ADR-0094 rule. Each tool that it lists replaces the main
   * descriptor of that name, and a call to that tool goes to it. A failed listing drops the read
   * side for that refresh and never refuses the main catalog. Injected from `builtInClientPolicy`.
   */
  readEndpoint?: McpEndpointConnection | undefined;
}

/** Default per-request timeout. The OAuth routes use it too. */
export const MCP_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** The owner-facing text when only a new consent can bring the connection back. */
export const MCP_RECONNECT_MESSAGE = "Reconnect this MCP server to continue.";

const DEFAULT_MAX_CATALOG_PAGES = 100;

const DEFAULT_MAX_CATALOG_TOOLS = 1_000;

const MAX_CATALOG_BYTES = 1024 * 1024;

const MAX_TOOL_DESCRIPTOR_BYTES = 128 * 1024;

const MAX_SCHEMA_DEPTH = 32;

const MAX_SCHEMA_NODES = 5_000;

const MAX_SCHEMA_REGEX_CHARS = 2_048;

const encoder = new TextEncoder();

/**
 * Compile a server-written schema regex on RE2, a linear-time engine (#1865). The native engine
 * backtracks, so a pattern such as `^(a+)+$` on a short value would block the event loop, and no
 * timeout stops a synchronous regex. Ajv compiles with `/u`; fall back to non-Unicode only for a
 * pattern that fails to compile. RE2 refuses lookaround and backreferences, so admission refuses
 * a pattern that compiles in neither mode (`assertSafeSchema`).
 */
function compileSchemaPattern(pattern: string, flags: string): RE2 {
  try {
    return new RE2(pattern, flags);
  } catch (error) {
    if (error instanceof SyntaxError) return new RE2(pattern);

    throw error;
  }
}

function compilesOnRe2(pattern: string): boolean {
  try {
    compileSchemaPattern(pattern, "u");

    return true;
  } catch {
    return false;
  }
}

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

/** A schema from an MCP tool listing: its `inputSchema`, or its `outputSchema` when present. */
type McpToolSchema = Tool["inputSchema"] | NonNullable<Tool["outputSchema"]>;

interface McpSchemaValidator {
  getValidator<T>(toolSchema: McpToolSchema): JsonSchemaValidator<T>;
}

function createSchemaValidator(): McpSchemaValidator {
  // The only Ajv instances that read server-written schemas. `code` names the engine only for
  // Ajv's standalone code output, which Alfred does not use.
  const re2RegExp = Object.assign(
    (pattern: string, flags: string) => compileSchemaPattern(pattern, flags),
    { code: 'require("re2")' },
  );

  const options = {
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
    code: {
      regExp: re2RegExp,
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
    getValidator<T>(toolSchema: McpToolSchema): JsonSchemaValidator<T> {
      // SAFETY: the MCP SDK types a listed tool schema as an open object and the validator input as
      // `JsonSchemaType`; no guard can prove one from the other. Ajv compiles it, and a compile
      // error becomes `invalid_schema` at the caller.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an MCP SDK type gap; Ajv compiles the schema
      const schema = toolSchema as JsonSchemaType;
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

/** The access token one request sent. A 401 renews only that token, never a newer one. */
interface SentAccessToken {
  token: string | undefined;
}

/** The transport reads the token inside the request's async context, so each request sees its own slot. */
const sentAccessTokens = new AsyncLocalStorage<SentAccessToken>();

/** One protocol request and the slot that records its access token. */
interface TokenedRequest<T> {
  sent: SentAccessToken;
  result: Promise<T>;
}

/** Run one protocol request and record the access token it sent. */
function sendWithToken<T>(request: () => Promise<T>): TokenedRequest<T> {
  const sent: SentAccessToken = { token: undefined };

  return { sent, result: sentAccessTokens.run(sent, request) };
}

interface McpClientGeneration {
  readonly authorization: McpAuthorizedEndpoint;
  readonly protocol: McpProtocolClient;
  readonly oauth: McpTokenSession | null;
  /** The read endpoint's client. It borrows this generation's token and closes with it. */
  readSide: McpReadSide | null;
  negotiated: McpNegotiatedServer | null;
  unhealthy: Error | null;
  authorizationBlocked: McpClientError | null;
  closeFlight: Promise<void> | null;
}

/**
 * The read endpoint's client of one generation. `listings` counts the refreshes that list it now:
 * a fault during a listing belongs to that refresh, so the client does not invalidate the parent.
 */
interface McpReadSide {
  readonly client: McpRawClient;
  listings: number;
}

/**
 * The read side that served one catalog. `prepared` is the call that its listing prepared, so a
 * routed call runs on that exact read catalog and never lists the read endpoint again.
 */
interface McpReadRoute {
  readonly side: McpReadSide;
  readonly prepared: McpPreparedToolCall;
  readonly names: ReadonlySet<string>;
}

type McpReadSideListing =
  | {
      readonly kind: "listed";
      readonly side: McpReadSide;
      readonly prepared: McpPreparedToolCall;
      /** The read catalog's own expiry: a cached read catalog has less time left than its TTL. */
      readonly expiresAt: number;
    }
  | { readonly kind: "dropped"; readonly fault: string };

/**
 * The deadline of one read-side attempt: the handshake and the listing. The read side is optional,
 * so a slow read endpoint must not hold a call for the full request timeout. At the deadline the
 * refresh drops the read side and serves the main catalog.
 */
const READ_SIDE_DEADLINE_MS = 10_000;

/** A read catalog that changes during its listing gets one more listing before the read side drops. */
const READ_SIDE_LISTING_ATTEMPTS = 2;

/**
 * Read-side errors after which the read client cannot serve the next call: its session or its
 * grant is blocked. The client drops it, and the next refresh opens a fresh read side.
 */
const READ_SIDE_DROP_CODES: ReadonlySet<McpClientErrorCode> = new Set([
  "not_connected",
  "session_expired",
  "authorization_required",
  "insufficient_scope",
]);

/** Read-side errors that say the read catalog moved. The read client is sound; the catalog is not. */
const READ_CATALOG_MOVED_CODES: ReadonlySet<McpClientErrorCode> = new Set([
  "catalog_stale",
  "catalog_required",
  "descriptor_mismatch",
]);

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
  /** The read side that served the current catalog, or `null`. Set and cleared with `#catalog`. */
  #readRoute: McpReadRoute | null = null;
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

  /** When {@link catalog} expires, on the `now` clock. `0` with no catalog. */
  get catalogExpiresAt(): number {
    return this.#catalogExpiresAt;
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

  connect(trace?: McpTraceContext, signal?: AbortSignal): Promise<void> {
    return this.#runLifecycle(() => this.#connect(trace, signal));
  }

  async #connect(trace?: McpTraceContext, signal?: AbortSignal): Promise<void> {
    await this.#drainCleanup();

    if (this.#generation) return;
    let authorized: McpAuthorizedEndpoint | null = null;
    let protocol: McpProtocolClient | undefined;
    let oauth: McpTokenSession | null = null;

    try {
      const auth = this.#options.auth;

      authorized = await this.#options.endpointAuthorizer.authorize(
        this.#options.endpoint,
        {
          requestTimeoutMs: this.#limits.requestTimeoutMs,
        },
        auth.mode === "api_key" ? auth.reader : undefined,
      );

      switch (auth.mode) {
        case "none":
        case "api_key":
          // An API key never contacts an authorization server, so no OAuth session.
          break;
        case "oauth": {
          const bound = auth.provider(authorized.oauth);

          oauth = bound;

          await bound.authorize();
          break;
        }

        case "borrowed":
          // No consent here: the owner of the credential asks for it. Fail before the handshake.
          oauth = auth.session;

          await auth.session.refreshIfNeeded();
          break;
        default:
          assertNever(auth, "MCP auth mode");
      }

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
                    token: async () => {
                      const token = await boundOAuth.accessToken();
                      const sent = sentAccessTokens.getStore();

                      if (sent) sent.token = token;

                      return token;
                    },
                  },
                }
              : this.#options.authProvider
                ? { authProvider: this.#options.authProvider }
                : {}),
          });
    } catch (error) {
      // oxlint-disable-next-line alfred/no-swallowed-catch -- best-effort close after a failed open; the open fault is rethrown below
      if (protocol) await protocol.close(false).catch(() => undefined);
      await this.#closeAuthorization(authorized);
      throw error;
    }

    const generation: McpClientGeneration = {
      authorization: authorized,
      protocol,
      oauth,
      readSide: null,
      negotiated: null,
      unhealthy: null,
      authorizationBlocked: null,
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

      // oxlint-disable-next-line alfred/no-swallowed-catch -- best-effort close of a connection that is already unhealthy; the next call sees `#lostError`
      const cleanup = this.#closeGeneration(generation, false).catch(() => undefined);
      this.#registerCleanup(cleanup);

      if (wasCurrent) this.#announceCatalogInvalidated();
    });

    const handshake = sendWithToken(() => protocol.connect(trace, signal));

    try {
      const server = await handshake.result;
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
      // Renew first: the close destroys the dispatcher that the token request uses.
      const renewal = isMcpAuthorizationChallenge(err)
        ? await this.#renewRejectedToken(oauth, handshake.sent.token)
        : null;

      // oxlint-disable-next-line alfred/no-swallowed-catch -- best-effort close after a failed handshake; the handshake fault is rethrown below
      await this.#closeGeneration(generation, false).catch(() => undefined);
      throw renewal ?? err;
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

      const request = sendWithToken(() => protocol.listTools(cursor, signal, trace));

      const page: McpProtocolPage = await request.result.catch((err: unknown) =>
        this.#throwProtocolError(err, generation, request.sent),
      );

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

    let readSide = await this.#listReadSide(generation, signal, trace);
    let mergedTools: readonly Tool[] = tools;

    if (readSide?.kind === "listed") {
      try {
        mergedTools = this.#mergeReadEndpointTools(tools, readSide.prepared.catalog.tools);
        // The merged catalog lives no longer than the read catalog that it holds.
        ttlMs = Math.min(ttlMs, Math.max(0, readSide.expiresAt - this.#options.now()));
      } catch (error) {
        if (!(error instanceof McpClientError)) throw error;

        // The main listing passed the caps alone, so the read side caused the excess: drop it.
        this.#dropReadSide(generation, readSide.side);
        readSide = { kind: "dropped", fault: boundedMcpErrorText(error) };
      }
    }

    const sortedTools = Object.freeze(
      mergedTools
        .map((tool) => deepFreeze(structuredClone(tool)))
        // Code-point order, not `localeCompare`: ICU collation varies by host and would change the hash.
        .toSorted((a, b) => compareMcpToolNames(a.name, b.name)),
    );

    const readEndpointTools = Object.freeze(
      readSide?.kind === "listed" ? readSide.prepared.catalog.tools.map((tool) => tool.name) : [],
    );

    // The route is authority, so the revision covers it. With no read endpoint the formula stays
    // the descriptors alone, so existing revisions keep their hash.
    const revision =
      readSide === null
        ? sha256Canonical(sortedTools)
        : sha256Canonical({ tools: sortedTools, readEndpointTools });

    const nextToolsByName = new Map(sortedTools.map((tool) => [tool.name, tool]));
    const nextInputValidators = new Map<string, JsonSchemaValidator<JsonObject>>();
    const nextOutputValidators = new Map<string, JsonSchemaValidator<JsonValue>>();

    for (const tool of sortedTools) {
      let validator: JsonSchemaValidator<JsonObject>;

      try {
        validator = this.#schemaValidator.getValidator<JsonObject>(tool.inputSchema);
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
            this.#schemaValidator.getValidator<JsonValue>(tool.outputSchema),
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
    this.#readRoute =
      readSide?.kind === "listed"
        ? { side: readSide.side, prepared: readSide.prepared, names: new Set(readEndpointTools) }
        : null;
    this.#catalog = Object.freeze({
      connectionId: this.#options.connectionId,
      revision,
      tools: sortedTools,
      ttlMs,
      cacheScope,
      ...(readSide === null ? {} : { readEndpointTools }),
      ...(readSide?.kind === "dropped" ? { readEndpointFault: readSide.fault } : {}),
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

    // A new consent opens a fresh client. Do not republish this blocked client as ready.
    if (generation.authorizationBlocked) throw generation.authorizationBlocked;

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
      call: (ref: ExternalToolRef, args: unknown, options: McpToolCallOptions = {}) =>
        this.#callPreparedTool(catalogGeneration, catalog, ref, args, options),
    });
  }

  async #callPreparedTool(
    catalogGeneration: number,
    catalog: McpCatalogSnapshot,
    ref: ExternalToolRef,
    args: unknown,
    options: McpToolCallOptions,
  ): Promise<McpCallEnvelope> {
    const generation = this.#requireGeneration();
    const protocol = generation.protocol;

    if (generation.authorizationBlocked) throw generation.authorizationBlocked;

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
        "arguments_rejected",
        `Arguments for MCP tool '${tool.name}' must be a JSON object`,
      );
    }

    const validated = validator(jsonArgs.data);

    if (!validated.valid) {
      throw new McpClientError(
        "arguments_rejected",
        `Arguments for MCP tool '${tool.name}' failed its imported schema: ${validated.errorMessage}`,
      );
    }

    const readRoute = this.#readRoute;

    if (readRoute?.names.has(tool.name)) {
      return this.#callReadEndpoint(readRoute, catalog, ref, validated.data, options);
    }

    const request = sendWithToken(() =>
      protocol.callTool(tool, validated.data, options.signal, options.trace),
    );

    const result: McpProtocolCallResult = await request.result.catch((err: unknown) =>
      this.#throwProtocolError(err, generation, request.sent),
    );

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
            provenance: resultProvenance(result, { isToolError, outputSchemaValidated: false }),
          },
        );
      }

      outputSchemaValidated = true;
    }

    // Computed here, so the kind survives a later bound that drops a block or a resource's blob.
    const hasBinaryContent = result.content.some(
      (block) =>
        block.type === "image" ||
        block.type === "audio" ||
        (block.type === "resource" && "blob" in block.resource),
    );

    const kept =
      options.result === "structured" && result.structuredContent !== undefined
        ? { ...result, content: [] }
        : result;

    // Sanitize only (NUL, lone surrogates). The size bound is at the recipient (ADR-0124
    // amendment 2026-11-18 (b)), so a script can read a large single result.
    const sanitized = sanitizeToolResult(kept).value;

    const fields: McpCallEnvelopeFields = {
      connectionId: this.#options.connectionId,
      toolName: tool.name,
      catalogRevision: catalog.revision,
      outcome: isToolError ? "tool_error" : "completed",
      ...(hasBinaryContent ? { hasBinaryContent: true } : {}),
      provenance: resultProvenance(result, { isToolError, outputSchemaValidated }),
    };

    return { ...fields, result: sanitized };
  }

  /**
   * The union of the main and the read-endpoint tools. A read-endpoint descriptor replaces the
   * main one, so the model sees what that endpoint runs. A read-endpoint tool that the main
   * endpoint does not list adds to the union, so the union must hold the catalog caps again.
   */
  #mergeReadEndpointTools(mainTools: readonly Tool[], readTools: readonly Tool[]): Tool[] {
    const merged = new Map(mainTools.map((tool) => [tool.name, tool]));

    for (const tool of readTools) merged.set(tool.name, tool);

    if (merged.size > this.#limits.maxCatalogTools) {
      throw new McpClientError(
        "catalog_limit",
        `MCP catalog exceeded ${this.#limits.maxCatalogTools} tools`,
      );
    }

    let catalogBytes = 0;

    for (const tool of merged.values()) {
      catalogBytes += encodedBytes(canonicalJson(tool));

      if (catalogBytes > MAX_CATALOG_BYTES) {
        throw new McpClientError(
          "catalog_limit",
          `MCP catalog exceeded ${MAX_CATALOG_BYTES} descriptor bytes`,
        );
      }
    }

    return [...merged.values()];
  }

  /**
   * List the read endpoint for one refresh (ADR-0130 decision 9). `null`: this connection has no
   * read endpoint. `dropped`: the listing failed, broke the ADR-0094 rule, or passed its deadline,
   * so this refresh uses only the main endpoint. The read side never fails the main catalog. An
   * abort of the caller is not a fault.
   */
  async #listReadSide(
    generation: McpClientGeneration,
    signal: AbortSignal | undefined,
    trace: McpTraceContext | undefined,
  ): Promise<McpReadSideListing | null> {
    const endpoint = this.#options.readEndpoint;

    if (!endpoint) return null;

    const side = (generation.readSide ??= this.#createReadSide(generation, endpoint));
    const deadline = AbortSignal.timeout(READ_SIDE_DEADLINE_MS);
    const attemptSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

    side.listings += 1;

    try {
      await side.client.connect(trace, attemptSignal);

      for (let attempt = 1; ; attempt++) {
        const prepared = await side.client.prepareToolCall(attemptSignal, trace);

        // No `await` between this check and the `finally`, so no invalidation can fall between.
        if (side.client.catalog === prepared.catalog) {
          return { kind: "listed", side, prepared, expiresAt: side.client.catalogExpiresAt };
        }

        if (attempt >= READ_SIDE_LISTING_ATTEMPTS) {
          throw new McpClientError(
            "catalog_stale",
            "The read-only MCP catalog changed during each listing",
          );
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;

      this.#dropReadSide(generation, side);

      return {
        kind: "dropped",
        fault: deadline.aborted
          ? `The read-only MCP endpoint did not list its tools within ${READ_SIDE_DEADLINE_MS / 1000} seconds`
          : boundedMcpErrorText(error),
      };
    } finally {
      side.listings -= 1;
    }
  }

  /**
   * The read endpoint's client. It borrows this generation's token, so one grant serves both. It
   * cannot renew a rejected token: a 401 from the read endpoint drops the read side, and only the
   * main endpoint's 401 can renew the grant or clear it. So a read-endpoint fault cannot cost the
   * writes their grant.
   */
  #createReadSide(generation: McpClientGeneration, endpoint: McpEndpointConnection): McpReadSide {
    const { auth, authProvider, protocolFactory, pinLegacyProtocol } = this.#options;
    const oauth = generation.oauth;

    const client = new McpRawClient({
      connectionId: this.#options.connectionId,
      endpoint,
      endpointAuthorizer: this.#options.endpointAuthorizer,
      // An OAuth generation lends its bound session: a session of its own would bind the
      // grant to the read resource. A token-free or key auth carries over as it is.
      auth: oauth
        ? {
            mode: "borrowed",
            session: {
              refreshIfNeeded: (options) => oauth.refreshIfNeeded(options),
              accessToken: () => oauth.accessToken(),
              renewRejectedToken: () => Promise.resolve(false),
            },
          }
        : auth,
      ...(authProvider ? { authProvider } : {}),
      ...(protocolFactory ? { protocolFactory } : {}),
      requestTimeoutMs: this.#limits.requestTimeoutMs,
      maxCatalogPages: this.#limits.maxCatalogPages,
      maxCatalogTools: this.#limits.maxCatalogTools,
      now: this.#options.now,
      readOnlyCatalog: true,
      pinLegacyProtocol,
    });

    const side: McpReadSide = { client, listings: 0 };

    // Only the read side that serves the current catalog invalidates it. A fault during a listing
    // belongs to that refresh, which drops the read side itself.
    client.onCatalogInvalidated(() => {
      if (this.#generation !== generation || side.listings > 0) return;

      if (this.#readRoute?.side === side) this.#announceCatalogInvalidated();
    });

    return side;
  }

  /** Close the read side of a generation, so the next refresh opens a fresh one. */
  #dropReadSide(generation: McpClientGeneration, side: McpReadSide): void {
    if (generation.readSide === side) generation.readSide = null;

    // oxlint-disable-next-line alfred/no-swallowed-catch -- best-effort close of a dropped read side; the drop is already decided
    this.#registerCleanup(side.client.close().catch(() => undefined));
  }

  /**
   * Run one call on the read endpoint with the call that the listing prepared. That call refuses
   * a moved read catalog, so a changed read endpoint is a stale selection. A blocked or lost read
   * side drops, and the catalog refreshes before the next call.
   */
  async #callReadEndpoint(
    route: McpReadRoute,
    catalog: McpCatalogSnapshot,
    ref: ExternalToolRef,
    args: JsonObject,
    options: McpToolCallOptions,
  ): Promise<McpCallEnvelope> {
    try {
      const envelope = await route.prepared.call(
        { ...ref, catalogRevision: route.prepared.catalog.revision },
        args,
        options,
      );

      return { ...envelope, catalogRevision: catalog.revision };
    } catch (error) {
      if (!(error instanceof McpClientError)) throw error;

      const drop = READ_SIDE_DROP_CODES.has(error.code);
      const generation = this.#generation;

      if (drop && generation) this.#dropReadSide(generation, route.side);

      // A refresh that lists the read side now already replaces this catalog.
      if (
        (drop || READ_CATALOG_MOVED_CODES.has(error.code)) &&
        this.#catalog === catalog &&
        route.side.listings === 0
      ) {
        this.#announceCatalogInvalidated();
      }

      throw error;
    }
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
    this.#readRoute = null;
    this.#catalogExpiresAt = 0;
    this.#toolsByName.clear();
    this.#inputValidators.clear();
    this.#outputValidators.clear();
  }

  #announceCatalogInvalidated(): void {
    this.#invalidateCatalog();
    this.#catalogInvalidatedHandler?.();
  }

  async #throwProtocolError(
    err: unknown,
    generation: McpClientGeneration,
    sent: SentAccessToken,
  ): Promise<never> {
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

      generation.authorizationBlocked = new McpClientError(
        "insufficient_scope",
        `The MCP connection needs renewed consent.${detail}`,
      );
      throw generation.authorizationBlocked;
    }

    if (isMcpAuthorizationChallenge(err)) {
      // A revoked or early-expired token: renew it once before asking the user to reconnect.
      const renewal = await this.#renewRejectedToken(generation.oauth, sent.token);

      if (renewal) throw renewal;

      // Keep this code out of the pre-delivery set: the broker still owns effect ambiguity.
      generation.authorizationBlocked = new McpClientError(
        "authorization_required",
        MCP_RECONNECT_MESSAGE,
        { cause: err },
      );
      await this.#options.onAuthorizationRequired?.();
      throw generation.authorizationBlocked;
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

    // oxlint-disable-next-line alfred/no-swallowed-catch -- best-effort close of an expired session; the `session_expired` error is thrown below
    const cleanup = this.#closeGeneration(generation, false).catch(() => undefined);
    this.#registerCleanup(cleanup);
    await cleanup;
    throw new McpClientError(
      "session_expired",
      "The MCP session expired; reconnect and refresh the catalog before retrying",
    );
  }

  /**
   * The error to throw after a 401 when a refresh token can renew the access token,
   * or `null` when only a new consent can help. Neither code claims the call was not delivered.
   */
  async #renewRejectedToken(
    oauth: McpTokenSession | null,
    rejectedAccessToken: string | undefined,
  ): Promise<McpClientError | null> {
    if (!oauth) return null;

    let renewed: boolean;

    try {
      renewed = await oauth.renewRejectedToken(rejectedAccessToken);
    } catch (error) {
      return new McpClientError(
        "token_rejected",
        "The MCP server rejected the access token, and the renewal did not finish. Try again shortly.",
        { cause: error },
      );
    }

    return renewed
      ? new McpClientError(
          "token_rejected",
          "The MCP server rejected the access token. Alfred renewed it; check the outcome before you repeat a write.",
        )
      : null;
  }

  #closeGeneration(generation: McpClientGeneration, terminateSession: boolean): Promise<void> {
    return (generation.closeFlight ??= (async () => {
      try {
        await generation.protocol.close(terminateSession);
      } finally {
        const readSide = generation.readSide;
        generation.readSide = null;
        // oxlint-disable-next-line alfred/no-swallowed-catch -- best-effort close of the read side on a close path; a failure leaves nothing to undo
        await readSide?.client.close({ terminateSession }).catch(() => undefined);
        await this.#closeAuthorization(generation.authorization);
      }
    })());
  }

  async #closeAuthorization(authorization: McpAuthorizedEndpoint | null): Promise<void> {
    // oxlint-disable-next-line alfred/no-swallowed-catch -- best-effort release of the endpoint dispatcher on a close path; a failure leaves nothing to undo
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
  facts: { isToolError: boolean; outputSchemaValidated: boolean },
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
  };
}

function encodedBytes(value: string): number {
  return encoder.encode(value).length;
}

function deepFreeze<T>(value: T): T {
  // `T` is any value the caller froze, so walk it as `unknown`.
  const node: unknown = value;

  if (Array.isArray(node)) {
    for (const item of node) deepFreeze(item);
  } else if (isRecord(node)) {
    for (const child of Object.values(node)) deepFreeze(child);
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

/** Bound the length, and refuse a pattern that the RE2 validator engine cannot compile (#1865). */
function assertSafePattern(toolName: string, direction: "input" | "output", pattern: string): void {
  if (pattern.length > MAX_SCHEMA_REGEX_CHARS) {
    throw new McpClientError(
      "invalid_schema",
      `MCP tool '${toolName}' ${direction} schema contains an oversized regex`,
    );
  }

  if (!compilesOnRe2(pattern)) {
    throw new McpClientError(
      "invalid_schema",
      `MCP tool '${toolName}' ${direction} schema contains a regex that the linear-time engine cannot compile`,
    );
  }
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
        (!isNonEmptyString(child) || !child.startsWith("#"))
      ) {
        throw new McpClientError(
          "invalid_schema",
          `MCP tool '${toolName}' ${direction} schema contains a non-local ${key}`,
        );
      }

      if (key === "pattern" && isNonEmptyString(child)) {
        assertSafePattern(toolName, direction, child);
      }

      if (key === "patternProperties" && isRecord(child)) {
        for (const pattern of Object.keys(child)) assertSafePattern(toolName, direction, pattern);
      }

      visit(child, depth + 1);
    }
  };

  visit(schema, 0);
}
