import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @file The docs Examples check, as an importable library.
 *
 * **Why this module exists.** `scripts/check-api-examples.mjs` was 155 lines of
 * top-level code with hardcoded roots and `process.exit` — untestable by
 * construction. The docs Examples plan (T2, decision D2) generalises it to scan
 * every docs page root (`docs/api`, `docs/guide`, `docs/examples`), resolve
 * include targets to two example pools by path prefix, and add a folder-check
 * family tying `docs/examples/index.md`'s table to the filesystem. Its new
 * branches are covered by fixture-driven unit tests
 * (`scripts/check-api-examples.test.mjs` over
 * `scripts/test-fixtures/check-api-examples/`), which is only possible because
 * the logic lives here: dependency-free (`node:fs`/`node:path`), root-
 * parameterised, and never calling `process.exit` — the CLI
 * (`scripts/check-api-examples.mjs`) owns printing and the exit code, the same
 * caller-decides-how-to-fail split `publishable-packages.mjs` documents.
 *
 * The eight checks:
 *
 *   1. every `<<<` snippet import on a scanned page points at a file that
 *      exists;
 *   2. every region name an import references exists as a `// #region` in that
 *      file, closed by a NAMED `// #endregion` (an unnamed end marker never
 *      closes the region and VitePress silently renders the whole file);
 *   3. every example file in each pool is snippet-imported by at least one
 *      scanned page (no orphans) — pools attributed by include-target prefix:
 *      `@/api/examples/...` → docs/api pool, `@/../examples/...` → repo-root
 *      pool; a target in neither pool gets checks 1–2 only;
 *   4. every page importing at least one example WITHOUT the `.run` suffix
 *      contains the words "type-checked only";
 *   5. every directory under `examples/` is named by exactly one table row's
 *      source link (zero or two rows are both violations);
 *   6. every table row carries exactly one source link resolving to an
 *      existing `examples/<folder>` directory or `docs/api/examples/<file>`;
 *   7. every `examples/` folder holds a root `*.run.ts`, or is named in
 *      `examples/typechecked-only.json`;
 *   8. every `examples/<folder>/package.json` declares `"private": true`.
 *
 * A vacuous pass is never a passing state: a scan root that is missing or holds
 * no pages, or an Examples page with zero parseable rows, is a violation.
 *
 * **What this script deliberately does NOT check:** whether a `.run.ts` is
 * reachable by the example runner's `import.meta.glob`. This script reads text
 * only and never re-implements or parses that glob — the runner
 * (`examples/run-examples.test.ts`) owns the only copy of it and asserts folder
 * coverage itself. Here the script checks the location convention only.
 *
 * The walkers use `lstatSync` semantics (via `readdirSync(..., { withFileTypes:
 * true })`): they never follow a symlink and never enter `node_modules`, which
 * is what workspace membership creates — every example package's
 * `node_modules/@azx/*` is a pnpm symlink after `pnpm install`.
 */

/** The real repo root, derived from this file's location — the CLI's default. */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Directories walked recursively for `.md` pages, relative to the repo root. */
const SCAN_ROOTS = ["docs/api", "docs/guide", "docs/examples"];

/** The Examples page — the folder-check family reads its table. */
const EXAMPLES_PAGE = path.join("docs", "examples", "index.md");

/** The two example pools, relative to the repo root. */
const API_POOL = path.join("docs", "api", "examples");
const ROOT_POOL = "examples";

/** Every source link is this prefix plus the in-repo path the check verifies. */
const SOURCE_LINK_PREFIX = "https://github.com/AZX-PBC-OSS/ribo/tree/main/";

/** Mechanism files, exempt from the orphan check BY NAME — not by a loose pattern. */
const ORPHAN_EXEMPT = new Set(["run-examples.test.ts", "tsconfig.json"]);

