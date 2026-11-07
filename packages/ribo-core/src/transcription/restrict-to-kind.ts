import type { CapturePayload } from "../capture/capture-item.js";
import type { Transcript } from "../capture/transcript.js";
import { UnsupportedItemError } from "./unsupported-item.js";
import type { Transcriber, TranscriberCapability } from "./transcriber.js";

/**
 * @file Lift a narrow transcriber into a slot that can see any `CapturePayload`.
 *
 * See the document-transcription plan D7a for the full reasoning. The short
 * version: `RelayOptions.transcriber` is `Transcriber<CapturePayload>`, because the
 * queue can hold either kind. With `transcribe` declared as a property (not a
 * method), an audio-only `Transcriber<Recording>` no longer typechecks into
 * that slot — which is the point. The compiler sends the host here, and this
 * combinator lifts the narrow engine by refusing other kinds with
 * {@link UnsupportedItemError} and delegating for the matching kind.
 */

/**
 * Wrap a `Transcriber<S>` so it satisfies `Transcriber<CapturePayload>`, refusing
 * items of another kind with {@link UnsupportedItemError} and delegating for
 * the matching kind.
 *
 * The compiler is what sends a host to this: a composition root wiring an
 * audio-only roster into a queue that can hold documents gets a type error, and
 * this is the fix — `relay({ transcriber: restrictToKind("audio", firstCapable([…])) })`.
 * It changes no engine, and nothing relies on remembering an ordering rule.
 * @category Transcription
 */
export function restrictToKind<S extends CapturePayload>(
  kind: S["kind"],
  transcriber: Transcriber<S>,
): Transcriber<CapturePayload> {
  return {
    engine: transcriber.engine,
    capability: (): Promise<TranscriberCapability> => transcriber.capability(),
    transcribe: async (item, bytes, options?): Promise<Transcript> => {
      if (item.kind !== kind) {
        throw new UnsupportedItemError({
          engine: transcriber.engine,
          reason: "unsupported-format",
          detail: `this engine handles kind "${kind}", not "${item.kind}"`,
        });
      }
      // Runtime check guarantees `item` is of kind `S`; the cast is safe and
      // required because TypeScript cannot narrow on a generic comparison.
      // The options are forwarded whole — a lift that dropped them would make
      // the wrapped engine the one place the caller's signal dies.
      return transcriber.transcribe(item as S, bytes, options);
    },
  };
}
