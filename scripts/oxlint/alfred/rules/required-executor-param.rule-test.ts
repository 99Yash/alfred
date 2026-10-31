import { RuleTester } from "oxlint/plugins-dev";

import { requiredExecutorParamRule } from "./required-executor-param.ts";

// The spec of `required-executor-param`: a transaction parameter is required, so
// a caller that forgets it does not compile. With `tx?: DbTransaction` the write
// runs on a second pooled connection, outside the caller's transaction and its
// locks (PRs #1526, #1225, #1224, #1114). The Bad and Good cases come from
// docs/reference/smells/required-executor-param.md.
//
// `pnpm check:oxlint-plugin` drives each `invalid` case through the root
// `.oxlintrc.json`. A bare `filename` such as `probe.ts` names only the language
// and keeps the case inside the gate scope.

const tester = new RuleTester();

const optionalExecutor = () => ({ messageId: "optionalExecutor" });

tester.run("alfred/required-executor-param", requiredExecutorParamRule, {
  valid: [
    {
      name: "a required choice between the caller's transaction and its own (the smell's Good case)",
      filename: "probe.ts",
      code: 'export async function createDraft(args: { userId: string; definition: unknown; exec: DbTransaction | "own" }) { return args; }',
    },
    {
      name: "a required positional transaction",
      filename: "probe.ts",
      code: "export async function f(userId: string, tx: DbTransaction) { return tx; }",
    },
    {
      name: "a required positional choice",
      filename: "probe.ts",
      code: 'export async function f(userId: string, exec: DbTransaction | "own") { return exec; }',
    },
    {
      name: "a required property in an interface",
      filename: "probe.ts",
      code: "interface Args { userId: string; tx: DbTransaction }",
    },
    {
      name: "an optional callback that takes a transaction",
      filename: "probe.ts",
      code: "interface Args { body?: (tx: DbTransaction) => Promise<void> }",
    },
    {
      name: "a `never` slot names no transaction",
      filename: "probe.ts",
      code: "type Args = { tx: DbTransaction; untransacted?: never } | { untransacted: true; tx?: never };",
    },
    {
      name: "a local variable that may hold a transaction",
      filename: "probe.ts",
      code: "function f() { let tx: DbTransaction | undefined; return tx; }",
    },
    {
      name: "an optional parameter of another type",
      filename: "probe.ts",
      code: "function f(userId?: string, opts?: { limit: number }) { return [userId, opts]; }",
    },
    {
      // An alias is invisible without type information. The smell's Mechanism lists it.
      name: "an alias of the transaction type is not seen",
      filename: "probe.ts",
      code: "function f(runner: DbRunner = db(), ex?: AgentDbExecutor) { return [runner, ex]; }",
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a test tree is out of scope",
      filename: "packages/assistant/test/probe.test.ts",
      code: "function f(tx?: DbTransaction) { return tx; }",
    },
  ],
  invalid: [
    {
      name: "an optional property in an args object (the smell's Bad case)",
      filename: "probe.ts",
      code: "export async function createDraft(args: { userId: string; definition: unknown; tx?: DbTransaction }) { return args; }",
      errors: [optionalExecutor()],
    },
    {
      name: "an optional positional parameter",
      filename: "probe.ts",
      code: "export async function upsertEntity(args: unknown, tx?: DbTransaction) { return tx; }",
      errors: [optionalExecutor()],
    },
    {
      name: "an optional property in an interface",
      filename: "probe.ts",
      code: "interface Args { userId: string; tx?: DbTransaction }",
      errors: [optionalExecutor()],
    },
    {
      name: "an optional property in a type alias",
      filename: "probe.ts",
      code: "type FactExec = { exec?: DbTransaction };",
      errors: [optionalExecutor()],
    },
    {
      name: "a required parameter that admits undefined",
      filename: "probe.ts",
      code: "async function inFactTransaction(exec: DbTransaction | undefined, userId: string) { return exec; }",
      errors: [optionalExecutor()],
    },
    {
      name: "a property that admits undefined",
      filename: "probe.ts",
      code: "interface Args { tx: DbTransaction | undefined }",
      errors: [optionalExecutor()],
    },
    {
      name: "a parameter with a default value",
      filename: "probe.ts",
      code: "function f(runner: DbRoot | DbTransaction = db()) { return runner; }",
      errors: [optionalExecutor()],
    },
    {
      name: "a qualified type name",
      filename: "probe.ts",
      code: "function f(tx?: Db.DbTransaction) { return tx; }",
      errors: [optionalExecutor()],
    },
    {
      name: "an optional union member",
      filename: "probe.ts",
      code: "function f(ex?: DbRoot | DbTransaction) { return ex; }",
      errors: [optionalExecutor()],
    },
    {
      name: "an optional parameter of a function type",
      filename: "probe.ts",
      code: "type Run = (args: unknown, tx?: DbTransaction) => Promise<void>;",
      errors: [optionalExecutor()],
    },
    {
      name: "an optional parameter of an arrow function",
      filename: "probe.ts",
      code: "const run = async (tx?: DbTransaction) => tx;",
      errors: [optionalExecutor()],
    },
    {
      name: "an optional class field",
      filename: "probe.ts",
      code: "class Writer { tx?: DbTransaction; }",
      errors: [optionalExecutor()],
    },
  ],
});
