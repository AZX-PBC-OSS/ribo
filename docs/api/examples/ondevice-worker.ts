/**
 * The type-checked worker-wiring example behind docs/api/ondevice-transcriber.html.
 *
 * The module it wires exists to run inside a Web Worker (it imports the ORT
 * runtime and the Whisper pipeline), so this file is never executed. It is
 * type-checked by the examples tsconfig (see docs/api/index.md), so the wiring
 * shown on the page is real. The pattern is the playground's:
 * `playground/src/whisper.worker.ts` and `whisper-store.ts`.
 */

import { OnDeviceTranscriber } from "@azx/ribo-transcriber-ondevice";

// #region wiring
// The host owns worker construction, in its OWN bundler context — library code
// never constructs a Worker (AGENTS.md §5.2, vitejs/vite#15618). The app's
// worker entry imports `handleMessage` from the package's ./worker subpath:
//
//   import { handleMessage } from "@azx/ribo-transcriber-ondevice/worker";
//   onmessage = (event) => handleMessage(event.data, (reply) => postMessage(reply));
//
// and hands a factory for it to the transcriber:
const engine = new OnDeviceTranscriber({
  wasmPaths: "/ort/",
  createWorker: () =>
    new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" }),
});
// #endregion wiring

console.log(engine.engine);
