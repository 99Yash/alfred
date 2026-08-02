import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listGitSourceFiles } from "./git-source-files.mjs";

export function gitSourceFileSelfTestFailures() {
  const failures = [];
  const fixture = mkdtempSync(join(tmpdir(), "alfred-git-source-files-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
    writeFileSync(join(fixture, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(fixture, "tracked.ts"), "export {};\n");
    writeFileSync(join(fixture, "untracked.ts"), "export {};\n");
    writeFileSync(join(fixture, "ignored.ts"), "export {};\n");
    writeFileSync(join(fixture, "deleted.ts"), "export {};\n");
    execFileSync("git", ["add", ".gitignore", "tracked.ts", "deleted.ts"], { cwd: fixture });
    unlinkSync(join(fixture, "deleted.ts"));

    const files = listGitSourceFiles(["*.ts"], fixture);
    const expected = ["tracked.ts", "untracked.ts"];
    if (JSON.stringify(files) !== JSON.stringify(expected)) {
      failures.push(
        `source discovery must include tracked and untracked files, exclude ignored files, and exclude deleted files: expected ${JSON.stringify(expected)}, received ${JSON.stringify(files)}`,
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const failures = gitSourceFileSelfTestFailures();
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log("git-source-files self-test passed.");
}
