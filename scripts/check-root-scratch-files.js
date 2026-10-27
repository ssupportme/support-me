#!/usr/bin/env node
/**
 * Guard against leftover one-off merge-conflict scratch files at the
 * repository root (see issue #362).
 *
 * These scripts hardcode "<<<<<<< HEAD" markers and were meant to be run once
 * against specific files. Committing them again would invite a new contributor
 * to run them on their working tree, so the guard fails the build when any of
 * the known names reappears.
 *
 * Usage:
 *   node scripts/check-root-scratch-files.js
 *   node scripts/check-root-scratch-files.js --self-test
 *
 * The self-test proves the guard itself works: it creates a temporary tree
 * containing resolve.py and asserts the check rejects it.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FORBIDDEN = [
  "extract.py",
  "fix_both.py",
  "fix_conflicts.py",
  "fix_vec.py",
  "resolve.py",
  "resolve_tests.py",
  "pr.md",
];

function findForbidden(root) {
  return FORBIDDEN.filter((name) => fs.existsSync(path.join(root, name)));
}

function check(root) {
  const found = findForbidden(root);
  if (found.length > 0) {
    console.error(
      `Forbidden scratch files at the repository root (${root}): ${found.join(", ")}`,
    );
    return 1;
  }
  console.log("No leftover scratch files at the repository root.");
  return 0;
}

function selfTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-guard-"));
  try {
    fs.writeFileSync(path.join(tempRoot, "resolve.py"), "# fixture\n");
    if (check(tempRoot) !== 1) {
      console.error("self-test failed: the guard accepted a tree containing resolve.py");
      return 1;
    }
    console.log("self-test passed: the guard rejects resolve.py.");
    return 0;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-test")) {
  process.exit(selfTest());
}
process.exit(check(process.cwd()));
