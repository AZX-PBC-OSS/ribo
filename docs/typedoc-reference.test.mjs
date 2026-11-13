/**
 * Regression tests for the generated API reference — `pnpm docs:api` (TypeDoc via
 * docs/typedoc.json + docs/typedoc.tsconfig.json) and the VitePress config that serves it
 * (docs/.vitepress/config.ts).
 *
 * Guards the rules the generated reference broke (see the reproduction report):
 *
 *   1. Every non-private package under packages/ — and every subpath export
 *      (`@azx/ribo-core/testing`, `@azx/ribo-core/worklet`,
 *      `@azx/ribo-transcriber-ondevice/worker`) — must be a TypeDoc entry point. Subpath
 *      exports whose resolved target ends in `.json` are data, not code, and are exempt:
 *      they have no TypeDoc module to point at (motivated by
 *      `@azx/ribo-adapter-snuggpro/extraction.schema.json`, ADR 0039 — the same rule
 *      `./package.json` already encodes). The list is DERIVED from each package's own
 *      `exports`, so a package added next door is covered automatically rather than by
 *      editing this test.
 *   2. docs/typedoc.tsconfig.json's `include` must cover every entry-point package (the
 *      drift that silently dropped packages), and must set `jsx` once any included
 *      package ships .tsx (ribo-ui-react does).
 *   3. TypeDoc warnings must be configured fatal (`treatWarningsAsErrors`) and the
 *      current entry points must emit ZERO warnings — a dropped package or dead
 *      {@link} then fails `pnpm docs:build` in CI instead of scrolling past.
 *   4. Each package's reference module must be titled by its package name, not the
 *      file path TypeDoc falls back to ("ribo-core/src").
 *   5. The reference sidebar served on every page must stay bounded: config.ts must key
 *      it per package and list only module/category entries, NOT inline every generated
 *      symbol into each of the ~780 pages (which made docs/.vitepress/dist ~379 MB).
 *   6. The hand-written docs/api section is wired into the VitePress config — a nav
 *      entry and a keyed /api/ sidebar — and every page the sidebar links exists.
 *
 * Runs on Node's built-in test runner (`node --test`) because docs/ is not a workspace
 * member and matches no vitest glob; it drives the real scripts, so `pnpm install` must
 * have run first. Generated output (docs/reference/) is gitignored and regenerated here
 * by `pnpm docs:api` — never edited by hand.
 *
 * Run: node --test docs/typedoc-reference.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const DOCS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DOCS, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip line and block comments outside string literals, then JSON.parse. */
function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

function readJson(file) {
  return parseJsonc(readFileSync(file, "utf8"));
}

/** Every non-private, publishable package under packages/ (has `exports`). */
function publishedPackages() {
  const packagesDir = path.join(ROOT, "packages");
  return readdirSync(packagesDir)
    .sort()
    .map((short) => {
      const dir = path.join(packagesDir, short);
      const pkg = readJson(path.join(dir, "package.json"));
      return {
        short,
        name: pkg.name,
        private: pkg.private === true,
        exports: pkg.exports ?? {},
        dir,
      };
    })
    .filter((pkg) => !pkg.private && Object.keys(pkg.exports).length > 0);
}

/** Repo-relative source file a package's export entry resolves to (@azx/source branch). */
function exportSourceFile(pkg, exportKey) {
  const entry = pkg.exports[exportKey];
  const target =
    typeof entry === "string" ? entry : (entry?.["@azx/source"] ?? entry?.types ?? entry?.default);
  assert.ok(typeof target === "string", `${pkg.name} export "${exportKey}" has no string target`);
  return path.relative(ROOT, path.resolve(pkg.dir, target));
}

/** A data subpath — resolved export target ends in `.json` — is not code, so not a TypeDoc entry point. */
function isDataSubpath(pkg, exportKey) {
  return exportSourceFile(pkg, exportKey).endsWith(".json");
}

/**
 * Entry points from docs/typedoc.json, normalized to repo-relative paths regardless of
 * whether the fix writes them docs-relative ("../packages/x/src/index.ts") or
 * root-relative ("./packages/x/src/index.ts").
 */
function typedocEntryPoints() {
  const options = readJson(path.join(DOCS, "typedoc.json"));
  return (options.entryPoints ?? []).map((ep) =>
    path.normalize(ep).replace(/^(\.\.\/)+|^(\.\/)+/, ""),
  );
}

/** `compilerOptions.jsx` values found along a tsconfig's `extends` chain (self first). */
function jsxAlongExtendsChain(file) {
  const json = readJson(file);
  const values = [];
  if (json.compilerOptions?.jsx !== undefined) values.push(json.compilerOptions.jsx);
  if (json.extends) {
    values.push(...jsxAlongExtendsChain(path.resolve(path.dirname(file), json.extends)));
  }
  return values;
}

function walkMarkdownFiles(dir, into = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walkMarkdownFiles(full, into);
    else if (name.isFile() && name.name.endsWith(".md")) into.push(full);
  }
  return into;
}