// `<<< @/api/examples/file.ts#region` — VitePress snippet import, `@` = docs/.
const SNIPPET_IMPORT = /^<<<\s+@\/(\S+?)(?:#([\w-]+))?\s*$/gm;
const REGION_START = /(?:^|\n)\s*(?:\/\/|#)\s*#region\s+([\w-]+)/g;
// VitePress's findRegion needs a NAMED end marker — an unnamed `#endregion` never closes the
// region and the snippet silently renders the whole file instead. So the gate checks both ends.
const REGION_END = /(?:^|\n)\s*(?:\/\/|#)\s*#endregion\s+([\w-]+)/g;

/**
 * Walk `dir` recursively for files whose name ends in one of `exts`, using
 * lstat semantics: a symlink is never followed and a `node_modules` directory
 * is never entered, at any depth.
 */
function walkFiles(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

/** The directories directly under `examples/` — never symlinks, never `node_modules`. */
function listExampleFolders(examplesDir) {
  return readdirSync(examplesDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== "node_modules",
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * The data rows of `docs/examples/index.md`'s table, as raw line strings.
 *
 * A table is a contiguous block of pipe lines; if its second line is a
 * delimiter row, the first two lines are header + delimiter and the rest are
 * data rows. The URL is extracted from each row by pattern — not by column
 * offset — because Prettier re-pads pipe tables and any offset-keyed parser
 * would rot on the next `pnpm format`.
 */
function parseTableRows(pagePath) {
  const lines = readFileSync(pagePath, "utf8").split("\n");
  const rows = [];
  let block = [];
  const flush = () => {
    if (block.length > 0) {
      const isTable = block.length >= 3 && /^\|[\s:|-]+\|$/.test(block[1].trim());
      if (isTable) rows.push(...block.slice(2));
    }
    block = [];
  };
  for (const line of lines) {
    if (line.trimStart().startsWith("|")) block.push(line);
    else flush();
  }
  flush();
  return rows;
}

/** The in-repo path of each source link in a row line, by pattern. */
function rowSourcePaths(rowLine) {
  const urls = rowLine.match(/https:\/\/github\.com\/AZX-PBC-OSS\/ribo\/tree\/main\/[^\s|)]+/g);
  return (urls ?? []).map((url) => url.slice(SOURCE_LINK_PREFIX.length).replace(/\/+$/, ""));
}

/**
 * Run every check against a repo root laid out the conventional way (`docs/`,
 * `examples/`, `scripts/`). Returns the violation strings (empty when clean)
 * plus the counts the CLI's success line reports.
 *
 * @param {string} [repoRoot] Defaults to the real repo root.
 * @returns {{ violations: string[], pageCount: number, referencedCount: number }}
 */
export function checkDocsExamples(repoRoot = DEFAULT_ROOT) {
  const violations = [];

  // --- Vacuous-pass guards -------------------------------------------------
  const pages = [];
  for (const scanRoot of SCAN_ROOTS) {
    const dir = path.join(repoRoot, scanRoot);
    if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
      violations.push(
        `${scanRoot}/: does not exist — a scan root this gate owns is gone; ` +
          "checking nothing is not a pass.",
      );
      continue;
    }
    const found = walkFiles(dir, [".md"]);
    if (found.length === 0) {
      violations.push(`${scanRoot}/: holds no Markdown pages — nothing to check is not a pass.`);
    }
    pages.push(...found);
  }

  const examplesPage = path.join(repoRoot, EXAMPLES_PAGE);
  if (lstatSync(examplesPage, { throwIfNoEntry: false })?.isFile() !== true) {
    violations.push(
      `${EXAMPLES_PAGE}: does not exist — the Examples page is the table this gate checks.`,
    );
  }

  // --- Checks 1–4: snippet imports, regions, pool membership, wording ------
  const referenced = new Map(); // absolute example path -> Set of referenced region names
  for (const page of pages) {
    const text = readFileSync(page, "utf8");
    const rel = path.relative(repoRoot, page);
    const importsOnPage = [];

    for (const match of text.matchAll(SNIPPET_IMPORT)) {
      const target = path.join(repoRoot, "docs", match[1]);
      const region = match[2];

      if (lstatSync(target, { throwIfNoEntry: false }) === undefined) {
        violations.push(`${rel}: snippet import points at a missing file — ${match[1]}`);
        continue;
      }
      importsOnPage.push(target);

      if (region) {
        const source = readFileSync(target, "utf8");
        const starts = new Set([...source.matchAll(REGION_START)].map((m) => m[1]));
        const ends = new Set([...source.matchAll(REGION_END)].map((m) => m[1]));
        if (!starts.has(region)) {
          violations.push(
            `${rel}: snippet import references region "#${region}", which does not exist in ` +
              `${match[1]} (has: ${[...starts].map((r) => `"${r}"`).join(", ") || "none"})`,
          );
        } else if (!ends.has(region)) {
          violations.push(
            `${rel}: region "#${region}" in ${match[1]} has no named "// #endregion ${region}" ` +
              "— without it VitePress silently renders the whole file as the snippet.",
          );
        }
        const seen = referenced.get(target) ?? new Set();
        seen.add(region);
        referenced.set(target, seen);
      } else if (!referenced.has(target)) {
        referenced.set(target, new Set());
      }
    }

    if (importsOnPage.some((target) => !/\.run\.tsx?$/.test(target))) {
      if (!/type-checked only/i.test(text)) {
        violations.push(
          `${rel}: imports an example without the .run suffix (type-checked, never executed) ` +
            'but does not say "type-checked only" — state the execution status.',
        );
      }
    }
  }

  // --- Check 3: orphans, per pool ------------------------------------------
  for (const pool of [API_POOL, ROOT_POOL]) {
    const poolDir = path.join(repoRoot, pool);
    if (lstatSync(poolDir, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
    for (const file of walkFiles(poolDir, [".ts", ".tsx"])) {
      if (ORPHAN_EXEMPT.has(path.basename(file))) continue;
      if (!referenced.has(file)) {
        violations.push(
          `${path.relative(repoRoot, file)}: no page snippet-imports this example file ` +
            "(orphaned) — import it from a docs page or delete it.",
        );
      }
    }
  }

  // --- The folder-check family (checks 5–8) --------------------------------
  if (lstatSync(examplesPage, { throwIfNoEntry: false })?.isFile() === true) {
    const rows = parseTableRows(examplesPage);
    if (rows.length === 0) {
      violations.push(
        `${EXAMPLES_PAGE}: holds no parseable table rows — an Examples page that lists ` +
          "nothing is not a pass.",
      );
    }

    const rowPaths = rows.map((row) => {
      const paths = rowSourcePaths(row);
      if (paths.length === 0) {
        violations.push(
          `${EXAMPLES_PAGE}: table row carries no source link of the form ` +
            `${SOURCE_LINK_PREFIX}<path> — every row names where its example lives.`,
        );
      } else if (paths.length > 1) {
        violations.push(
          `${EXAMPLES_PAGE}: table row carries ${paths.length} source links — exactly one per row.`,
        );
      }
      return paths[0];
    });

    // Check 6: every row's target exists, in either pool.
    const exampleFolders = listExampleFolders(path.join(repoRoot, ROOT_POOL));
    for (const rowPath of rowPaths) {
      if (rowPath === undefined) continue;
      const folderMatch = /^examples\/([^/]+)$/.exec(rowPath);
      const apiMatch = /^docs\/api\/examples\/([^/]+)$/.exec(rowPath);
      if (folderMatch && exampleFolders.includes(folderMatch[1])) continue;
      if (
        apiMatch &&
        lstatSync(path.join(repoRoot, API_POOL, apiMatch[1]), {
          throwIfNoEntry: false,
        })?.isFile() === true
      ) {
        continue;
      }
      violations.push(
        `${EXAMPLES_PAGE}: table row source link "${rowPath}" resolves to nothing — ` +
          `name an existing directory directly under ${ROOT_POOL}/ or an existing file ` +
          `directly under ${API_POOL}/.`,
      );
    }

    // Checks 5 and 7: one row per folder; runnable-or-exempt.
    let exemptFolders = [];
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(repoRoot, ROOT_POOL, "typechecked-only.json"), "utf8"),
      );
      if (!Array.isArray(parsed)) throw new Error("not an array");
      exemptFolders = parsed.filter((name) => typeof name === "string");
    } catch {
      violations.push(
        `${ROOT_POOL}/typechecked-only.json: missing or not a JSON array of folder names ` +
          "— the check script and the example runner both read it.",
      );
    }
    for (const folder of exampleFolders) {
      const rowsForFolder = rowPaths.filter((p) => p === `${ROOT_POOL}/${folder}`).length;
      if (rowsForFolder === 0) {
        violations.push(
          `${ROOT_POOL}/${folder}: no table row on ${EXAMPLES_PAGE} names this example folder ` +
            "— every example folder has exactly one row.",
        );
      } else if (rowsForFolder > 1) {
        violations.push(
          `${ROOT_POOL}/${folder}: ${rowsForFolder} table rows name this example folder — ` +
            "exactly one row per folder (one idea per row).",
        );
      }

      const folderDir = path.join(repoRoot, ROOT_POOL, folder);
      const hasRootRunFile = readdirSync(folderDir).some((name) => name.endsWith(".run.ts"));
      if (!hasRootRunFile && !exemptFolders.includes(folder)) {
        violations.push(
          `${ROOT_POOL}/${folder}: holds no root *.run.ts and is not named in ` +
            `${ROOT_POOL}/typechecked-only.json — runnable, or declared type-checked only.`,
        );
      }

      // Check 8: private manifests.
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(path.join(folderDir, "package.json"), "utf8"));
      } catch {
        violations.push(
          `${ROOT_POOL}/${folder}/package.json: missing or unparseable — every example ` +
            "is a private package.",
        );
        continue;
      }
      if (manifest.private !== true) {
        violations.push(
          `${ROOT_POOL}/${folder}/package.json: does not declare "private": true — ` +
            "examples are never published and never get a changeset.",
        );
      }
    }
  }

  return { violations, pageCount: pages.length, referencedCount: referenced.size };
}
