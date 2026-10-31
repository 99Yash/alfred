import { RuleTester } from "oxlint/plugins-dev";

import { aiCallNeedsAbortSignalRule } from "./ai-call-needs-abort-signal.ts";

// The spec of `ai-call-needs-abort-signal`: an AI SDK generate or stream call
// names an `abortSignal` in its options, so a caller that stops waiting ends
// the billable call (PRs #1086, #714, #1111, #1133). The Bad and Good cases come
// from docs/reference/smells/external-call-timeout-and-abort.md.
//
// `pnpm check:oxlint-plugin` drives each `invalid` case through the root
// `.oxlintrc.json`. A bare `filename` such as `probe.ts` names only the language
// and keeps the case inside the gate scope.

const tester = new RuleTester();

const missingAbortSignal = () => ({ messageId: "missingAbortSignal" });

const opaqueOptions = () => ({ messageId: "opaqueOptions" });

tester.run("alfred/ai-call-needs-abort-signal", aiCallNeedsAbortSignalRule, {
  valid: [
    {
      name: "an abortSignal key (the smell's Good case)",
      filename: "probe.ts",
      code: 'async function f(model: M, bodyText: string) { return meteredGenerateObject({ model: model.model(), schema: reviewSchema, prompt: JSON.stringify({ bodyText }), maxOutputTokens: OUTPUT_TOKEN_LIMIT, abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS) }, { name: "reply-drafting.verify-grounding" }); }',
    },
    {
      name: "a shorthand abortSignal",
      filename: "probe.ts",
      code: "async function f(model: M, abortSignal: AbortSignal) { return meteredGenerateText({ model, prompt: 'p', abortSignal }); }",
    },
    {
      name: "a string-literal key",
      filename: "probe.ts",
      code: "async function f(model: M, s: AbortSignal) { return generateText({ model, prompt: 'p', 'abortSignal': s }); }",
    },
    {
      name: "a conditional spread of an object literal with the key",
      filename: "probe.ts",
      code: "async function f(model: M, args: { abortSignal?: AbortSignal }) { return meteredGenerateText({ model, prompt: 'p', ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}) }); }",
    },
    {
      name: "a logical spread of an object literal with the key",
      filename: "probe.ts",
      code: "async function f(model: M, signal: AbortSignal | undefined) { return streamText({ model, prompt: 'p', ...(signal && { abortSignal: signal }) }); }",
    },
    {
      name: "an opaque spread next to a visible key",
      filename: "probe.ts",
      code: "function f(args: A, signal: AbortSignal) { return streamText({ ...args, abortSignal: signal }); }",
    },
    {
      name: "a same-file const whose object has the key",
      filename: "probe.ts",
      code: "async function f(model: M) { const options = { model, prompt: 'p', abortSignal: AbortSignal.timeout(1_000) }; return generateText(options); }",
    },
    {
      name: "a member callee with the key",
      filename: "probe.ts",
      code: "async function f(model: M, s: AbortSignal) { return ai.generateText({ model, prompt: 'p', abortSignal: s }); }",
    },
    {
      name: "a call with another name",
      filename: "probe.ts",
      code: "async function f(model: M) { return generateSummary({ model, prompt: 'p' }); }",
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a script is out of scope",
      filename: "apps/server/src/scripts/smokes/smoke.ts",
      code: "async function f(model: M) { return generateText({ model, prompt: 'p' }); }",
    },
  ],
  invalid: [
    {
      name: "no abortSignal key (the smell's Bad case)",
      filename: "probe.ts",
      code: 'async function f(model: M, bodyText: string) { return meteredGenerateObject({ model: model.model(), schema: reviewSchema, prompt: JSON.stringify({ bodyText }), maxOutputTokens: OUTPUT_TOKEN_LIMIT }, { name: "reply-drafting.verify-grounding" }); }',
      errors: [missingAbortSignal()],
    },
    {
      name: "a timeout key is not a cancel path",
      filename: "probe.ts",
      code: "async function f(model: M) { return meteredGenerateText({ model, prompt: 'p', timeout: 15_000 }); }",
      errors: [missingAbortSignal()],
    },
    {
      name: "a bare SDK stream call",
      filename: "probe.ts",
      code: "function f(model: M) { return streamText({ model, prompt: 'p' }); }",
      errors: [missingAbortSignal()],
    },
    {
      name: "a member callee",
      filename: "probe.ts",
      code: "async function f(model: M) { return ai.generateObject({ model, prompt: 'p', schema: s }); }",
      errors: [missingAbortSignal()],
    },
    {
      name: "a same-file const whose object has no key",
      filename: "probe.ts",
      code: "async function f(model: M) { const options = { model, prompt: 'p' }; return meteredStreamText(options); }",
      errors: [missingAbortSignal()],
    },
    {
      name: "a conditional spread with no key in either branch",
      filename: "probe.ts",
      code: "async function f(model: M, t?: number) { return generateText({ model, prompt: 'p', ...(t ? { timeout: t } : {}) }); }",
      errors: [missingAbortSignal()],
    },
    {
      name: "a parameter as the options",
      filename: "probe.ts",
      code: "async function f(args: A) { return generateText(args); }",
      errors: [opaqueOptions()],
    },
    {
      name: "a spread of a parameter with no visible key",
      filename: "probe.ts",
      code: "function f(args: A) { return streamText({ ...args, timeout: 1_000 }); }",
      errors: [opaqueOptions()],
    },
    {
      name: "a call result as the options",
      filename: "probe.ts",
      code: "async function f(model: M) { return meteredGenerateObject(buildOptions(model)); }",
      errors: [opaqueOptions()],
    },
    {
      name: "a destructured name as the options",
      filename: "probe.ts",
      code: "async function f(prepare: P) { const { request } = await prepare(); return meteredGenerateText(request); }",
      errors: [opaqueOptions()],
    },
  ],
});
