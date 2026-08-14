import "@azx/ribo-core/worklet";

/**
 * @file The app-owned `AudioWorklet` entry for live sample tapping.
 *
 * Mirrors `whisper.worker.ts`: the consumer owns the worklet construction, in
 * its own bundler context, so Vite can see and emit it as a separate asset.
 * `live-handle.ts`'s `createSampleTap` loads it with
 * `audioWorklet.addModule(new URL("./pcm-worklet.ts", import.meta.url).href)`.
 *
 * The worklet code itself lives in `@azx/ribo-core/src/worklet.ts` — this file
 * just re-exports its side effect. Under the `@azx/source` condition, the
 * import resolves to `src/worklet.ts`, which Vite transforms and serves in dev
 * mode; in production, Vite bundles it into a separate `.js` asset. This is
 * the same reason `whisper.worker.ts` imports `handleMessage` from
 * `@azx/ribo-transcriber-ondevice/worker` rather than inlining the worker code.
 *
 * The default `createSampleTap` in `ribo-core`'s `Recorder` cannot load inside
 * this workspace for the same reason the default `createWorker` cannot
 * (AGENTS.md §5.2): under `@azx/source`, `new URL("./worklet.js",
 * import.meta.url)` resolves to `src/worklet.js` — a file that does not exist
 * because the source is TypeScript. The failure is swallowed, so recording
 * works and frames silently never arrive. Injecting `createSampleTap` from
 * here is the fix, exactly as `whisper-store.ts` injects `createWorker`.
 */
