import { handleMessage } from "@azx/ribo-transcriber-ondevice/worker";

/**
 * @file The app-owned Web Worker entry for on-device Whisper inference.
 *
 * AGENTS.md §5.2 / doc 10 §4: library code must never construct a `Worker` via a
 * `?worker` import (vitejs/vite#15618). The consumer owns worker construction, in
 * its OWN bundler context — which is what this file is. `whisper-store.ts` builds
 * it with `new Worker(new URL("./whisper.worker.ts", import.meta.url), { type:
 * "module" })`, and Vite bundles this module — and, through it, the package's
 * worker implementation plus `@huggingface/transformers` — for the worker.
 *
 * It wires the package's **exported** `handleMessage` to the message loop
 * explicitly, rather than relying on `@azx/ribo-transcriber-ondevice/worker`'s
 * own `self.addEventListener` side effect. That package is `sideEffects: false`,
 * so a production build is free to tree-shake a bare side-effect import away;
 * calling the exported function keeps the wiring immune to that (and the manual
 * Vitest run, which points a Worker straight at the package's `worker.ts`, only
 * survives because dev builds do not tree-shake — a production build would).
 */

// Derive the wire types from the function's own signature instead of importing
// the package's private `protocol.ts` — the message contract is not a public
// entry point, and this keeps `event.data`/`postMessage` fully typed (no `any`).
type Incoming = Parameters<typeof handleMessage>[0];
type Post = Parameters<typeof handleMessage>[1];
type Outgoing = Parameters<Post>[0];

self.addEventListener("message", (event: MessageEvent<Incoming>) => {
  void handleMessage(event.data, (message: Outgoing) => {
    self.postMessage(message);
  });
});
