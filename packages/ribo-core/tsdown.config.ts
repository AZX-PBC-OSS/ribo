import { defineConfig } from "tsdown";

import { sharedTsdown } from "@azx/build-config";

export default defineConfig({
  ...sharedTsdown,
  // Object form, not the array form: it makes the output filename explicit rather
  // than trusting tsdown's name derivation, which the `exports` block depends on.
  // The `worklet` entry is the `AudioWorkletProcessor` published as the
  // `./worklet` subpath — loaded by URL via `addModule(new URL("./worklet.js",
  // import.meta.url).href)`, exactly as `@azx/ribo-transcriber-ondevice`'s
  // `./worker` entry is loaded via `new Worker(new URL("./worker.js",
  // import.meta.url))`. `sharedTsdown` deliberately omits
  // `experimental.resolveNewUrlToAsset` so the `new URL(...)` reference passes
  // through the build verbatim and the consumer's bundler emits the file as an
  // asset (AGENTS.md §5.2, doc 10 §4).
  entry: { index: "src/index.ts", worklet: "src/worklet.ts" },
});
