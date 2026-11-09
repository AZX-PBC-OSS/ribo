/**
 * The recovery-wiring example behind docs/api/capture-session.html.
 *
 * Type-checked only — never executed. `recoverInterrupted` excludes against the
 * Web Locks API (`navigator.locks`), which exists only in a browser: a live
 * session in another tab holds `CAPTURE_LOCK`, and startup recovery refuses to
 * run under it. There is no node-runnable form of that guarantee, so the page
 * says "type-checked only" for this file.
 */

import {
  openStorage,
  type RecoveryOptions,
  recoverInterrupted,
  createMemoryBackend,
} from "@azx/ribo-core";

// #region usage
const storage = await openStorage({ backend: createMemoryBackend("app-db") });

// Decode-verify is the same injectable function `openCaptureSession` takes —
// the real one is `decodeAudioDuration` on the main thread.
const decode: RecoveryOptions["decode"] = async (blob) => blob.size * 10;

const recovered = await recoverInterrupted({
  storage,
  decode,
  onRecovered: (ids) => {
    // New rows are `queued`; sync or drain now if your host queues on its own.
    void ids;
  },
});
// #endregion usage

// Empty when nothing was interrupted, or when a live session holds the lock —
// recovery resolves `[]` rather than running under it either way.
void recovered;
