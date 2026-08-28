#!/usr/bin/env node
/**
 * The skipped-test inventory, and why it is a gate rather than a list.
 *
 * R1.6 turns five schema groups into collections (plan Task 5) several tasks before `review.ts`
 * learns to address an instance (Tasks 6–7). In that window the schema is arrays and review is
 * not, so every test driving review over the REAL adapter schema must fail. Those tests are
 * skipped rather than deleted, which is the honest choice — but skipped tests rot.
 *
 * A `test.skip` with a comment beside it is invisible to every other gate here: the suite goes
 * green, `./check.sh` passes, and the only thing between a temporary skip and a permanent one is
 * somebody remembering. Two of the eight skips below were not mentioned at all in the report of
 * the run that introduced them, which is exactly how the forgetting starts.
 *
 * So the inventory executes. It pins the repository's exact skip set against the list here and
 * fails BOTH ways: adding a skip without recording it, and leaving a row behind after un-skipping.
 * The list cannot silently grow, and it cannot silently overstate the debt either.
 *
 * **To un-skip:** delete the `test.skip` and delete its row here. This gate tells you if you did
 * one without the other.
 *
 * Lives in `scripts/` rather than as a vitest test on purpose: it is a repo-level concern spanning
 * `packages/` and `playground/`, and it shells out to `git grep`. Putting it inside a package
 * would either misfile it or drag Node types into a browser-targeted package. Same shape as
 * `snugg-descriptions.mjs --check`, and wired into `./check.sh` the same way.
 */

import { execFileSync } from "node:child_process";

/** Each row: the skipped test, the plan task that owes its removal, and why it is blocked. */
const INVENTORY = [
  {
    file: "playground/src/ondevice-extractor-store.test.ts",
    title: "an item extracted on-device is tagged so review can badge it",
    unskippedBy: "Task 10",
    because: "the three-phase on-device extractor still emits flat group objects",
  },
];

/**
 * `skipIf` is deliberately NOT matched. `gate.manual.ts` uses it to skip the acceptance gate when
 * no API key is present — a permanent, correct runtime condition, not deferred work.
 */
function skippedTestsInRepo() {
  const out = execFileSync(
    "git",
    ["grep", "-n", "-E", String.raw`(test|it|describe)\.skip\(`, "--", "packages", "playground"],
    { encoding: "utf8" },
  );

  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [file, , ...rest] = line.split(":");
      const text = rest.join(":");
      const match = /\.skip\(\s*["'`](.*?)["'`]/s.exec(text);
      return { file, title: match?.[1] ?? `UNPARSED: ${text.trim()}` };
    });
}

const key = (s) => `${s.file} :: ${s.title}`;

const found = skippedTestsInRepo();
const unparsed = found.filter((s) => s.title.startsWith("UNPARSED"));

// A title that wraps across lines under prettier would read as UNPARSED and make the comparison
// below fail for the wrong reason. Say so plainly instead.
if (unparsed.length > 0) {
  console.error(
    "skip-inventory: could not read these skip titles — fix the scraper, not the list:",
  );
  for (const u of unparsed) console.error(`  ${u.file}\n    ${u.title}`);
  process.exit(1);
}

const foundKeys = found.map(key).sort();
const recordedKeys = INVENTORY.map(key).sort();

const unrecorded = foundKeys.filter((k) => !recordedKeys.includes(k));
const stale = recordedKeys.filter((k) => !foundKeys.includes(k));

if (unrecorded.length > 0) {
  console.error(
    `skip-inventory: ${unrecorded.length} skipped test(s) are not in the inventory.\n` +
      "A skip that nothing records is a skip nobody removes. Add a row to\n" +
      "scripts/skip-inventory.mjs naming the plan task that owes its removal:",
  );
  for (const k of unrecorded) console.error(`  + ${k}`);
}

if (stale.length > 0) {
  console.error(
    `skip-inventory: ${stale.length} inventory row(s) no longer match a skipped test.\n` +
      "If you un-skipped it, delete the row — otherwise this file overstates the debt:",
  );
  for (const k of stale) console.error(`  - ${k}`);
}

if (unrecorded.length > 0 || stale.length > 0) process.exit(1);

const owed = new Map();
for (const entry of INVENTORY) owed.set(entry.unskippedBy, (owed.get(entry.unskippedBy) ?? 0) + 1);
const summary = [...owed.entries()]
  .sort()
  .map(([task, n]) => `${task}: ${n}`)
  .join(", ");

console.log(`skip-inventory: ${INVENTORY.length} skipped test(s), all recorded — ${summary}`);
