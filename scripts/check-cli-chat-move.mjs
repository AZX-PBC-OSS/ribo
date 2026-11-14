#!/usr/bin/env node
/**
 * @file The move check: the CLI transport moved into `@azx/ribo-cli` as a
 * PURE move, and this script proves it.
 *
 * The move's whole claim is "the file is byte-identical to its original apart
 * from its location, its import specifiers and its header comment". A claim
 * like that is worth nothing without a mechanical check, and the check has to
 * be re-runnable by any reviewer — so it is a committed script, not a
 * one-off.
 *
 * It compares two git blobs: the file at the MOVE COMMIT's parent (still at
 * its old path) and the file at the MOVE COMMIT (at its new path). Anchoring
 * both sides on the commit's SHA is what makes the check immune to whatever
 * comes later — the model-flag change that lands in the next commit touches
 * the same file, and a check against the working tree would go red the moment
 * it does.
 *
 * It is deliberately NOT wired into `./check.sh` or CI: it proves one
 * historical commit, it needs git history, and it gates nothing ongoing. Its
 * output belongs in the pull request, where a reviewer can re-run it.
 *
 *   node scripts/check-cli-chat-move.mjs <move-commit-sha>
 */
import { execFileSync } from "node:child_process";

/** The file's path before the move. */
const ORIGINAL_PATH = "packages/ribo-adapter-snuggpro/acceptance/cli-chat.ts";
/** The file's path after the move. */
const MOVED_PATH = "packages/ribo-cli/src/cli-chat.ts";
/** The test's path before the move. */
const ORIGINAL_TEST_PATH = "packages/ribo-adapter-snuggpro/acceptance/cli-chat.test.ts";
/** The test's path after the move. */
const MOVED_TEST_PATH = "packages/ribo-cli/src/cli-chat.test.ts";

/**
 * The TypeDoc escape hatch, one entry per substitution.
 *
 * The moved body carries two `{@link}` references to symbols the docs do not
 * include (`CLI_BACKENDS` and `CliUnavailableError` — both internal), and
 * TypeDoc's `notExported` validation refuses a link to a symbol that is
 * resolved but not documented. The move converts exactly those two
 * references to plain code spans, and this list is what keeps the
 * byte-comparison honest: each entry names the TypeDoc warning that forced
 * it, so an entry cannot be added silently.
 *
 * Each warning, verbatim, from `pnpm docs:api`:
 *   "The comment for @azx/ribo-cli.CliBackendName links to "CLI_BACKENDS"
 *    which was resolved but is not included in the documentation."
 *   "The comment for @azx/ribo-cli.CliChatOptions.onShapeResult links to
 *    "CliUnavailableError" which was resolved but is not included in the
 *    documentation."
 *   "The comment for cliChat links to "ChatClient" which was resolved but is not
 *    included in the documentation." (the scoped CLI-entry run, which does not
 *    include @azx/ribo-core)
 */
const SUBSTITUTIONS = [
  {
    from: "{@link CLI_BACKENDS}",
    to: "`CLI_BACKENDS`",
    reason: "TypeDoc: CLI_BACKENDS is resolved but not included in the documentation.",
  },
  {
    from: "{@link CliUnavailableError}",
    to: "`CliUnavailableError`",
    reason: "TypeDoc: CliUnavailableError is resolved but not included in the documentation.",
  },
  {
    from: "{@link ChatClient}",
    to: "`ChatClient`",
    reason:
      "TypeDoc (the scoped CLI-entry run): ChatClient lives in @azx/ribo-core, which that run " +
      "does not include, so the link resolves but is not documented.",
  },
];

