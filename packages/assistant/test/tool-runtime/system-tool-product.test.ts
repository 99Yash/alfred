import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  editInstruction,
  forgetInstruction,
  listInstructions,
  readUserContext,
  registerSystemToolKnowledgeAdapter,
  registerSystemToolTaskAdapter,
  rememberSenderSuppressionAndDismissTodos,
  resolveTodo,
  suggestTodo,
  webSearch,
  type SystemToolKnowledgeAdapter,
  type SystemToolRequest,
  type SystemToolTaskAdapter,
} from "@alfred/assistant/tool-runtime";

const context = {
  userId: "user_1",
  runId: "run_1",
  stepId: "step_1",
  toolCallId: "call_1",
};

const requests = {
  read: { input: {}, context } satisfies SystemToolRequest<"system.read_user_context">,
  remember: {
    input: { kind: "sender_suppression", senderEmail: "sender@example.com" },
    context,
  } satisfies SystemToolRequest<"system.remember">,
  list: { input: {}, context } satisfies SystemToolRequest<"system.list_instructions">,
  forget: {
    input: { factId: "fact_1", reason: "User request" },
    context,
  } satisfies SystemToolRequest<"system.forget_instruction">,
  edit: {
    input: { factId: "fact_1", directive: "Ignore this sender." },
    context,
  } satisfies SystemToolRequest<"system.edit_instruction">,
  search: {
    input: { query: "current weather" },
    context,
  } satisfies SystemToolRequest<"system.web_search">,
  resolve: {
    input: { kind: "gmail_sender", senderEmail: "sender@example.com" },
    context,
  } satisfies SystemToolRequest<"system.resolve_todo">,
  suggest: {
    input: { name: "Send the report" },
    context,
  } satisfies SystemToolRequest<"system.suggest_todo">,
};

let unregisterKnowledge: (() => void) | undefined;
let unregisterTasks: (() => void) | undefined;

afterEach(() => {
  unregisterTasks?.();
  unregisterTasks = undefined;
  unregisterKnowledge?.();
  unregisterKnowledge = undefined;
});

describe("system-tool product seams without registered adapters", () => {
  test("each operation fails with its boot-order error", () => {
    const knowledgeMessage = "No system-tool knowledge adapter is registered";
    assert.throws(() => readUserContext(requests.read), { message: knowledgeMessage });
    assert.throws(() => rememberSenderSuppressionAndDismissTodos(requests.remember), {
      message: knowledgeMessage,
    });
    assert.throws(() => listInstructions(requests.list), { message: knowledgeMessage });
    assert.throws(() => forgetInstruction(requests.forget), { message: knowledgeMessage });
    assert.throws(() => editInstruction(requests.edit), { message: knowledgeMessage });
    assert.throws(() => webSearch(requests.search), { message: knowledgeMessage });

    const taskMessage = "No system-tool task adapter is registered";
    assert.throws(() => resolveTodo(requests.resolve), { message: taskMessage });
    assert.throws(() => suggestTodo(requests.suggest), { message: taskMessage });
  });
});

describe("system-tool product seams with registered adapters", () => {
  test("forward exact request and result objects", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const results = {
      read: { value: "read" },
      remember: { value: "remember" },
      list: { value: "list" },
      forget: { value: "forget" },
      edit: { value: "edit" },
      search: { value: "search" },
      resolve: { value: "resolve" },
      suggest: { value: "suggest" },
    };
    const knowledge: SystemToolKnowledgeAdapter = {
      readUserContext: (args) => {
        calls.push({ name: "read", args });
        return Promise.resolve(results.read);
      },
      rememberSenderSuppressionAndDismissTodos: (args) => {
        calls.push({ name: "remember", args });
        return Promise.resolve(results.remember);
      },
      listInstructions: (args) => {
        calls.push({ name: "list", args });
        return Promise.resolve(results.list);
      },
      forgetInstruction: (args) => {
        calls.push({ name: "forget", args });
        return Promise.resolve(results.forget);
      },
      editInstruction: (args) => {
        calls.push({ name: "edit", args });
        return Promise.resolve(results.edit);
      },
      webSearch: (args) => {
        calls.push({ name: "search", args });
        return Promise.resolve(results.search);
      },
    };
    const tasks: SystemToolTaskAdapter = {
      resolveTodo: (args) => {
        calls.push({ name: "resolve", args });
        return Promise.resolve(results.resolve);
      },
      suggestTodo: (args) => {
        calls.push({ name: "suggest", args });
        return Promise.resolve(results.suggest);
      },
    };
    unregisterKnowledge = registerSystemToolKnowledgeAdapter(knowledge);
    unregisterTasks = registerSystemToolTaskAdapter(tasks);

    assert.equal(await readUserContext(requests.read), results.read);
    assert.equal(
      await rememberSenderSuppressionAndDismissTodos(requests.remember),
      results.remember,
    );
    assert.equal(await listInstructions(requests.list), results.list);
    assert.equal(await forgetInstruction(requests.forget), results.forget);
    assert.equal(await editInstruction(requests.edit), results.edit);
    assert.equal(await webSearch(requests.search), results.search);
    assert.equal(await resolveTodo(requests.resolve), results.resolve);
    assert.equal(await suggestTodo(requests.suggest), results.suggest);

    assert.deepEqual(calls, [
      { name: "read", args: requests.read },
      { name: "remember", args: requests.remember },
      { name: "list", args: requests.list },
      { name: "forget", args: requests.forget },
      { name: "edit", args: requests.edit },
      { name: "search", args: requests.search },
      { name: "resolve", args: requests.resolve },
      { name: "suggest", args: requests.suggest },
    ]);
  });
});
