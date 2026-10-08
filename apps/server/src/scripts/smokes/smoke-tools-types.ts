/**
 * Compile-time guard for the tool registry. No runtime body: if `ToolName`
 * widens to `string`, the `@ts-expect-error` lines below fail `check-types`.
 */

import type { RegisteredTool } from "@alfred/assistant/tool-runtime";
import type { BuiltinToolRegistry } from "@alfred/assistant/tool-runtime/builtin-tools";

declare const registry: BuiltinToolRegistry;

const _searchTool: RegisteredTool | undefined = registry.get("gmail.search");

void _searchTool;

// @ts-expect-error — `'gmail.fake_action'` is not a declared GMAIL_ACTION.
registry.get("gmail.fake_action");

// @ts-expect-error — `'imessage.search'` is not in INTEGRATION_ACTIONS['imessage'] (empty).
registry.get("imessage.search");

// @ts-expect-error — `'unknown_integration.search'` is not an IntegrationSlug.
registry.listForIntegration("unknown_integration");
