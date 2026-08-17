/**
 * @file The engine id: one operating point, named.
 *
 * This used to be a module constant, `"ondevice-whisper"`, shared by every instance. That
 * was fine while the package had exactly one configuration and wrong in three ways once it
 * had more:
 *
 * 1. **A roster of two on-device configurations could not be constructed at all.**
 *    `firstCapable` refuses duplicate engine ids — its capability cache is keyed by them, so
 *    duplicates would share one entry and demote each other — and threw a `TypeError` before
 *    any of them ran.
 * 2. **`Transcript.engine` was a lie.** The default model has been Moonshine since the
 *    live-transcription work, so every Moonshine transcript in the outbox was stamped
 *    `ondevice-whisper`. There was no join key from a persisted transcript back to the
 *    configuration that produced it, which makes field telemetry unattributable — and
 *    telemetry is the only way any of these operating points ever gets compared.
 * 3. **The real-time-factor verdict inherited across configurations.** It was keyed by model
 *    id, so a `too-slow` verdict measured on fp32 permanently demoted q8 of the same model.
 *    `too-slow` is in the permanent set and is cached forever, so that was not self-correcting.
 *
 * The id is derived from the three things that make one on-device configuration behave
 * differently from another: the model, the execution provider, and the weight quantization.
 * Two instances that agree on all three ARE the same engine, and sharing a capability entry
 * and an RTF verdict is then correct rather than a collision.
 *
 * **It is persisted**, in `Transcript.engine` and in the RTF verdict key, so it is kept short
 * and treated as stable: changing the format is a data migration. That is cheap today (no
 * users) and will not always be.
 */
import type { OnnxDtype } from "./protocol.js";

/** What distinguishes one on-device operating point from another. */
export interface EngineIdentity {
  readonly modelId: string;
  /** Unset means transformers.js auto-selects, which is itself a distinct operating point. */
  readonly device?: "webgpu" | "wasm";
  /** Unset means the library default for the chosen device. */
  readonly dtype?: OnnxDtype;
}

/** Prefix every on-device engine id carries, so a persisted value is recognisable on sight. */
export const ONDEVICE_ENGINE_PREFIX = "ondevice";

/**
 * Shorten a Hub model id for use in an engine id: drop the org and the `-ONNX` suffix that
 * every `onnx-community` repo carries and which therefore distinguishes nothing.
 *
 * `onnx-community/moonshine-base-ONNX` → `moonshine-base`; `Xenova/whisper-tiny.en` →
 * `whisper-tiny.en`. Two repos publishing the same model under different orgs collapse to one
 * id, which is right: they are the same weights and the same operating point.
 */
export function shortModelName(modelId: string): string {
  const withoutOrg = modelId.slice(modelId.lastIndexOf("/") + 1);
  return withoutOrg.replace(/-ONNX$/i, "");
}

/**
 * The engine id for one configuration.
 *
 * `auto` is used where the caller left a choice to the library, and is deliberately a value
 * rather than an omission: "whatever transformers.js picks on this machine" is a real, distinct
 * operating point, and two instances that both left it unset genuinely are the same engine.
 */
export function ondeviceEngineId(identity: EngineIdentity): string {
  return [
    ONDEVICE_ENGINE_PREFIX,
    shortModelName(identity.modelId),
    identity.device ?? "auto",
    identity.dtype ?? "auto",
  ].join(":");
}
