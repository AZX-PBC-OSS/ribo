import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { DEFAULT_DIR } from "./run-store.js";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));

test("the store's default directory is the gitignored runs-legacy directory beside the acceptance tree", () => {
  // Observed through the exported constant, never by opening a default store: a
  // default-opened store would write into acceptance/runs-legacy/ on every test run.
  // The existing tests keep passing a temp dir as today.
  expect(DEFAULT_DIR).toBe(join(HERE, "runs-legacy"));
});

test("the old-format records are gone and nothing is tracked under runs/ or runs-legacy/", () => {
  // The two old-format records were deleted from the tree (git history keeps them);
  // restoring either back into acceptance/runs/ turns this red.
  expect(existsSync(join(HERE, "runs", "current-codex-cli.json"))).toBe(false);
  expect(existsSync(join(HERE, "runs", "history-codex-cli.jsonl"))).toBe(false);
  // Nothing under the committed records directory or the legacy directory is git-tracked:
  // the legacy directory starts empty whenever the gate next writes there, and no history
  // file is recreated or migrated anywhere.
  const tracked = (dir: string): string =>
    execFileSync("git", ["ls-files", "--", dir], { cwd: HERE, stdio: "pipe" }).toString().trim();
  expect(tracked("runs")).toBe("");
  expect(tracked("runs-legacy")).toBe("");
});

test("git ignores a record under runs-legacy/ and does not ignore one under runs/", () => {
  // check-ignore judges hypothetical paths without writing anything into the repo.
  const ignored = (relative: string): boolean => {
    try {
      execFileSync("git", ["check-ignore", "-q", relative], { cwd: HERE, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };
  expect(ignored("runs-legacy/current-codex-cli.json")).toBe(true);
  expect(ignored("runs/current-codex-cli.json")).toBe(false);
});

test("the acceptance README names the legacy directory and the ribo eval --out flow", () => {
  const readme = readFileSync(join(HERE, "README.md"), "utf8");
  expect(readme).toMatch(/runs-legacy/);
  expect(readme).toMatch(/ribo eval --out/);
});
