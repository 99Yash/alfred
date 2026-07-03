/**
 * Compile-time guard for the m13 Phase 2 tool registry.
 *
 * `pnpm check-types` is the only step that exercises this file — it has
 * no runtime body. If `ToolName` ever stops narrowing properly (e.g. a
 * refactor accidentally widens it to `string`), the `@ts-expect-error`
 * comments below stop firing and tsc -b will fail the build for the
 * `server` package, which is exactly the signal we want.
 */

import { getTool, listToolsForIntegration, type RegisteredTool } from "@alfred/api";

// Resolves: `'gmail.search'` is a member of the `ToolName` template union.
const _searchTool: RegisteredTool | undefined = getTool("gmail.search");
void _searchTool;

// Compile errors below are the contract — if any of them stop erroring,
// the registry has lost its type safety.

// @ts-expect-error — `'gmail.fake_action'` is not a declared GMAIL_ACTION.
getTool("gmail.fake_action");

// @ts-expect-error — `'imessage.search'` is not in INTEGRATION_ACTIONS['imessage'] (empty).
getTool("imessage.search");

// @ts-expect-error — `'unknown_integration.search'` is not an IntegrationSlug.
listToolsForIntegration("unknown_integration");
