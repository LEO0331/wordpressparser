import { spawnSync } from "node:child_process";

function runNodeTest(extraArgs = []) {
  return spawnSync(
    process.execPath,
    ["--test", ...extraArgs, "test/**/*.test.js"],
    { encoding: "utf8" }
  );
}

function flush(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

// Prefer single-process execution in environments where worker spawns are restricted.
const first = runNodeTest(["--test-isolation=none"]);
flush(first);

if (first.status === 0) {
  process.exit(0);
}

const unsupportedFlag =
  (first.stderr || "").includes("bad option: --test-isolation=none") ||
  (first.stderr || "").includes("unknown option");

if (!unsupportedFlag) {
  process.exit(first.status ?? 1);
}

const second = runNodeTest();
flush(second);
process.exit(second.status ?? 1);
