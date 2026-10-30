import { RuleTester } from "oxlint/plugins-dev";

import { noDeltaClassUtilityCollisionRule } from "./no-delta-class-utility-collision.ts";

// The spec of `no-delta-class-utility-collision`: `app-press` and
// `app-hover-lift` sit in `@layer components`, so a same-element Tailwind
// `scale-*` or `translate-*` utility wins and the press or the lift stops
// (PR #1481, `.lessons/a-motion-node-reads-its-ref-once-and-a-class-delta-must-write-scale-not-transform.md`).
//
// `pnpm check:oxlint-plugin` runs this file, and it drives every `invalid` case
// without a `filename` through the root `.oxlintrc.json`. A bare `probe.tsx`
// names only the language, so the drive writes that JSX case as a `.tsx` file.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const jsx = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });

const press = () => ({ messageId: "pressCollision" });

const lift = () => ({ messageId: "liftCollision" });

tester.run("alfred/no-delta-class-utility-collision", noDeltaClassUtilityCollisionRule, {
  valid: [
    {
      name: "a hover scale gated off the press",
      code: 'cn("app-press transition-[opacity,filter,scale] hover:not-active:scale-[1.04]")',
    },
    {
      name: "a scale utility without a delta class",
      code: 'cn("transition-[scale] active:scale-[0.96]")',
    },
    {
      name: "app-hover-lift with no translate utility",
      code: 'cn("app-hover-lift rounded-panel")',
    },
  ],
  invalid: [
    {
      name: "a hover scale on an app-press element",
      code: 'cn("app-press transition-[scale] hover:scale-[1.04]")',
      errors: [press()],
    },
    {
      name: "an active scale in another cn argument",
      code: 'cn("app-press", "active:scale-95")',
      errors: [press()],
    },
    {
      name: "a translate utility on an app-hover-lift element",
      code: 'cn("app-hover-lift -translate-y-1")',
      errors: [lift()],
    },
  ],
});

jsx.run("alfred/no-delta-class-utility-collision", noDeltaClassUtilityCollisionRule, {
  valid: [
    {
      name: "app-press with no scale utility",
      code: '<button className="app-press transition-[box-shadow,scale,filter]" />',
    },
    {
      name: "a child element does not share the parent's delta class",
      code: '<button className="app-press"><span className="scale-95" /></button>',
    },
  ],
  invalid: [
    {
      name: "a hover scale in a JSX class string",
      filename: "probe.tsx",
      code: '<button className="app-press hover:scale-105" />',
      errors: [press()],
    },
  ],
});
