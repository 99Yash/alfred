import { RuleTester } from "oxlint/plugins-dev";

import { transitionNamesIndividualTransformRule } from "./transition-names-individual-transform.ts";

// The spec of `transition-names-individual-transform`: Tailwind v4 `scale-*`,
// `translate-*` and `rotate-*` write the individual CSS properties, so a
// `transition-[…transform…]` list that does not name them lets the change snap
// (the `tool-call-group.tsx` chevron, the `nag-banner.tsx` press).
//
// `pnpm check:oxlint-plugin` runs this file, and it drives every `invalid` case
// without a `filename` through the root `.oxlintrc.json`. A bare `probe.tsx`
// names only the language, so the drive writes that JSX case as a `.tsx` file.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const jsx = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });

const missing = (property: string) => ({
  messageId: "missingProperty",
  data: { missing: property },
});

tester.run("alfred/transition-names-individual-transform", transitionNamesIndividualTransformRule, {
  valid: [
    {
      name: "a list that names scale",
      code: 'cn("transition-[color,scale] duration-150 active:scale-[0.96]")',
    },
    {
      name: "transition-transform already includes the individual properties",
      code: 'cn("transition-transform active:scale-95")',
    },
    {
      name: "a list without transform asks for no transform ease",
      code: 'cn("transition-[color,opacity] active:scale-[0.96]")',
    },
    {
      name: "rotate-x writes transform, not rotate",
      code: 'cn("transition-[transform] hover:rotate-x-12")',
    },
    {
      name: "a call that is not a class joiner",
      code: 'format("transition-[transform] active:scale-95")',
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a test tree is out of scope",
      filename: "apps/web/test/press.ts",
      code: 'cn("transition-[transform] active:scale-[0.96]")',
    },
  ],
  invalid: [
    {
      name: "a press scale in one string",
      code: 'cn("transition-[color,transform] duration-150 hover:text-app-fg-4 active:scale-[0.96]")',
      errors: [missing("scale")],
    },
    {
      name: "a negative translate in another cn argument",
      code: 'cn("-translate-x-1 opacity-0", "transition-[transform,opacity] duration-300", "group-hover:translate-x-0")',
      errors: [missing("translate")],
    },
    {
      name: "a const base list read through a later cn call",
      code: 'const base = cn("transition-[background-color,transform] duration-200");\nexport const trigger = cn(base, "active:scale-[0.96]");',
      errors: [missing("scale")],
    },
    {
      name: "the app-press delta class writes scale",
      code: 'cn("app-press transition-[box-shadow,transform]")',
      errors: [missing("scale")],
    },
    {
      name: "two missing properties are named together",
      code: 'cn("transition-[transform] hover:-translate-y-px active:scale-95")',
      errors: [missing("scale`, `translate")],
    },
  ],
});

jsx.run("alfred/transition-names-individual-transform", transitionNamesIndividualTransformRule, {
  valid: [
    {
      name: "a list that names transform and rotate",
      code: '<span className="transition-[transform,rotate,color] group-data-[state=open]/tools:rotate-90" />',
    },
    {
      name: "an inline transform with no transform utility",
      code: '<div className="transition-[opacity,transform] duration-300" style={{ transform: "scale(1)" }} />',
    },
    {
      name: "two elements do not share classes",
      code: '<div className="transition-[transform]"><span className="scale-95" /></div>',
    },
  ],
  invalid: [
    {
      name: "a chevron rotate behind a group variant",
      filename: "probe.tsx",
      code: '<ChevronRight className="text-app-fg-2 transition-[transform,color] duration-200 group-data-[state=open]/tools:rotate-90" />',
      errors: [missing("rotate")],
    },
    {
      name: "a scale in a conditional branch, reported once for the attribute and its cn call",
      filename: "probe.tsx",
      code: '<button className={cn("transition-[transform]", pressed ? "scale-95" : "scale-100")} />',
      errors: [missing("scale")],
    },
  ],
});