/** Run `pnpm docs:api` once and cache the result (it exits 0 today; ~5s). */
let docsApiResult;
function runDocsApi() {
  if (!docsApiResult) {
    docsApiResult = spawnSync("pnpm", ["docs:api"], { cwd: ROOT, encoding: "utf8" });
  }
  return docsApiResult;
}

/** The VitePress sidebar object from docs/.vitepress/config.ts (needs generated sidebar JSON). */
async function vitepressSidebar() {
  const config = await import(new URL("./.vitepress/config.ts", import.meta.url).href);
  return config.default.themeConfig.sidebar;
}

function countSidebarLeaves(items) {
  let count = 0;
  for (const item of items) {
    if (Array.isArray(item.items)) count += countSidebarLeaves(item.items);
    else count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("every non-private package and every subpath export is a TypeDoc entry point", () => {
  const entryPoints = typedocEntryPoints();
  const missing = [];
  for (const pkg of publishedPackages()) {
    if (!entryPoints.includes(exportSourceFile(pkg, "."))) missing.push(`${pkg.name} (root)`);
    for (const exportKey of Object.keys(pkg.exports)) {
      if (exportKey === "." || exportKey === "./package.json") continue;
      if (isDataSubpath(pkg, exportKey)) continue;
      if (!entryPoints.includes(exportSourceFile(pkg, exportKey))) {
        missing.push(`${pkg.name} subpath ${exportKey} (${exportSourceFile(pkg, exportKey)})`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `packages/subpaths missing from docs/typedoc.json entryPoints:\n  ${missing.join("\n  ")}`,
  );
});

test("docs/typedoc.tsconfig.json includes every entry-point package and compiles .tsx", () => {
  const tsconfig = readJson(path.join(DOCS, "typedoc.tsconfig.json"));
  const include = new Set(
    (tsconfig.include ?? []).map((inc) => path.normalize(inc).replace(/^(\.\.\/)+|^(\.\/)+/, "")),
  );

  const entryPoints = typedocEntryPoints();
  const missingIncludes = entryPoints
    .map((ep) => path.posix.dirname(ep))
    .filter((dir) => !include.has(dir));
  assert.deepEqual(
    missingIncludes,
    [],
    `entry-point packages missing from docs/typedoc.tsconfig.json include (TypeDoc drops these with a warning):\n  ${missingIncludes.join("\n  ")}`,
  );

  // Once any included package ships .tsx (ribo-ui-react does), the docs tsconfig needs a
  // `jsx` setting somewhere along its extends chain, or TypeDoc cannot read the source.
  const includesTsx =
    entryPoints.some((ep) => ep.endsWith(".ts") === false) ||
    [...include].some((dir) =>
      readdirSync(path.join(ROOT, dir), { withFileTypes: true }).some(
        (d) => d.isFile() && d.name.endsWith(".tsx"),
      ),
    );
  if (includesTsx) {
    const jsxValues = jsxAlongExtendsChain(path.join(DOCS, "typedoc.tsconfig.json"));
    assert.ok(
      jsxValues.length > 0,
      "docs/typedoc.tsconfig.json sets no `jsx` along its extends chain but includes a package containing .tsx files",
    );
  }
});

test("TypeDoc warnings are fatal and the current reference emits none", () => {
  const options = readJson(path.join(DOCS, "typedoc.json"));
  assert.equal(
    options.treatWarningsAsErrors,
    true,
    "docs/typedoc.json must set treatWarningsAsErrors so a dropped package or dead {@link} fails pnpm docs:build",
  );

  const result = runDocsApi();
  const warnings = (result.stdout + result.stderr)
    .split("\n")
    .filter((line) => line.includes("[warning]"));
  assert.deepEqual(
    warnings,
    [],
    `pnpm docs:api emitted ${warnings.length} TypeDoc warnings; fix them at their cause (broken links, dropped entry points):\n  ${warnings.slice(0, 5).join("\n  ")}`,
  );
});

test("each package's reference module is titled by its package name, not its file path", () => {
  const result = runDocsApi();
  assert.equal(result.status, 0, "pnpm docs:api must succeed before checking module titles");

  const h1s = new Set();
  for (const file of walkMarkdownFiles(path.join(DOCS, "reference"))) {
    const match = readFileSync(file, "utf8").match(/^# (.+)$/m);
    if (match) h1s.add(match[1]);
  }

  const untitled = [];
  for (const pkg of publishedPackages()) {
    const bare = pkg.name.replace(/^@azx\//, "");
    if (!h1s.has(pkg.name) && !h1s.has(bare)) {
      untitled.push(
        `${pkg.name} (found: ${[...h1s].filter((h) => h.startsWith(bare)).join(", ") || "no matching module heading"})`,
      );
    }
    for (const exportKey of Object.keys(pkg.exports)) {
      if (exportKey === "." || exportKey === "./package.json") continue;
      if (isDataSubpath(pkg, exportKey)) continue;
      const subName = `${bare}${exportKey.replace(/^\./, "")}`;
      const subScoped = `${pkg.name}${exportKey.replace(/^\./, "")}`;
      if (!h1s.has(subName) && !h1s.has(subScoped)) {
        untitled.push(`${pkg.name} subpath ${exportKey}`);
      }
    }
  }
  assert.deepEqual(
    untitled,
    [],
    `reference modules not titled by package name (e.g. TypeDoc's path fallback "<pkg>/src"):\n  ${untitled.join("\n  ")}`,
  );
});

test("the reference sidebar served on every page stays bounded, not one entry per symbol", async () => {
  const result = runDocsApi();
  assert.equal(result.status, 0, "pnpm docs:api must succeed before checking the sidebar");

  const sidebar = await vitepressSidebar();
  const referenceKeys = Object.keys(sidebar).filter((key) => key.startsWith("/reference/"));
  assert.ok(
    referenceKeys.length > 0,
    "VitePress config defines no sidebar for the /reference/ pages",
  );

  const counts = referenceKeys.map((key) => ({ key, count: countSidebarLeaves(sidebar[key]) }));
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  assert.ok(
    total >= publishedPackages().length,
    `reference sidebar has ${total} entries total; expected at least one module entry per package`,
  );

  // Bound: one package's sidebar may list its modules and their @category groups (~a
  // dozen entries), never the ~770 generated symbols. 100 leaves the fix every slack it
  // needs while still failing the per-symbol inlining that made dist 379 MB.
  const bloated = counts.filter((c) => c.count > 100);
  assert.deepEqual(
    bloated,
    [],
    `sidebar keys inlining every symbol into every reference page (each page carries ~450 KB of shared sidebar):\n  ${bloated.map((c) => `${c.key}: ${c.count} entries`).join("\n  ")}`,
  );
});

test("the docs/api section is wired in: nav entry, keyed sidebar, and every sidebar page exists", async () => {
  runDocsApi(); // config.ts reads the generated typedoc sidebar JSON at import time
  const config = await import(new URL("./.vitepress/config.ts", import.meta.url).href);
  const { nav, sidebar } = config.default.themeConfig;

  assert.ok(
    nav.some((entry) => entry.link === "/api/"),
    "the VitePress nav has no entry linking /api/ — the docs/api section is unreachable from the nav",
  );

  const apiSidebar = sidebar["/api/"];
  assert.ok(apiSidebar, "the VitePress config defines no keyed sidebar for /api/");

  // A sidebar link to a page that does not exist is a dead link VitePress never checks
  // (the dead-link check runs on page content, not on config.ts) — so check it here.
  const missing = [];
  for (const group of apiSidebar) {
    for (const leaf of group.items ?? []) {
      const rel = leaf.link.replace(/^\/api\/?/, "");
      const file =
        rel === "" ? path.join(DOCS, "api", "index.md") : path.join(DOCS, "api", `${rel}.md`);
      if (!existsSync(file)) missing.push(`${leaf.link} -> ${path.relative(ROOT, file)}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `the /api/ sidebar links pages that do not exist under docs/api/:\n  ${missing.join("\n  ")}`,
  );
});

test("every docs/api page is sidebar-linked", async () => {
  runDocsApi(); // config.ts reads the generated typedoc sidebar JSON at import time
  const config = await import(new URL("./.vitepress/config.ts", import.meta.url).href);
  const apiSidebar = config.default.themeConfig.sidebar["/api/"];

  const linked = new Set();
  for (const group of apiSidebar) {
    for (const leaf of group.items ?? []) linked.add(leaf.link);
  }

  // The reverse of the check above: a page under docs/api/ that no sidebar entry
  // links is orphaned content — reachable from nothing.
  const orphaned = [];
  for (const name of readdirSync(path.join(DOCS, "api"))) {
    if (!name.endsWith(".md")) continue;
    const link = name === "index.md" ? "/api/" : `/api/${name.replace(/\.md$/, "")}`;
    if (!linked.has(link)) orphaned.push(link);
  }
  assert.deepEqual(
    orphaned,
    [],
    `docs/api/ holds pages the /api/ sidebar does not link:\n  ${orphaned.join("\n  ")}`,
  );
});

test("whole-file snippet includes render without #region marker lines", async () => {
  // Through VitePress's own renderer, so the hook's ORDER is under test: wired after the snippet
  // plugin, it would run before the file is loaded and strip nothing.
  const { createMarkdownRenderer } = await import("vitepress");
  const config = (await import(new URL("./.vitepress/config.ts", import.meta.url).href)).default;
  const docsDir = fileURLToPath(new URL(".", import.meta.url));
  const md = await createMarkdownRenderer(docsDir, config.markdown, "/");
  const html = md.render("<<< @/api/examples/composing-transcribers.run.ts\n", {
    path: path.join(docsDir, "guide/index.md"),
    relativePath: "guide/index.md",
    cleanUrls: false,
  });
  assert.match(html, /hedgedTranscriber/, "the include rendered the example file");
  assert.doesNotMatch(html, /#(end)?region\b/);
});
