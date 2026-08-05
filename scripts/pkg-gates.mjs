#!/usr/bin/env node
/**
 * @file The three publishing gates from doc 10 §8 that publint and attw do not cover.
 *
 *   1. No TypeScript source in any tarball. `.d.ts` files are expected; a `.ts`
 *      that is not a declaration means `files`/`exports` leaked source, and a host
 *      app would be handed TypeScript it cannot compile.
 *   2. Exactly one resolved React. Duplicate React silently breaks hooks in a
 *      consumer's app, and a published library is the usual way it happens.
 *   3. React/react-dom declared as peer dependencies, not regular dependencies,
 *      in any publishable package that uses them. A published library moving
 *      React out of `peerDependencies` is the actual mechanism by which a
 *      consumer ends up with two Reacts — the copy count in gate 2 alone cannot
 *      see that, since this workspace's single catalog version makes duplication
 *      impossible to detect here.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

// Derive the publishable packages from the workspace rather than hard-coding a
// list: removing a package fails loudly below (count mismatch), but ADDING one
// would be silently ungated while the green line still reads as success. The
// non-private packages under packages/ are the publishable set. We keep both the
// directory name (for `pnpm pack --dry-run` cwd) and the parsed manifest (for
// the React peer-dep gate below).
const packagesDir = path.join(repoRoot, "packages");
const publishable = [];
for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const manifestPath = path.join(packagesDir, dir.name, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    continue;
  }
  if (manifest.private) continue;
  publishable.push({ dir: dir.name, name: manifest.name, manifest });
}
publishable.sort((a, b) => a.name.localeCompare(b.name));

const EXPECTED_PUBLISHED_COUNT = 5;
if (publishable.length !== EXPECTED_PUBLISHED_COUNT) {
  console.error(
    `pkg-gates: discovered ${publishable.length} publishable packages, expected ` +
      `${EXPECTED_PUBLISHED_COUNT} (${publishable.map((p) => p.name).join(", ")}). ` +
      "If you added or removed a package, update EXPECTED_PUBLISHED_COUNT.",
  );
  process.exit(1);
}

/**
 * Parses the file list from `pnpm pack --dry-run` output.
 *
 * The list is every non-empty line strictly BETWEEN the `Tarball Contents` and
 * `Tarball Details` boundary lines. Returns `{ ok: false, reason }` if either
 * boundary is missing, if `Tarball Details` does not come after `Tarball
 * Contents`, if the section has no entries, or if any entry is not a bare
 * relative path (no whitespace; a dotted extension is deliberately not
 * required — extensionless entries like LICENSE are legitimate) — in all those
 * cases the offender filter cannot be trusted to find real source leaks, so the
 * gate must refuse to pass rather than report a vacuous zero offenders.
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
  // A bare path only — no whitespace. This deliberately does NOT require a dotted
  // extension: extensionless entries like LICENSE are legitimate, and rejecting them
  // would fail the gate on valid output. What we ARE guarding is trailing text after
  // the path (a hypothetical `dist/index.js (1.2 kB)` format), which would defeat the
  // $-anchored extension match below and let every package pass.
  //
  // Known limitation, accepted: a filename genuinely containing a space would be
  // reported as format-not-understood. That case is indistinguishable from
  // path-plus-trailing-text, so failing loudly is the correct direction, and no file
  // in this repo has one.
  const BARE_PATH = /^\S+$/;
  const badShape = files.find((line) => !BARE_PATH.test(line));
  if (badShape) {
    return {
      ok: false,
      reason: `entry is not a bare relative path: "${badShape}"`,
    };
  }
  return { ok: true, files };
}

// --- Gate 1: no TypeScript source in the tarball -----------------------------
for (const { dir, name } of publishable) {
  const cwd = path.join(repoRoot, "packages", dir);
  const output = execFileSync("pnpm", ["pack", "--dry-run"], { cwd, encoding: "utf8" });

  // Defensive: if the output format is not understood, the offender filter would
  // find nothing regardless — a vacuous pass. Fail loudly instead of silently
  // checking zero files.
  const parsed = parseTarballContents(output);
  if (!parsed.ok) {
    failures.push(
      `${name}: pnpm pack --dry-run output format not understood ` +
        `(${parsed.reason}) — gate is not vacuous, refusing to pass`,
    );
    continue;
  }

  // A declaration is `.d.ts` / `.d.mts` / `.d.cts`; anything else ending in a
  // TypeScript extension — `.ts`, `.mts`, `.cts`, `.tsx` — is source that must
  // not ship. The list is exact so the matcher does not also claim to cover
  // non-existent forms like `.mtsx`/`.ctsx`. `.d.tsx` is not a real thing, so
  // it is not exempted. The declaration exemption stays a prefix pattern so the
  // hashed shared chunk `protocol-*.d.ts` is still covered.
  const offenders = parsed.files.filter(
    (line) => /\.(ts|mts|cts|tsx)$/.test(line) && !/\.d\.(m|c)?ts$/.test(line),
  );

  if (offenders.length > 0) {
    failures.push(`${name}: TypeScript source in the tarball -> ${offenders.join(", ")}`);
  }
}

// --- Gate 2: exactly one resolved React --------------------------------------
// Read pnpm's content-addressed store directly rather than parsing `pnpm ls`
// output: the directory names ARE the resolved versions, so this cannot drift with
// a reporter change. Peer-suffixed entries like `react-dom@19.2.8(react@19.2.8)`
// do not match, because the pattern is anchored.
//
// Known limitation, accepted: this proves uniqueness only for pnpm-managed
// virtual-store entries. A consumer using npm or yarn would have a different
// layout, but this gate runs in OUR workspace, which is pnpm-only — so the
// limitation does not reduce what the gate can see here.
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

// --- Gate 3: React must be peer, not a dependency ----------------------------
// The duplicate-React failure mode this gate's header names — a published
// library causing duplicate React in a consumer's app — comes from `react`
// moving out of `peerDependencies` into `dependencies` (or vanishing entirely
// while the package still uses it). Gate 2 above counts resolved copies in THIS
// workspace, where a single catalog version makes duplication impossible to
// detect; this gate catches the manifest-level mistake that would duplicate
// React in a CONSUMER's app. For every publishable package: if it depends on
// react or react-dom at all, they must appear in `peerDependencies` and NOT in
// `dependencies`.
const REACT_DEPS = ["react", "react-dom"];
for (const { name, manifest } of publishable) {
  const deps = Object.keys(manifest.dependencies ?? {});
  const peerDeps = Object.keys(manifest.peerDependencies ?? {});
  const devDeps = Object.keys(manifest.devDependencies ?? {});
  for (const dep of REACT_DEPS) {
    const referenced = deps.includes(dep) || peerDeps.includes(dep) || devDeps.includes(dep);
    if (!referenced) continue;
    if (deps.includes(dep)) {
      failures.push(
        `${name}: "${dep}" is in dependencies, not peerDependencies. ` +
          "A published library bundling React as a regular dependency causes " +
          "duplicate React in a consumer's app (doc 10 §5). Move it to " +
          "peerDependencies and mirror it in devDependencies as catalog:.",
      );
    }
    if (!peerDeps.includes(dep)) {
      failures.push(
        `${name}: "${dep}" is referenced but missing from peerDependencies. ` +
          "A consumer must be told which React version to provide, or they may " +
          "install a different one and duplicate it.",
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Package gates failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `package gates: ${publishable.length} tarballs carry no TypeScript source; ` +
    `one resolved React (${[...reactVersions].join(", ")}); ` +
    `react/react-dom declared as peer deps where used`,
);
