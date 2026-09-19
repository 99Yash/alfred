import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  editInstruction,
  forgetInstruction,
  listInstructions,
  readUserContext,
  registerSystemToolInstructionAdapter,
  registerSystemToolKnowledgeAdapter,
  registerSystemToolTaskAdapter,
  registerSystemToolWebSearchAdapter,
  rememberSenderSuppressionAndDismissTodos,
  resolveTodo,
  suggestTodo,
  webSearch,
  type SystemToolInstructionAdapter,
  type SystemToolKnowledgeAdapter,
  type SystemToolRequest,
  type SystemToolTaskAdapter,
  type SystemToolWebSearchAdapter,
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

let unregisterInstructions: (() => void) | undefined;

let unregisterWebSearch: (() => void) | undefined;

let unregisterTasks: (() => void) | undefined;

afterEach(() => {
  unregisterTasks?.();
  unregisterTasks = undefined;
  unregisterWebSearch?.();
  unregisterWebSearch = undefined;
  unregisterInstructions?.();
  unregisterInstructions = undefined;
  unregisterKnowledge?.();
  unregisterKnowledge = undefined;
});

describe("system-tool product seams without registered adapters", () => {
  test("each operation fails with its boot-order error", () => {
    assert.throws(() => readUserContext(requests.read), {
      message: "No system-tool knowledge adapter is registered",
    });

    const instructionMessage = "No system-tool instruction adapter is registered";
    assert.throws(() => rememberSenderSuppressionAndDismissTodos(requests.remember), {
      message: instructionMessage,
    });
    assert.throws(() => listInstructions(requests.list), { message: instructionMessage });
    assert.throws(() => forgetInstruction(requests.forget), { message: instructionMessage });
    assert.throws(() => editInstruction(requests.edit), { message: instructionMessage });
    assert.throws(() => webSearch(requests.search), {
      message: "No system-tool web search adapter is registered",
    });

    const taskMessage = "No system-tool task adapter is registered";
    assert.throws(() => resolveTodo(requests.resolve), { message: taskMessage });
    assert.throws(() => suggestTodo(requests.suggest), { message: taskMessage });
  });
});

describe("system-tool product seams with registered adapters", () => {
  test("forward exact request and result objects", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];

    const results = {
      read: {
        profile: null,
        activeIntegrations: [],
        confirmedFacts: [],
        preferences: [],
        entities: [],
        relations: [],
        recentMemory: [],
      } as const,
      remember: {
        ok: false,
        status: "needs_clarification",
        reason: "invalid_sender_email",
        message: "not an email address",
      } as const,
      list: { instructions: [], totalActive: 0, truncated: false, limit: 50 } as const,
      forget: { ok: false, status: "not_found" } as const,
      edit: { ok: false, status: "not_found" } as const,
      search: {
        ok: true,
        query: "current weather",
        answer: "sunny",
        citations: [],
        results: [],
        searchQueries: ["current weather"],
      } as const,
      resolve: {
        ok: true,
        status: "dismissed",
        dismissedCount: 1,
        todoIds: ["todo_1"],
        matchedThreadIds: [],
        auditReason: null,
      } as const,
      suggest: { ok: true, status: "created", todoId: "todo_1" } as const,
    };

    const knowledge: SystemToolKnowledgeAdapter = {
      readUserContext: (args) => {
        calls.push({ name: "read", args });

        return Promise.resolve(results.read);
      },
    };

    const instructions: SystemToolInstructionAdapter = {
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
    };

    const search: SystemToolWebSearchAdapter = {
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
    unregisterInstructions = registerSystemToolInstructionAdapter(instructions);
    unregisterWebSearch = registerSystemToolWebSearchAdapter(search);
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
