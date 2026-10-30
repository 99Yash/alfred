import { RuleTester } from "oxlint/plugins-dev";

import { noConditionalMotionRefRule } from "./no-conditional-motion-ref.ts";

// The spec of `no-conditional-motion-ref`: motion's `useMotionRef` reads the
// external ref only at mount, so `ref={isPresent ? pillRef : undefined}` on an
// `m.*` node keeps the node it saw first (PR #1481, `selection-quote.tsx`).
//
// `pnpm check:oxlint-plugin` drives each `invalid` case through the root
// `.oxlintrc.json`. A bare `filename` such as `probe.tsx` names only the
// language, so the drive writes that case as a `.tsx` file.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });

const conditional = () => ({ messageId: "conditionalRef" });

tester.run("alfred/no-conditional-motion-ref", noConditionalMotionRefRule, {
  valid: [
    {
      name: "one stable ref on a motion node",
      code: "<m.button ref={pillRef} {...pillProps} />",
    },
    {
      name: "a conditional ref on a plain DOM element re-runs",
      code: "<div ref={stream.reasoning.length > 0 ? reasoningRef : undefined} />",
    },
    {
      name: "a ref from a call on a motion node",
      code: "<motion.div ref={mergeRefs(a, b)} />",
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a test tree is out of scope",
      filename: "apps/web/test/pill.tsx",
      code: "<m.button ref={isPresent ? pillRef : undefined} />",
    },
  ],
  invalid: [
    {
      name: "a ternary ref on an m node",
      filename: "probe.tsx",
      code: "<m.button ref={isPresent ? pillRef : undefined} />",
      errors: [conditional()],
    },
    {
      name: "a logical ref on a motion node",
      filename: "probe.tsx",
      code: "<motion.div ref={open && panelRef} />",
      errors: [conditional()],
    },
    {
      name: "a nullish ref on an m node",
      filename: "probe.tsx",
      code: "<m.span ref={maybeRef ?? undefined} />",
      errors: [conditional()],
    },
  ],
});
