import { defineConfig } from "tsdown";

import { sharedTsdown } from "@azx/build-config";

export default defineConfig({
  ...sharedTsdown,
  entry: { index: "src/index.ts" },
  tsconfig: "tsconfig.src.json",
  // The build is two `tsdown` passes (see the package.json `build` script and
  // generate-extraction-schema.mjs): pass 1 bootstraps `dist/index.js` for the
  // generator to import; pass 2 rebuilds and runs publint/attw against the
  // tarball WITH the generated `dist/extraction.schema.json` in it — the checks
  // are never skipped on the artifacts that get packed. This clean override is
  // what lets the generated artifact survive pass 2's out-dir wipe.
  clean: ["dist/**/*", "!dist/extraction.schema.json"],
});
