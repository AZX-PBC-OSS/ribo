/**
 * @file Generates `dist/extraction.schema.json` — the OpenAPI-3.0-form JSON Schema
 * document for `snuggExtractionSchema`, the extraction schema `@azx/ribo-adapter-snuggpro`
 * publishes at the `./extraction.schema.json` subpath. It runs as the middle step of the
 * package's three-step `build` script (`tsdown --no-publint --no-attw && node
 * ./generate-extraction-schema.mjs && tsdown`), so the file is regenerated on every build
 * and a generation failure fails the build — a stale or missing artifact can never ride a
 * green build. The first pass only bootstraps `dist/index.js` for this script to import;
 * the final pass re-checks the packed tarball WITH this file in it, so publint/attw never
 * run against an artifact-less package.
 *
 * Why the `target` is explicit: zod's default `toJSONSchema` rendering is draft-2020-12,
 * whose nullability is `anyOf` with a `null` arm — the exact form `@azx/ribo-cli`'s
 * inspect conversion refuses (`packages/ribo-cli/src/inspect/convert.ts`,
 * `refuseDraft2020Nullability`), and which `z.fromJSONSchema` would read back as unions
 * rather than as nullable leaves. `{ target: "openapi-3.0" }` writes `"nullable": true`
 * instead. The option is written literally here so the artifact's form is independent of
 * zod's defaults and version.
 *
 * Why the file is never committed: `dist/` is gitignored, and the zod schema module
 * (`src/schema.ts`'s `snuggExtractionSchema`) is the single source of truth — this file is
 * build output, regenerated every build, never hand-edited. Editing `src/schema.ts` and
 * rebuilding IS the way to change it.
 *
 * Why it renders from `dist/`: this script runs after `tsdown`, and importing the
 * just-built `dist/index.js` (a `.mjs` file cannot import the TypeScript source) also
 * proves the published bundle is import-safe in plain Node — the same property the
 * pack-and-consume tier checks from outside.
 */
import { writeFileSync } from "node:fs";

import { z } from "zod";

import { snuggExtractionSchema } from "./dist/index.js";

const document = z.toJSONSchema(snuggExtractionSchema, { target: "openapi-3.0" });

writeFileSync(
  new URL("./dist/extraction.schema.json", import.meta.url),
  `${JSON.stringify(document, null, 2)}\n`,
);

console.log("generate-extraction-schema: wrote dist/extraction.schema.json");