/** Read a blob out of git. */
const gitShow = (ref) => {
  try {
    return execFileSync("git", ["show", ref], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    process.stderr.write(`FAIL: could not read ${ref} from git: ${error.message}\n`);
    process.exit(2);
  }
};

/**
 * Split a file into its head (everything up to and including its last
 * top-level import statement) and its tail (the rest).
 *
 * The head is the region the move is allowed to change: the file header, the
 * imports and the import-block comment. The tail is the code, and it must
 * match byte for byte.
 */
function splitHead(text) {
  const lines = text.split("\n");
  let headEnd = -1;
  let inImport = false;
  for (const [index, line] of lines.entries()) {
    if (!inImport && /^import\b/.test(line)) {
      inImport = true;
      if (line.trimEnd().endsWith(";")) {
        headEnd = index;
        inImport = false;
      }
      continue;
    }
    if (inImport && line.trimEnd().endsWith(";")) {
      headEnd = index;
      inImport = false;
    }
  }
  if (headEnd === -1) {
    throw new Error("the file has no top-level import statement — the head cannot be split");
  }
  return {
    head: lines.slice(0, headEnd + 1).join("\n"),
    tail: lines.slice(headEnd + 1).join("\n"),
  };
}

/** The import specifiers a file's head names, as a sorted set. */
function importSpecifiers(head) {
  const specifiers = new Set();
  for (const match of head.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
    specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

/** Apply the escape hatch's substitutions to a text. */
function substitute(text) {
  let out = text;
  for (const entry of SUBSTITUTIONS) {
    out = out.split(entry.from).join(entry.to);
  }
  return out;
}

/** The first differing line of two texts, or null when they are identical. */
function firstDifference(left, right) {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  for (let index = 0; index < Math.max(leftLines.length, rightLines.length); index++) {
    if (leftLines[index] !== rightLines[index]) {
      return {
        line: index + 1,
        original: leftLines[index] ?? "<end of file>",
        moved: rightLines[index] ?? "<end of file>",
      };
    }
  }
  return null;
}

/** A line diff of two texts, for the human review of the head. */
function lineDiff(left, right) {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  // A simple LCS table — the heads are short, so the quadratic table is fine.
  const table = Array.from({ length: leftLines.length + 1 }, () =>
    new Array(rightLines.length + 1).fill(0),
  );
  for (let i = leftLines.length - 1; i >= 0; i--) {
    for (let j = rightLines.length - 1; j >= 0; j--) {
      table[i][j] =
        leftLines[i] === rightLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < leftLines.length && j < rightLines.length) {
    if (leftLines[i] === rightLines[j]) {
      out.push(`  ${leftLines[i]}`);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(`- ${leftLines[i]}`);
      i++;
    } else {
      out.push(`+ ${rightLines[j]}`);
      j++;
    }
  }
  while (i < leftLines.length) out.push(`- ${leftLines[i++]}`);
  while (j < rightLines.length) out.push(`+ ${rightLines[j++]}`);
  return out.join("\n");
}

/** Fail with the reason named. */
function fail(reason) {
  process.stderr.write(`FAIL: ${reason}\n`);
  process.exit(1);
}

// A reviewer who pipes this into `head` closes the pipe early; that is not a
// failure of the check.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
});

/**
 * The check itself: two files, the original and the moved one.
 *
 * @param original - The file's content before the move.
 * @param moved - The file's content after the move.
 * @param originalTest - The test's content before the move.
 * @param movedTest - The test's content after the move.
 * @param label - What the two sides are, for the messages.
 */
function compare(original, moved, originalTest, movedTest, label) {
  const originalParts = splitHead(original);
  const movedParts = splitHead(moved);

  const originalSpecifiers = importSpecifiers(originalParts.head);
  const movedSpecifiers = importSpecifiers(movedParts.head);
  if (originalSpecifiers.join(",") !== movedSpecifiers.join(",")) {
    fail(
      `${label}: the import specifiers changed\n  original: ${originalSpecifiers.join(", ")}\n` +
        `  moved:    ${movedSpecifiers.join(", ")}`,
    );
  }

  const expectedTail = substitute(originalParts.tail);
  const difference = firstDifference(expectedTail, movedParts.tail);
  if (difference !== null) {
    fail(
      `${label}: the body differs from the original at line ${difference.line}\n` +
        `  original: ${difference.original}\n  moved:    ${difference.moved}`,
    );
  }

  const testDifference = firstDifference(originalTest, movedTest);
  if (testDifference !== null) {
    fail(
      `the moved test differs from the original at line ${testDifference.line}\n` +
        `  original: ${testDifference.original}\n  moved:    ${testDifference.moved}`,
    );
  }

  process.stdout.write(`PASS: ${label}\n`);
  process.stdout.write(
    `  the body below the import block is byte-identical` +
      `${SUBSTITUTIONS.length === 0 ? "" : ` (modulo ${SUBSTITUTIONS.length} documented substitution(s))`}\n`,
  );
  process.stdout.write(`  the import specifiers are unchanged: ${movedSpecifiers.join(", ")}\n`);
  process.stdout.write("  the moved test file is byte-identical in full\n");
  for (const entry of SUBSTITUTIONS) {
    process.stdout.write(`  substitution: ${entry.from} -> ${entry.to} (${entry.reason})\n`);
  }
  process.stdout.write("\n--- the head diff (the header rewrite, for review) ---\n");
  process.stdout.write(`${lineDiff(originalParts.head, movedParts.head)}\n`);
}

const argument = process.argv[2];
if (argument === undefined) {
  process.stderr.write("usage: node scripts/check-cli-chat-move.mjs <move-commit-sha>\n");
  process.exit(2);
}

compare(
  gitShow(`${argument}^:${ORIGINAL_PATH}`),
  gitShow(`${argument}:${MOVED_PATH}`),
  gitShow(`${argument}^:${ORIGINAL_TEST_PATH}`),
  gitShow(`${argument}:${MOVED_TEST_PATH}`),
  `the move at ${argument}`,
);
