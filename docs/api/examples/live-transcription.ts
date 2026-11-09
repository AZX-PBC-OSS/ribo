/**
 * The type-checked example behind docs/api/live-transcription.html.
 *
 * A live session runs inference in a Web Worker and feeds it from an audio
 * callback — browser globals the node runner does not have — so this file is
 * never executed. It is type-checked by the examples tsconfig (see
 * docs/api/index.md), so the shapes shown on the page are real. Runtime
 * behaviour is covered by the package's own unit tests.
 */

import { type LiveSession, type LiveTranscriber, type Recording } from "@azx/ribo-core";
import { OnDeviceLiveTranscriber } from "@azx/ribo-transcriber-ondevice";

function recording(id: string): Recording {
  return {
    id,
    capturedAt: new Date().toISOString(),
    kind: "audio",
    durationMs: 96_000,
    mimeType: "audio/webm",
    ctx: {},
  };
}

// #region usage
const live: LiveTranscriber = new OnDeviceLiveTranscriber({
  wasmPaths: "/ort/",
  createWorker: () =>
    new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" }),
});

const capability = await live.liveCapability();
if (capability.status !== "ready") throw new Error("no preview for this recording");

const session: LiveSession = await live.openSession(recording("cap-1"));
const segments: string[] = [];
session.segments$.subscribe((segment) => {
  // "tail" is provisional text for the growing region — replace it wholesale.
  // "commit" is permanent text for a settled region — append it.
  if (segment.kind === "commit") segments.push(segment.text);
});

// Synchronous — must return before the inference it triggers.
session.feed(new Float32Array(512));
// #endregion usage

// The worker transcribes the last region after close() and posts it back; the
// segment stream completes only when that drain is done.
session.close();
