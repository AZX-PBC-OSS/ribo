import { defineConfig } from "tsdown";

import { sharedTsdown } from "@azx/build-config";

export default defineConfig({
  ...sharedTsdown,
  // The object form is REQUIRED here, not merely preferred: the package's
  // `./worker` export points at `./dist/worker.js`, so the output filename is
  // part of the published contract. The array form would leave that filename to
  // tsdown's name derivation.
  //
  // The worker ships as a plain published entry — and never as a `?worker`
  // import — because Vite's library-mode worker bug (vitejs/vite#15618) emits an
  // absolute path that 404s in the consumer's app, in production only. That is a
  // failure that passes every check we run and breaks at the host. Consumers
  // construct the worker themselves via the injected `createWorker` factory. See
  // AGENTS.md §5.2 and doc 10 §4.
  entry: { index: "src/index.ts", worker: "src/worker.ts" },
});
