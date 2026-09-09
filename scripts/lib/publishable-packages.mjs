import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * @file The publishable-package roster: one walk, one count, three consumers.
 *
 * **Why this module exists.** `pkg-gates.mjs`, `assert-source-condition.mjs` and
 * `pack-and-consume/index.mjs` each independently walked `packages/` and each
 * carried its own `EXPECTED_PUBLISHED_COUNT`. `pack-and-consume/index.mjs` said
 * so in its own header and named the exit condition: "if a THIRD script ever
 * needs the same discovery, that is the signal to extract it, not this one."
 * Three scripts is where we ended up, and the cost was not hypothetical —
 * adding the eighth package updated two of the three copies, `./check.sh` went
 * green locally, and CI failed on the copy nobody found. The two gates in
 * `check.sh` and the one that is not are exactly the split that hides this.
 *
 * So: the count lives in one place, and adding a package is a one-line change.
 */

/**
 * How many non-private packages `packages/` is expected to hold.
 *
 * **This is a tripwire, not bookkeeping.** Removing a package already fails
 * loudly wherever it is consumed; *adding* one would otherwise be silently
 * ungated — publint, attw, the source-condition assertion and the
 * pack-and-consume tier would all quietly skip it while the green line still
 * read as success. The count is what makes a new package announce itself.
 *
 * When you add or remove a publishable package, change this number, and expect
 * to also register the package with the pack-and-consume scratch app (both its
 * `dependencies` and its `pnpm.overrides`) and with `playground/package.json`.
 */
export const EXPECTED_PUBLISHED_COUNT = 8;

/**
 * Every non-private package under `packages/`, sorted by package name.
 *
 * Derived from the workspace rather than hard-coded: a hard-coded list is a
 * second description of the same truth, and the two drift.
 *
 * Returns `{ dir, name, manifest }` per package — the union of what the three
 * callers need. `dir` is the directory name (`pnpm pack` needs it as a cwd),
 * `name` the manifest name, and `manifest` the parsed `package.json` (the React
 * peer-dependency gate reads it). Callers project down to what they use.
 *
 * A directory whose `package.json` is absent or unparseable is skipped rather
 * than fatal: `packages/` also holds non-package directories, and a malformed
 * manifest fails far more legibly in the tool that actually reads it.
 */
export function discoverPublishablePackages(repoRoot) {
  const packagesDir = path.join(repoRoot, "packages");
  const found = [];
  for (const dirent of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const manifestPath = path.join(packagesDir, dirent.name, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (manifest.private) continue;
    found.push({ dir: dirent.name, name: manifest.name, manifest });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

/**
 * The shared "wrong number of packages" message.
 *
 * Only the message is shared; each caller still decides how to fail, because
 * they genuinely differ — two print and `process.exit(1)`, one throws into an
 * existing handler. Forcing one exit strategy on all three would make this
 * module decide something it has no business deciding.
 */
export function unexpectedCountMessage(found) {
  return (
    `discovered ${found.length} publishable packages, expected ${EXPECTED_PUBLISHED_COUNT} ` +
    `(${found.map((p) => p.name).join(", ")}). If you added or removed a publishable package, ` +
    "update EXPECTED_PUBLISHED_COUNT in scripts/lib/publishable-packages.mjs."
  );
}
