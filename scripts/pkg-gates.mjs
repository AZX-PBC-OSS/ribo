#!/usr/bin/env node
/**
 * @file The two publishing gates from doc 10 §8 that publint and attw do not cover.
 *
 *   1. No TypeScript source in any tarball. `.d.ts` files are expected; a `.ts`
 *      that is not a declaration means `files`/`exports` leaked source, and a host
 *      app would be handed TypeScript it cannot compile.
 *   2. Exactly one resolved React. Duplicate React silently breaks hooks in a
 *      consumer's app, and a published library is the usual way it happens.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = [
  "ribo-core",
  "ribo-ui-react",
  "ribo-adapter-snuggpro",
  "ribo-extractor-openai",
  "ribo-transcriber-ondevice",
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

/**
 * Parses the file list from `pnpm pack --dry-run` output.
 *
 * The list is every non-empty line strictly BETWEEN the `Tarball Contents` and
 * `Tarball Details` boundary lines. Returns `{ ok: false, reason }` if either
 * boundary is missing, if `Tarball Details` does not come after `Tarball
 * Contents`, or if the section has no entries — in all those cases the offender
 * filter would find nothing regardless, so the gate must refuse to pass rather
 * than report a vacuous zero offenders.
 */
function parseTarballContents(output) {
  const lines = output.split("\n").map((line) => line.trim());
  const start = lines.indexOf("Tarball Contents");
  if (start === -1) {
    return { ok: false, reason: 'no "Tarball Contents" boundary' };
  }
  const end = lines.indexOf("Tarball Details", start + 1);
  if (end === -1) {
    return { ok: false, reason: 'no "Tarball Details" boundary after "Tarball Contents"' };
  }
  const files = lines.slice(start + 1, end).filter((line) => line.length > 0);
  if (files.length === 0) {
    return { ok: false, reason: "no entries between the boundaries" };
  }
  return { ok: true, files };
}

// --- Gate 1: no TypeScript source in the tarball -----------------------------
for (const pkg of PACKAGES) {
  const cwd = path.join(repoRoot, "packages", pkg);
  const output = execFileSync("pnpm", ["pack", "--dry-run"], { cwd, encoding: "utf8" });

  // Defensive: if the output format is not understood, the offender filter would
  // find nothing regardless — a vacuous pass. Fail loudly instead of silently
  // checking zero files.
  const parsed = parseTarballContents(output);
  if (!parsed.ok) {
    failures.push(
      `${pkg}: pnpm pack --dry-run output format not understood ` +
        `(${parsed.reason}) — gate is not vacuous, refusing to pass`,
    );
    continue;
  }

  // A declaration is `.d.ts` / `.d.mts` / `.d.cts`; anything else ending in a
  // TypeScript extension — including `.tsx` — is source that must not ship.
  // `.d.tsx` is not a real thing, so it is not exempted.
  const offenders = parsed.files.filter(
    (line) => /\.(m|c)?tsx?$/.test(line) && !/\.d\.(m|c)?ts$/.test(line),
  );

  if (offenders.length > 0) {
    failures.push(`${pkg}: TypeScript source in the tarball -> ${offenders.join(", ")}`);
  }
}

// --- Gate 2: exactly one resolved React --------------------------------------
// Read pnpm's content-addressed store directly rather than parsing `pnpm ls`
// output: the directory names ARE the resolved versions, so this cannot drift with
// a reporter change. Peer-suffixed entries like `react-dom@19.2.8(react@19.2.8)`
// do not match, because the pattern is anchored.
const reactVersions = new Set(
  readdirSync(path.join(repoRoot, "node_modules/.pnpm"))
    .filter((entry) => /^react@\d/.test(entry))
    .map((entry) => entry.slice("react@".length)),
);

if (reactVersions.size === 0) {
  failures.push(
    "no resolved React found in node_modules/.pnpm — the workspace is not " +
      "installed or the detection broke. The gate proved nothing, so it cannot " +
      "pass. (Expected exactly one react@* entry.)",
  );
} else if (reactVersions.size > 1) {
  failures.push(
    `more than one resolved React: ${[...reactVersions].join(", ")}. ` +
      "One React is a stacked defense (doc 10 §5): peer+dev deps, a single catalog " +
      "version, and resolve.dedupe. Check which package widened its range.",
  );
}

if (failures.length > 0) {
  console.error("Package gates failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `package gates: ${PACKAGES.length} tarballs carry no TypeScript source; ` +
    `one resolved React (${[...reactVersions].join(", ")})`,
);
