/**
 * @file The `AudioWorkletProcessor` for live sample tapping, published as the
 * `./worklet` subpath of `@azx/ribo-core`.
 *
 * The browser hands an `AudioWorkletProcessor` audio in 128-sample render quanta
 * — the Web Audio spec's fixed `AUDIO_WORKLET_QUANTUM_SIZE`, confirmed in
 * Chromium. Silero VAD wants 512-sample frames at 16 kHz. This processor's sole
 * job is to regroup four 128-sample quanta into each 512-sample frame and post
 * it to the main thread. The spike (`docs/roadmap/design/live-spike-findings.md`
 * Q3) confirmed this works in real Chromium with a real `MediaStream`.
 *
 * The `AudioContext` that loads this module is constructed at 16 kHz (see
 * `recorder.ts`'s `defaultCreateSampleTap`), so the browser resamples the
 * `MediaStream` to 16 kHz before the processor sees it — no resampling here.
 *
 * `AudioWorkletProcessor` and `registerProcessor` are global in the
 * `AudioWorkletGlobalScope` but absent from TypeScript's DOM lib, so they are
 * declared below. `export {}` makes this a module so the declarations stay
 * file-scoped rather than polluting the project's global namespace.
 *
 * **This entry is side-effect-only, and `package.json` says so.** Its whole behaviour is the
 * top-level `registerProcessor` below and it exports nothing, so under a blanket
 * `sideEffects: false` a bundler would be free to drop a host's bare
 * `import "@azx/ribo-core/worklet"` entirely — the same class of scar the playground's
 * `whisper.worker.ts` header documents for the worker entry. `sideEffects` is therefore narrowed to
 * this file rather than left `false`. URL-loading, the default path, was never at risk: emitted
 * assets are not tree-shaken.
 */
export {};

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

/** Silero VAD's frame size — the reason this processor exists. */
const FRAME_SIZE = 512;

/**
 * Regroups 128-sample render quanta into 512-sample frames of 16 kHz mono PCM.
 *
 * Each `process()` call delivers exactly 128 samples (the render quantum). Four
 * calls fill one 512-sample frame, which is posted via `this.port.postMessage`.
 * The buffer is copied (`slice`) because it is reused for the next frame — a
 * view would alias and corrupt. At 512 float32 samples (2 KB) the copy is
 * negligible at the ~32 ms frame cadence.
 */
class PcmFrameProcessor extends AudioWorkletProcessor {
  readonly #buffer = new Float32Array(FRAME_SIZE);
  #offset = 0;

  override process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (input === undefined) return true;

    let i = 0;
    while (i < input.length) {
      const remaining = FRAME_SIZE - this.#offset;
      const toCopy = Math.min(remaining, input.length - i);
      this.#buffer.set(input.subarray(i, i + toCopy), this.#offset);
      this.#offset += toCopy;
      i += toCopy;

      if (this.#offset === FRAME_SIZE) {
        this.port.postMessage(this.#buffer.slice());
        this.#offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-frame-processor", PcmFrameProcessor);
