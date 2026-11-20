#!/usr/bin/env node
/**
 * Asserts that every Soroban `#[contractevent]` struct's field names match
 * what docs/architecture/contract-events.md documents for it (#361).
 *
 * Replaces the old `type-drift` CI heuristic, which only checked whether
 * *some* frontend .ts/.tsx file changed alongside contracts/common/src/lib.rs
 * -- true for an unrelated frontend edit, and never triggered when an event
 * field changed somewhere other than contracts/common (where no event
 * structs actually live; they're defined per-contract in donation/src/lib.rs
 * and creator-registry/src/lib.rs). This check instead parses the real
 * struct definitions and the doc's own Rust code blocks and diffs their
 * field names directly, so it only fails when there's an actual mismatch,
 * regardless of which files a given PR touches.
 *
 * Run directly (`node scripts/check-contract-event-drift.js`). Exits
 * non-zero and prints a diagnostic on drift.
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");

const CONTRACT_SOURCES = [
  "contracts/donation/src/lib.rs",
  "contracts/creator-registry/src/lib.rs",
];
const DOC_FILE = "docs/architecture/contract-events.md";

/**
 * Finds every `#[contractevent(...)] ... pub struct Name { ... }` block in
 * Rust source and returns a Map of struct name -> ordered field names.
 * Tolerant of an intervening #[derive(...)] line and #[topic] attributes on
 * individual fields (both present in this codebase's event structs).
 */
function parseRustEventStructs(source) {
  const events = new Map();
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    if (!/^#\[contractevent/.test(lines[i].trim())) continue;

    // Scan forward past any attribute lines (#[derive(...)], #[contractevent]
    // itself) to the struct declaration.
    let j = i + 1;
    while (j < lines.length && /^#\[/.test(lines[j].trim())) j++;

    const structMatch = lines[j].trim().match(/^pub struct (\w+)\s*\{/);
    if (!structMatch) continue;
    const structName = structMatch[1];

    const fields = [];
    j++;
    while (j < lines.length && !lines[j].trim().startsWith("}")) {
      const fieldMatch = lines[j].trim().match(/^pub (\w+):/);
      if (fieldMatch) fields.push(fieldMatch[1]);
      j++;
    }

    events.set(structName, fields);
  }

  return events;
}

/**
 * Finds every ```rust pub struct Name { ... } ``` block inside the
 * architecture doc's markdown and returns the same Map shape as
 * parseRustEventStructs, so the two can be compared directly.
 */
function parseDocEventStructs(markdown) {
  const events = new Map();
  const codeBlockPattern = /```rust\r?\n([\s\S]*?)```/g;

  let match;
  while ((match = codeBlockPattern.exec(markdown)) !== null) {
    const block = match[1];
    const parsed = parseRustEventStructs(`#[contractevent]\n${block}`);
    for (const [name, fields] of parsed) events.set(name, fields);
  }

  return events;
}

function sameFields(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((field, i) => field === sortedB[i]);
}

function main() {
  const failures = [];

  const contractEvents = new Map();
  for (const relativePath of CONTRACT_SOURCES) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    for (const [name, fields] of parseRustEventStructs(source)) {
      contractEvents.set(name, { fields, source: relativePath });
    }
  }

  if (contractEvents.size === 0) {
    failures.push(
      `No #[contractevent] structs found in ${CONTRACT_SOURCES.join(", ")}. ` +
        "Either the contracts changed shape or this check's parser broke -- investigate before trusting a pass."
    );
  }

  const docMarkdown = fs.readFileSync(path.join(REPO_ROOT, DOC_FILE), "utf8");
  const docEvents = parseDocEventStructs(docMarkdown);

  for (const [name, { fields, source }] of contractEvents) {
    const docFields = docEvents.get(name);
    if (docFields === undefined) {
      failures.push(
        `${name} is defined in ${source} but has no matching \`pub struct ${name}\` Rust code block in ${DOC_FILE}.`
      );
      continue;
    }
    if (!sameFields(fields, docFields)) {
      failures.push(
        `${name} field mismatch:\n` +
          `  ${source}: ${fields.join(", ")}\n` +
          `  ${DOC_FILE}: ${docFields.join(", ")}\n` +
          `  Update whichever one is stale so the docs mirror the real event shape.`
      );
    }
  }

  for (const name of docEvents.keys()) {
    if (!contractEvents.has(name)) {
      failures.push(
        `${DOC_FILE} documents \`${name}\`, but no #[contractevent] struct with that name exists in ${CONTRACT_SOURCES.join(" or ")}. ` +
          "Remove the stale doc entry or rename it to match the contract."
      );
    }
  }

  if (failures.length > 0) {
    console.error("Contract event / docs drift detected:\n");
    for (const failure of failures) console.error(`- ${failure}\n`);
    process.exit(1);
  }

  console.log(
    `OK: ${contractEvents.size} contract event struct(s) match their documentation in ${DOC_FILE}.`
  );
}

main();
