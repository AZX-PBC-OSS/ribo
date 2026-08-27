import { describe, expect, test } from "vitest";

import {
  primeLanguageModel,
  probeLanguageModel,
  type DownloadProgressEvent,
} from "./capability.js";
import { FakeLanguageModel } from "./test-support/fake-language-model.js";

describe("probeLanguageModel", () => {
  test("available maps to ready", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";

    const result = await probeLanguageModel(model);

    expect(result).toEqual({ status: "ready" });
  });

  test("downloadable maps to needs-download", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "downloadable";

    const result = await probeLanguageModel(model);

    expect(result).toMatchObject({ status: "needs-download" });
  });

  test("downloading maps to needs-download", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "downloading";

    const result = await probeLanguageModel(model);

    expect(result).toMatchObject({ status: "needs-download" });
  });

  test("unavailable maps to unavailable with a reason and detail", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "unavailable";

    const result = await probeLanguageModel(model);

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "model-unavailable",
      detail: expect.stringContaining("unavailable"),
    });
  });

  test("a missing LanguageModel maps to unsupported-platform", async () => {
    const result = await probeLanguageModel(undefined);

    expect(result).toEqual({
      status: "unavailable",
      reason: "unsupported-platform",
      detail: "The LanguageModel API is not available on this platform.",
    });
  });

  test("probing never calls create()", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";

    await probeLanguageModel(model);

    expect(model.createCount).toBe(0);
  });

  test("an availability() throw is reported as unavailable, not propagated", async () => {
    const model = new FakeLanguageModel();
    model.availabilityError = new Error("availability probe exploded");

    await expect(probeLanguageModel(model)).resolves.toMatchObject({
      status: "unavailable",
      reason: "unknown",
      detail: expect.stringContaining("availability probe exploded"),
    });
  });
});

describe("primeLanguageModel", () => {
  test("calls create() once and forwards every downloadprogress event", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "downloadable";
    model.progressSequence = [
      { loaded: 0, total: 1 },
      { loaded: 0.5, total: 1 },
      { loaded: 1, total: 1 },
    ];
    const events: DownloadProgressEvent[] = [];

    await primeLanguageModel(model, (event) => events.push(event));

    expect(model.createCount).toBe(1);
    expect(events).toEqual(model.progressSequence);
  });

  test("NotAllowedError from create() is a capability failure naming the missing gesture", async () => {
    const model = new FakeLanguageModel();
    model.createError = new DOMException(
      'Requires a user gesture when availability is "downloadable"',
      "NotAllowedError",
    );

    const result = await primeLanguageModel(model);

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "not-configured",
      detail: expect.stringContaining("user gesture"),
    });
  });
});
