import { RuleTester } from "oxlint/plugins-dev";

import { motionSafeVariantAnimateRule } from "./motion-safe-variant-animate.ts";

// The spec of `motion-safe-variant-animate`: `data-[state=open]:animate-[…]`
// has a higher specificity than `motion-reduce:animate-none`, so it still
// animates under reduced motion (PR #1475, `attachment-lightbox.tsx`).
//
// `pnpm check:oxlint-plugin` runs this file, and it drives every `invalid` case
// without a `filename` through the root `.oxlintrc.json`. A bare `probe.tsx`
// names only the language, so the drive writes that JSX case as a `.tsx` file.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const jsx = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });

const beats = (token: string) => ({ messageId: "variantBeatsReduce", data: { token } });

tester.run("alfred/motion-safe-variant-animate", motionSafeVariantAnimateRule, {
  valid: [
    {
      name: "the variant animation carries motion-safe",
      code: 'cn("motion-safe:data-[state=open]:animate-[dialog-overlay-in_180ms_ease-out]", "motion-reduce:animate-none")',
    },
    {
      name: "a variant animation with no motion-reduce counterpart",
      code: 'cn("data-[state=open]:animate-[app-fade-in_120ms_ease-out]")',
    },
  ],
  invalid: [
    {
      name: "data variant animations beside motion-reduce:animate-none",
      code: 'cn("data-[state=open]:animate-[dialog-overlay-in_180ms_ease-out]", "data-[state=closed]:animate-[dialog-overlay-out_140ms_ease-out]", "motion-reduce:animate-none")',
      errors: [
        beats("data-[state=open]:animate-[dialog-overlay-in_180ms_ease-out]"),
        beats("data-[state=closed]:animate-[dialog-overlay-out_140ms_ease-out]"),
      ],
    },
  ],
});

jsx.run("alfred/motion-safe-variant-animate", motionSafeVariantAnimateRule, {
  valid: [
    {
      name: "a plain animate utility loses to motion-reduce",
      code: '<div className="animate-pulse motion-reduce:animate-none" />',
    },
  ],
  invalid: [
    {
      name: "a named animate utility behind a variant in JSX",
      filename: "probe.tsx",
      code: '<div className="data-[state=open]:animate-chat-accordion-down motion-reduce:animate-none" />',
      errors: [beats("data-[state=open]:animate-chat-accordion-down")],
    },
  ],
});
