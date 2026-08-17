import { describe, expect, test } from "vitest";

import { speechEndpointFrom } from "./vite-transcribe.js";

/**
 * @file The one piece of `/api/transcribe` worth testing in isolation: deriving the
 * Speech endpoint from whatever URL the resource is configured under.
 *
 * The forwarding itself is a pass-through of bytes and status codes, exercised for
 * real the moment anyone drains the queue. This function is where a silent mistake
 * could hide — a wrong api-version loses `phraseList` with no error at all.
 */
describe("speechEndpointFrom", () => {
  test("derives the transcribe endpoint from any URL on the resource", () => {
    expect(speechEndpointFrom("https://my-resource.cognitiveservices.azure.com/openai/v1/")).toBe(
      "https://my-resource.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    );
  });

  test("keeps only the host, discarding whatever path the base URL carried", () => {
    const endpoint = speechEndpointFrom("https://r.cognitiveservices.azure.com/some/deep/path?x=1");
    expect(endpoint).toContain("https://r.cognitiveservices.azure.com/speechtotext/");
    expect(endpoint).not.toContain("deep");
  });

  test("pins api-version 2025-10-15 — phraseList does not exist before it", () => {
    // Not a tautology: an older api-version is accepted by the service and simply
    // ignores `definition.phraseList`, so the request succeeds and the transcript
    // is quietly worse. There is no error to notice.
    expect(speechEndpointFrom("https://r.cognitiveservices.azure.com/")).toContain(
      "api-version=2025-10-15",
    );
  });

  test("undefined when unset or unparseable, so the endpoint reports not-configured", () => {
    expect(speechEndpointFrom(undefined)).toBeUndefined();
    expect(speechEndpointFrom("")).toBeUndefined();
    expect(speechEndpointFrom("not a url")).toBeUndefined();
  });
});
