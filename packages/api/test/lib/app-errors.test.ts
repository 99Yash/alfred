import assert from "node:assert/strict";
import { test } from "node:test";

import { AppError, toPublicAppError } from "../../src/lib/app-errors";
import { serializeError } from "../../src/lib/logger";

const RAW_SQL = 'Failed query: insert into "artifacts" ("user_id") values ($1) params: usr_private';

test("unknown errors become a closed generic public error", () => {
  const result = toPublicAppError(new Error(RAW_SQL));
  assert.deepEqual(result, {
    code: "tool_execution_failed",
    message: "The tool failed unexpectedly. Please try again.",
  });
  assert.ok(!JSON.stringify(result).includes("usr_private"));
});

test("registered errors keep their public code without exposing their cause", () => {
  const result = toPublicAppError(
    new AppError("artifact_create_failed", { cause: new Error(RAW_SQL) }),
  );
  assert.deepEqual(result, {
    code: "artifact_create_failed",
    message: "Saving the artifact failed; nothing was created.",
  });
});

test("logger serializer allowlists database diagnostics and drops SQL and params", () => {
  const cause = Object.assign(new Error("private detail"), {
    code: "23503",
    constraint: "artifacts_message_id_chat_messages_id_fk",
    detail: "Key (message_id)=(msg_private) is not present",
  });
  const drizzleWrapper = new Error(RAW_SQL, { cause });
  const serialized = serializeError(
    new AppError("artifact_create_failed", { cause: drizzleWrapper }),
  );
  const text = JSON.stringify(serialized);
  assert.equal(serialized.database?.code, "23503");
  assert.equal(serialized.database?.constraint, "artifacts_message_id_chat_messages_id_fk");
  assert.ok(!text.includes("usr_private"));
  assert.ok(!text.includes("msg_private"));
  assert.ok(!text.includes("Failed query"));
});
