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
  default:
    process.stderr.write(`unknown test behavior: ${behavior ?? "missing"}\n`, () =>
      process.exit(2),
    );
}
