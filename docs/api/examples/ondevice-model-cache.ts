/**
 * The type-checked model-cache example behind docs/api/ondevice-transcriber.html.
 *
 * `isModelCached` reads the Cache API — a browser-only global the node runner
 * does not have — so this file is never executed. It is type-checked by the
 * examples tsconfig (see docs/api/index.md), so the probe shown on the page is
 * real. Runtime behaviour is covered by the package's own unit tests.
 */

import { isModelCached } from "@azx/ribo-transcriber-ondevice";

// #region usage
// "Usable offline" is stricter than "present": both halves of the
// encoder-decoder pair must be cached, so a download dropped mid-way reports
// not-cached rather than ready.
const cached = await isModelCached("onnx-community/moonshine-base-ONNX");
// #endregion usage

console.log(cached);
