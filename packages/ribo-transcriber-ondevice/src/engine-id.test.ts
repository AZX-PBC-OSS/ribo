import { expect, test } from "vitest";

import { ondeviceEngineId, shortModelName } from "./engine-id.js";

test("two configurations of the same model get different ids", () => {
  // The whole point. `firstCapable` refuses duplicate engine ids, so a shared id did not merely
  // confuse telemetry — it made a two-configuration roster throw at construction.
  const fp32 = ondeviceEngineId({
    modelId: "onnx-community/moonshine-base-ONNX",
    device: "wasm",
    dtype: "fp32",
  });
  const q8 = ondeviceEngineId({
    modelId: "onnx-community/moonshine-base-ONNX",
    device: "wasm",
    dtype: "q8",
  });
  expect(fp32).not.toBe(q8);
});

test("the device is part of the identity, not just the dtype", () => {
  const wasm = ondeviceEngineId({ modelId: "m/x", device: "wasm", dtype: "q8" });
  const webgpu = ondeviceEngineId({ modelId: "m/x", device: "webgpu", dtype: "q8" });
  expect(wasm).not.toBe(webgpu);
});

test("identical configurations get identical ids, so they share a cache entry and a verdict", () => {
  const a = ondeviceEngineId({ modelId: "m/x", device: "wasm", dtype: "q8" });
  const b = ondeviceEngineId({ modelId: "m/x", device: "wasm", dtype: "q8" });
  expect(a).toBe(b);
});

test("an unset device or dtype is a distinct operating point, not an omission", () => {
  // "whatever transformers.js picks here" is a real configuration and must not collide with an
  // explicit one — nor produce a ragged id with empty segments.
  const auto = ondeviceEngineId({ modelId: "m/x" });
  expect(auto).toBe("ondevice:x:auto:auto");
  expect(auto).not.toBe(ondeviceEngineId({ modelId: "m/x", device: "wasm" }));
});

test("the id names the model that actually ran", () => {
  // The defect this replaces: DEFAULT_MODEL_ID is Moonshine, but every transcript was stamped
  // "ondevice-whisper", so a persisted transcript could not be attributed to its configuration.
  const id = ondeviceEngineId({
    modelId: "onnx-community/moonshine-base-ONNX",
    device: "wasm",
    dtype: "q8",
  });
  expect(id).toContain("moonshine-base");
  expect(id).not.toContain("whisper");
});

test("shortModelName drops the org and the ONNX suffix, which distinguish nothing", () => {
  expect(shortModelName("onnx-community/moonshine-base-ONNX")).toBe("moonshine-base");
  expect(shortModelName("Xenova/whisper-tiny.en")).toBe("whisper-tiny.en");
  // Same weights published under two orgs are the same operating point.
  expect(shortModelName("Xenova/whisper-base.en")).toBe(
    shortModelName("onnx-community/whisper-base.en"),
  );
});
