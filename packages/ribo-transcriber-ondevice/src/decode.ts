/**
 * @file Main-thread audio decode + resample — the recorder→Whisper format seam (doc 11).
 *
 * Whisper consumes **16 kHz mono `Float32Array` PCM**; the queue stores capture as an
 * `audio/webm;codecs=opus` `Blob`. Doc 11 establishes, from the transformers.js source, that this
 * conversion must happen **here, on the main thread**, and cannot move into the worker:
 * `AudioContext`/`OfflineAudioContext` are `Exposed=Window` and absent from `WorkerGlobalScope`, and
 * transformers.js's own decode path (`read_audio`) throws without an `AudioContext`. So
 * `OnDeviceTranscriber.transcribe` calls this, then transfers the resulting samples to the worker.
 *
 * This re-implements what transformers.js's `read_audio` does — ~15 lines, mirroring HF's reference —
 * so we match the exact conventions the Whisper feature extractor assumes (doc 11 §3).
 */

/** Whisper's input sampling rate. `decodeAudioData` at a context of this rate resamples for us. */
export const WHISPER_SAMPLE_RATE = 16_000;

/**
 * Decode a captured `Blob` to a 16 kHz mono `Float32Array`, matching transformers.js's `read_audio`.
 *
 * - **Resample** is done by decoding into a `16 kHz` `AudioContext`: MDN specifies `decodeAudioData`
 *   resamples the decoded buffer to the context's sample rate, so no separate render pass is needed.
 *   Chromium accepts arbitrary context rates (3 kHz–768 kHz), so 16 kHz is valid (doc 11 §3).
 * - **Mono downmix** matches `read_audio` exactly: `getChannelData(0)` when already mono; the
 *   ffmpeg-style `(√2·(l+r))/2` sum when stereo — **not** a naive `(l+r)/2`, which is 3 dB quieter
 *   than the convention Whisper's training pipeline assumes (doc 11 §3). Mic capture via
 *   `getUserMedia` is mono in practice, so the stereo branch is a correctness backstop.
 *
 * @throws if `AudioContext` is unavailable (a non-Window scope) or the container will not decode.
 */
export async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const AudioContextCtor =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error(
      "decodeTo16kMono requires AudioContext (a Window scope). Decode must run on the main thread, " +
        "not in the worker — see docs/implementation/11-audio-pipeline.md §1(c).",
    );
  }

  const bytes = await blob.arrayBuffer();
  const ctx = new AudioContextCtor({ sampleRate: WHISPER_SAMPLE_RATE });
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    if (buffer.numberOfChannels === 1) {
      // Copy: the decoded buffer is owned by the (closing) context, and the copy's backing
      // ArrayBuffer is what we transfer to the worker.
      return new Float32Array(buffer.getChannelData(0));
    }
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const out = new Float32Array(left.length);
    // (√2·(l+r))/2 — the ffmpeg downmix read_audio uses, not (l+r)/2.
    const k = Math.SQRT2;
    for (let i = 0; i < out.length; i++) out[i] = (k * ((left[i] ?? 0) + (right[i] ?? 0))) / 2;
    return out;
  } finally {
    void ctx.close();
  }
}
