import assert from "node:assert/strict";
import { test } from "node:test";

import { AppError, toPublicAppError } from "../../src/lib/app-errors";
import { createLogger, safeErrorDiagnostic, serializeError } from "../../src/lib/logger";

const RAW_SQL = 'Failed query: insert into "artifacts" ("user_id") values ($1) params: usr_private';

test("unknown errors become a closed generic public error", () => {
  const result = toPublicAppError(new Error(RAW_SQL));
  assert.deepEqual(result, {
    code: "tool_execution_failed",
    message: "The tool failed unexpectedly. Please try again.",
  });
  assert.ok(!JSON.stringify(result).includes("usr_private"));
});

test("partial tool failures use an explicit safe fallback without exposing their cause", () => {
  const result = toPublicAppError(new Error(RAW_SQL), "calendar_account_read_failed");
  assert.deepEqual(result, {
    code: "calendar_account_read_failed",
    message: "A connected Calendar account could not be read. Reconnect it in settings.",
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
  assert.equal(
    safeErrorDiagnostic(new AppError("artifact_create_failed", { cause: drizzleWrapper })),
    "artifact_create_failed sqlstate=23503 constraint=artifacts_message_id_chat_messages_id_fk",
  );
});

test("logger serializer retains stack frames but drops every multiline message line", () => {
  const err = new Error("Failed query: insert into secrets values ($1)\nparams: sk_private");
  err.stack = `${err.name}: ${err.message}\n    at executeQuery (/srv/db.ts:42:7)`;

  const serialized = serializeError(err);

  assert.equal(serialized.stack, "at executeQuery (/srv/db.ts:42:7)");
  assert.doesNotMatch(JSON.stringify(serialized), /sk_private|params:|insert into/i);
});

test("application error codes are not mislabeled as database diagnostics", () => {
  const serialized = serializeError(new AppError("artifact_create_failed"));
  assert.equal(serialized.database, undefined);
  assert.equal(
    safeErrorDiagnostic(new AppError("artifact_create_failed")),
    "artifact_create_failed",
  );
});

test("configured pino logger never writes raw error messages", () => {
  let output = "";
  const destination = {
    write(chunk: string) {
      output += chunk;
    },
  };
  const testLogger = createLogger(destination);
  testLogger.error({ err: new Error(RAW_SQL) }, "safe public message");
  assert.match(output, /safe public message/);
  assert.doesNotMatch(output, /usr_private|Failed query|insert into/i);
});

test("verbose serializer surfaces provider APICallError diagnostics for dev", () => {
  const apiCallError = Object.assign(
    new Error("tools.9.custom.input_schema.type: Field required"),
    {
      name: "AI_APICallError",
      statusCode: 400,
      url: "https://api.anthropic.com/v1/messages",
      responseBody: `body-${"x".repeat(10_000)}`,
    },
  );

  const strict = serializeError(apiCallError);
  assert.equal(strict.message, undefined);
  assert.equal(strict.statusCode, undefined);

  const verbose = serializeError(apiCallError, true);
  assert.equal(verbose.type, "AI_APICallError");
  assert.equal(verbose.message, "tools.9.custom.input_schema.type: Field required");
  assert.equal(verbose.statusCode, 400);
  assert.equal(verbose.url, "https://api.anthropic.com/v1/messages");
  // Response body is retained but capped so a large provider body can't flood logs.
  assert.ok(verbose.responseBody !== undefined && verbose.responseBody.length <= 4_000);
});

test("verbose logger writes the raw message; default logger does not", () => {
  const err = new Error("tools.9.custom.input_schema.type: Field required");

  let verboseOut = "";
  createLogger({ write: (c: string) => (verboseOut += c) }, { verboseErrors: true }).error(
    { err },
    "chat turn failed",
  );
  assert.match(verboseOut, /Field required/);

  let strictOut = "";
  createLogger({ write: (c: string) => (strictOut += c) }, { verboseErrors: false }).error(
    { err },
    "chat turn failed",
  );
  assert.doesNotMatch(strictOut, /Field required/);
});
