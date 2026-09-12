import { RuleTester } from "oxlint/plugins-dev";

import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "forbiddenSymbolName" };

tester.run("anti-slop/no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
  valid: [
    "const user = { id: 1 };",
    "interface UserProfile { name: string; }",
    "function getData() {}",
    // Borrowed static member names belong to their owner and cannot be renamed locally.
    "declare const schema: ExternalSchema; const field = schema.shape.id;",
    "declare const outer: External; const value = outer.inner.shape;",
    "declare const schema: ExternalSchema; schema.shape.id.parse('x');",
    "const owner = { id: 1 }; const value = owner.id;",
  ],
  invalid: [
    { code: "interface UserShape { id: string; }", errors: [error] },
    { code: "const userShape = {};", errors: [error] },
    { code: "type ResponseShape = { data: unknown; };", errors: [error] },
    // A locally owned property key and a computed member read stay rejected.
    { code: "type Payload = { shape: string };", errors: [error] },
    {
      code: "declare const owner: External; const shape = 'field'; const value = owner[shape];",
      errors: 2,
    },
  ],
});
