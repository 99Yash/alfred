import { RuleTester } from "oxlint/plugins-dev";

import { logCaughtErrorUnderErrRule } from "./log-caught-error-under-err.ts";

// The spec of `log-caught-error-under-err`: only the `err` key goes through the
// redacting serializer of `@alfred/logging`, so a caught error reaches a logger
// call only as the raw value under `err` (PRs #1297, #1303, #1307, #1111).
// The Bad and Good cases come from docs/reference/smells/log-caught-error-under-err.md.
//
// `pnpm check:oxlint-plugin` drives each `invalid` case through the root
// `.oxlintrc.json`. A bare `filename` such as `probe.ts` names only the
// language and keeps the case inside the gate scope.

const tester = new RuleTester();

const notUnderErr = () => ({ messageId: "notUnderErr" });

const errNotRaw = () => ({ messageId: "errNotRaw" });

tester.run("alfred/log-caught-error-under-err", logCaughtErrorUnderErrRule, {
  valid: [
    {
      name: "the raw error under err with safe fields (the smell's Good case)",
      code: 'try { pull(); } catch (err) { logger.warn({ err, integrationId }, "pull failed"); }',
    },
    {
      name: "a binding with another name under err",
      code: 'try { pull(); } catch (error) { logger.warn({ err: error }, "pull failed"); }',
    },
    {
      name: "the safe text form under another key",
      code: 'try { run(); } catch (err) { logger.warn({ err: writeErr, turnError: safeErrorDiagnostic(err) }, "write failed"); }',
    },
    {
      name: "a field that is not free text",
      code: 'try { run(); } catch (err) { logger.warn({ err, code: err.code }, "failed"); }',
    },
    {
      name: "a test of the error",
      code: 'try { run(); } catch (err) { logger.warn({ err, app: err instanceof AppError }, "failed"); }',
    },
    {
      name: "the raw error as the first argument",
      code: 'try { run(); } catch (err) { logger.error(err, "failed"); }',
    },
    {
      name: "a .catch callback that logs the raw error",
      code: 'void load().catch((err) => logger.warn({ err }, "load failed"));',
    },
    {
      name: "a call that is not a logger",
      code: "try { run(); } catch (err) { report({ reason: toMessage(err) }); }",
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a test tree is out of scope",
      filename: "packages/http/test/push.test.ts",
      code: 'try { run(); } catch (err) { logger.warn({ reason: err.message }, "failed"); }',
    },
  ],
  invalid: [
    {
      name: "the error and its message under other keys (the smell's Bad case)",
      filename: "probe.ts",
      code: 'try { pull(); } catch (error) { logger.warn({ error, detail: error.message }, "pull failed"); }',
      errors: [notUnderErr(), notUnderErr()],
    },
    {
      name: "toMessage beside err (#1297)",
      filename: "probe.ts",
      code: 'try { run(); } catch (err) { logger.warn({ err: writeErr, turnError: toMessage(err) }, "write failed"); }',
      errors: [notUnderErr()],
    },
    {
      name: "a redacted message is still free text",
      filename: "probe.ts",
      code: 'try { run(); } catch (err) { logger.error({ err, reason: redactSecrets(toMessage(err)) }, "failed"); }',
      errors: [notUnderErr()],
    },
    {
      name: "a string under err (#1111)",
      filename: "probe.ts",
      code: 'try { run(); } catch (err) { logger.error({ err: toMessage(err) }, "failed"); }',
      errors: [errNotRaw()],
    },
    {
      name: "the message under err",
      filename: "probe.ts",
      code: 'try { run(); } catch (err) { logger.error({ err: err.message }, "failed"); }',
      errors: [errNotRaw()],
    },
    {
      name: "the message in the log text",
      filename: "probe.ts",
      code: "try { run(); } catch (err) { logger.warn({ err }, `failed: ${toMessage(err)}`); }",
      errors: [notUnderErr()],
    },
    {
      name: "a nested object under another key",
      filename: "probe.ts",
      code: 'try { run(); } catch (err) { logger.warn({ details: { cause: err } }, "failed"); }',
      errors: [notUnderErr()],
    },
    {
      name: "a .catch callback that logs the message",
      filename: "probe.ts",
      code: 'void load().catch((err) => logger.warn({ reason: err.message }, "load failed"));',
      errors: [notUnderErr()],
    },
    {
      name: "a member logger",
      filename: "probe.ts",
      code: 'try { run(); } catch (err) { this.logger.info({ cause: err.cause }, "failed"); }',
      errors: [notUnderErr()],
    },
  ],
});
