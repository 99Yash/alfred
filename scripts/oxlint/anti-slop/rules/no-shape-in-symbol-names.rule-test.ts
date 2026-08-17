import { RuleTester } from "oxlint/plugins-dev";

import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "forbiddenSymbolName" };

tester.run("anti-slop/no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
  valid: [
    "const user = { id: 1 };",
    "interface UserProfile { name: string; }",
    "function getData() {}",
  ],
  invalid: [
    { code: "interface UserShape { id: string; }", errors: [error] },
    { code: "const userShape = {};", errors: [error] },
    { code: "type ResponseShape = { data: unknown; };", errors: [error] },
  ],
});
