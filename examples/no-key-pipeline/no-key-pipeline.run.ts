/**
 * The no-key pipeline example: one credential-free arc from capture to a
 * checked citation. Provenance is checkable with no model — nothing here
 * calls a service, reads a credential or touches a network.
 */

// #region imports
import assert from "node:assert/strict";
import { z } from "zod";
import {
  baseAudioCaptureSchema,
  enveloped,
  FakeExtractor,
  FakeTranscriber,
  isSpanGrounded,
} from "@azx/ribo-core";
// #endregion imports

// #region complete-export
export async function noKeyPipelineEndsInGroundedSpans(): Promise<void> {
  // #region pipeline
  // 1. A capture arrives. No microphone here — a bare `AudioCapture` stands in for a real capture.
  const capture = baseAudioCaptureSchema.parse({
    id: "rec-1",
    capturedAt: new Date().toISOString(),
    mimeType: "audio/webm",
    durationMs: 4_000,
    ctx: {},
  });

  // 2. Transcribe. `FakeTranscriber` returns canned text instead of running a model.
  const transcriber = new FakeTranscriber({
    text: "Jordan Lee from Acme Robotics called about renewing the contract.",
  });
  const transcript = await transcriber.transcribe(capture, new Blob());

  // 3. Declare the values a host writes back. Four leaves — small enough to read at a glance.
  const contactSchema = z.object({
    name: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    followUpDate: z.string().nullable().optional(),
  });

  // 4. Derive the extraction schema from it. Every leaf gains { value, confidence, sourceSpan }.
  const extractionSchema = enveloped(contactSchema);

  // 5. Extract. `FakeExtractor` returns the enveloped shape directly, so this runs with no key
  //    and no network. `followUpDate` is an explicit null — the model (fake or real) must say
  //    "not stated," never omit the key.
  const extractor = new FakeExtractor(
    extractionSchema.parse({
      name: { value: "Jordan Lee", confidence: 1, sourceSpan: "Jordan Lee" },
      company: { value: "Acme Robotics", confidence: 1, sourceSpan: "Acme Robotics" },
      reason: {
        value: "renewing the contract",
        confidence: 1,
        sourceSpan: "renewing the contract",
      },
      followUpDate: { value: null, confidence: 1, sourceSpan: null },
    }),
  );
  const { fields } = await extractor.extract({ text: transcript.text, annotations: {} });

  // 6. Check the citations. `isSpanGrounded` confirms each quote is verbatim in the transcript —
  //    the same check a review screen runs before showing a field as trustworthy.
  // #region span-check
  assert.equal(isSpanGrounded(fields.name.sourceSpan, transcript.text), true);
  assert.equal(isSpanGrounded(fields.company.sourceSpan, transcript.text), true);
  assert.equal(isSpanGrounded(fields.reason.sourceSpan, transcript.text), true);
  // #endregion span-check
  // #endregion pipeline
}
// #endregion complete-export
