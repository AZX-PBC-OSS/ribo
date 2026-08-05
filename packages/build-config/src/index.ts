/**
 * @file The one tsdown configuration shared by every publishable package.
 *
 * Each package's `tsdown.config.ts` spreads this and adds only its own `entry`.
 * Keeping the settings here is what makes "one build tool, one syntax target"
 * true rather than aspirational — five inlined copies of the floor is exactly the
 * drift R1 exists to remove.
 *
 * Do not "simplify" the explicit settings below. Every one of them overrides a
 * default that would be wrong for a browser library, and two of them defuse
 * silent footguns. See docs/superpowers/specs/2026-08-04-r1-package-build-configs-design.md.
 */
import type { UserConfig } from "tsdown";

import { BROWSER_TARGET } from "./target.generated.ts";

export { BROWSER_TARGET };

export const sharedTsdown: UserConfig = {
  // tsdown defaults to `node`. All five packages are browser libraries.
  platform: "browser",

  // ESM-only. Dual-publishing invites the dual-package hazard, which is fatal
  // for a React library carrying context. NEVER add a UMD format: `import.meta.url`
  // is `undefined` there, which silently breaks worker and WASM URL resolution.
  format: ["esm"],

  // ALWAYS explicit. tsdown's only inference path is `engines.node` -> `nodeNN`,
  // so the day someone adds `engines` as publishing metadata, five browser
  // libraries would silently start targeting Node.
  target: BROWSER_TARGET,

  dts: {
    // ALSO always explicit. rolldown-plugin-dts infers `'tsgo'` — the experimental
    // TypeScript Go compiler, which "may not support all TypeScript features yet"
    // — whenever TypeScript 7 is installed. Doc 10 §9 calls TS 7 a fast-follow, so
    // that bump is coming, and it must not quietly change how our types are built.
    // `'oxc'` is equally wrong here: it requires isolatedDeclarations, which zod's
    // `z.infer<typeof Schema>` cannot satisfy (base.json turns it off for this
    // reason, and doc 10 §3.1 records one package hitting 374 errors).
    generator: "tsc",
    // Declaration maps are OFF. Their `sources` point at `../src/*.ts`, but
    // `files: ["dist"]` (and the tarball gate in scripts/pkg-gates.mjs)
    // deliberately exclude `src/` from every published tarball, so a consumer's
    // "Go to Definition" on any ribo type would target a path absent from the
    // package — a broken affordance, worse than shipping no map. Inlining
    // `sourcesContent` was rejected: it bloats the tarball and effectively ships
    // source, contradicting the no-source-in-tarball rule. JS sourcemaps below
    // are unaffected — they ship WITH `sourcesContent` and resolve in the
    // consumer's debugger. Note the top-level `sourcemap: true` is forced on by
    // `declarationMap` in `packages/tsconfig/base.json`, so this MUST be set on
    // the `dts` block specifically, not by changing the top-level flag.
    sourcemap: false,
  },

  // React must be externalized BY REGEX. A bare "react" does not match
  // `react/jsx-runtime`, and missing it breaks consumer builds. tsdown already
  // externalizes `dependencies` and `peerDependencies`; this is belt-and-braces
  // for the subpath case.
  deps: { neverBundle: [/^react($|\/)/, /^react-dom($|\/)/] },

  sourcemap: true,

  // The host minifies. A minified library only obstructs their debugging.
  minify: false,

  // Optional tsdown peers, run in-build so a bad package contract fails the build
  // that produced it rather than a later CI step. Both are set to FAIL the build:
  // publint with `{ strict: true }` — warnings and suggestions are fatal, matching
  // the `publint --strict` the CI TODO this branch replaced (non-strict `publint:
  // true` makes warnings and suggestions non-fatal). attw with `level: "error"` —
  // tsdown's default `level: "warn"` with `failOnWarn: false` prints WARN and exits
  // 0; only `logger.error` sets `process.exitCode = 1`. `esm-only` (below)
  // suppresses only the `node10`/`node16-cjs` resolution KINDS; every other attw
  // problem class (untyped resolution, false ESM/CJS, named-export mismatch,
  // "package has no types") is live, and every one is now fatal.
  publint: { strict: true },
  // `esm-only`, not a bare `true`: attw's default profile resolves under Node10
  // and Node16 (CJS) too, which reports `No resolution (node10)` and `CJS
  // resolves to ESM (node16-cjs)` for a package that is deliberately ESM-only.
  // Those are false positives here — there is no CJS build and never will be
  // (doc 10 §3) — so the profile suppresses them without weakening real checks.
  attw: { profile: "esm-only", level: "error" },

  // NOTE what is deliberately absent: `experimental.resolveNewUrlToAsset`.
  // Rolldown's own tracking issue says it "does not work well when bundling
  // libraries". With it off (the default) `new URL("./worker.js", import.meta.url)`
  // passes through roughly verbatim, which is what native ESM and webpack 5
  // statically analyze. Doc 10 §3.1.
};
