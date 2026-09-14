import { spawn } from "node:child_process";

const behavior = process.env.PDF_EXTRACTION_TEST_BEHAVIOR;

export {};

/**
 * Hold the inherited stdout open past this child's own exit, the way a
 * grandchild that inherits the pipe does in production. The parent settles on
 * `close`, so this delay is what every `*_late_close` case measures against.
 *
 * The duration comes from the test, not from here, because the test asserts
 * against it and one number cannot live in two files. A missing or unusable
 * value THROWS rather than defaulting: a silent fallback to "no delay at all"
 * would turn every late-close case into a plain case that still reads green.
 *
 * It throws rather than exiting with a chosen code, because every caller below
 * exits synchronously on the next line. `process.exit` inside a `write`
 * callback never runs — the caller's own exit wins the race — so the guard
 * would fire in only the two cases that have nothing left to do.
 */
function holdInheritedPipes(): void {
  const raw = process.env.PDF_EXTRACTION_TEST_HOLD_MILLISECONDS;
  const holdMilliseconds = raw === undefined ? Number.NaN : Number(raw);

  if (!Number.isSafeInteger(holdMilliseconds) || holdMilliseconds <= 0) {
    throw new Error(
      `PDF_EXTRACTION_TEST_HOLD_MILLISECONDS must be a positive integer, got ${raw ?? "nothing"}`,
    );
  }

  const inheritedPipeHolder = spawn(
    process.execPath,
    ["-e", `setTimeout(() => {}, ${String(holdMilliseconds)})`],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  inheritedPipeHolder.unref();
}

for await (const _chunk of process.stdin) {
  // Consume the complete request before the fixture chooses its reply. This
  // keeps an expected early exit from becoming a parent-side EPIPE race.
}

switch (behavior) {
  case "hang":
    setInterval(() => undefined, 1_000);
    break;
  case "malformed":
    process.stdout.write("not-json\n", () => process.exit(0));
    break;
  case "multiple":
    process.stdout.write(
      '{"kind":"result","result":{"kind":"encrypted"}}\n' +
        '{"kind":"result","result":{"kind":"encrypted"}}\n',
      () => process.exit(0),
    );
    break;
  case "oversized":
    process.stdout.write("x".repeat(2_000_000), () => process.exit(0));
    break;
  case "oversized_late_close": {
    holdInheritedPipes();
    process.stdout.write("x".repeat(2_000_000), () => process.exit(0));
    break;
  }

  case "nonzero":
    process.exit(7);
    break;
  case "nonzero_late_close": {
    holdInheritedPipes();
    process.exit(7);
    break;
  }

  case "valid_late_close":
  case "malformed_late_close": {
    holdInheritedPipes();

    const reply =
      behavior === "valid_late_close"
        ? '{"kind":"result","result":{"kind":"encrypted"}}\n'
        : "not-json\n";

    process.stdout.write(reply, () => process.exit(0));
    break;
  }

  case "invalid_limit_equal":
    process.stdout.write(
      '{"kind":"result","result":{"kind":"limit_exceeded","limit":"output_characters","actual":10,"maximum":10,"message":"PDF output character limit exceeded: 10 > 10"}}\n',
      () => process.exit(0),
    );
    break;
  case "invalid_limit_message":
    process.stdout.write(
      '{"kind":"result","result":{"kind":"limit_exceeded","limit":"output_characters","actual":11,"maximum":10,"message":"not canonical"}}\n',
      () => process.exit(0),
    );
    break;
  case "dependency_error":
    process.stdout.write(
      '{"kind":"dependency_error","error":{"source":"pdf_extraction","name":"SyntheticVendorError","message":"synthetic vendor failure","code":"E_SYNTHETIC"}}\n',
      () => process.exit(0),
    );
    break;
  default:
    process.stderr.write(`unknown test behavior: ${behavior ?? "missing"}\n`, () =>
      process.exit(2),
    );
}
