import { RuleTester } from "oxlint/plugins-dev";

import { noDashInWebCopyRule } from "./no-dash-in-web-copy.ts";

// The spec of `no-dash-in-web-copy`: the copy voice has no em dash or en
// dash, in JSX text, a string or a template literal. `EM` and `EN` keep the
// characters out of this file's own text.
//
// `pnpm check:oxlint-plugin` runs this file, and it drives every `invalid` case
// without a `filename` through the root `.oxlintrc.json`.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const jsx = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });

const EM = String.fromCodePoint(0x2014);

const EN = String.fromCodePoint(0x2013);

const dash = () => ({ messageId: "dash" });

tester.run("alfred/no-dash-in-web-copy", noDashInWebCopyRule, {
  valid: [
    {
      name: "a dash in a comment is not copy",
      code: `// Live updates disconnected ${EM} reconnecting\nexport const banner = "Reconnecting";`,
    },
    {
      name: "a hyphen in a range",
      code: "export const range = `${start}-${end} of ${total}`;",
    },
    {
      name: "a server workspace is out of scope",
      filename: "packages/assistant/src/prompt.ts",
      code: `export const prompt = "Context ${EM} read it first.";`,
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a web test tree is out of scope",
      filename: "apps/web/test/copy.ts",
      code: `export const fixture = "a ${EM} b";`,
    },
  ],
  invalid: [
    {
      name: "an em dash in a string constant",
      code: `const STREAM_ERROR_MESSAGE = "Live updates disconnected ${EM} reply may be incomplete.";`,
      errors: [dash()],
    },
    {
      name: "an en dash in a template literal",
      code: `export const span = \`\${time(start)} ${EN} \${time(end)}\`;`,
      errors: [dash()],
    },
    {
      name: "an escaped em dash in a string",
      code: 'export const label = "Alfred \\u2014 home";',
      errors: [dash()],
    },
    {
      name: "a web source file is in scope",
      filename: "apps/web/src/lib/chat/use-chat-stream.ts",
      code: `export const message = "Connection stalled ${EM} no updates received.";`,
      errors: [dash()],
    },
  ],
});

jsx.run("alfred/no-dash-in-web-copy", noDashInWebCopyRule, {
  valid: [
    {
      name: "short declaratives in JSX text",
      filename: "apps/web/src/components/event-stream-banner.tsx",
      code: "<span>Live updates disconnected. Reconnecting.</span>",
    },
  ],
  invalid: [
    {
      name: "an em dash in JSX text",
      filename: "apps/web/src/components/event-stream-banner.tsx",
      code: `<span>Live updates disconnected ${EM} reconnecting</span>`,
      errors: [dash()],
    },
    {
      name: "an en dash in a JSX attribute string",
      filename: "apps/web/src/lib/shell/app-sidebar/rail-content.tsx",
      code: `<a aria-label="Alfred ${EN} home" />`,
      errors: [dash()],
    },
  ],
});
