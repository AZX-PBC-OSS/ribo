import { defineConfig } from "tsdown";

import { sharedTsdown } from "@azx/build-config";

export default defineConfig({
  ...sharedTsdown,
  // Object form, not the array form: it makes the output filename explicit rather
  // than trusting tsdown's name derivation, which the `exports` block depends on.
  entry: { index: "src/index.ts" },
});
