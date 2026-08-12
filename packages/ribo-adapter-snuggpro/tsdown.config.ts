import { defineConfig } from "tsdown";

import { sharedTsdown } from "@azx/build-config";

export default defineConfig({
  ...sharedTsdown,
  entry: { index: "src/index.ts" },
  tsconfig: "tsconfig.src.json",
});
