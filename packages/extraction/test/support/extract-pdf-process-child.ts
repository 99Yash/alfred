import { spawn } from "node:child_process";

const behavior = process.env.PDF_EXTRACTION_TEST_BEHAVIOR;

export {};

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
  case "nonzero":
    process.exit(7);
    break;
  case "nonzero_late_close": {
    const inheritedPipeHolder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1_000)"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    inheritedPipeHolder.unref();
    process.exit(7);
    break;
  }
  case "valid_late_close":
  case "malformed_late_close": {
    const inheritedPipeHolder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1_000)"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    inheritedPipeHolder.unref();
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
  default:
    process.stderr.write(`unknown test behavior: ${behavior ?? "missing"}\n`, () =>
      process.exit(2),
    );
}
