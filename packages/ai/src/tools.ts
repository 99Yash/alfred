/**
 * Tool-shape primitives re-exported from the AI SDK so app code can
 * define agent tools without taking a direct dep on `ai`. Keeping these
 * funnelled through `@alfred/ai` matches the AlfredAgent boundary —
 * tools are the agent's tool, not a generic concern.
 *
 * Adding a new agent? Define your tools with `tool()` + a `zod`
 * schema, then plug into `meteredGenerateText` (one-shot) or
 * `AlfredAgent` (durable per-turn) from this package.
 */
export { stepCountIs, tool } from "ai";
export type {
  LanguageModel,
  ModelMessage,
  Tool,
  ToolSet,
  TypedToolCall,
} from "ai";
