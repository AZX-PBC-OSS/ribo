/**
 * The review-gate example: "nothing is written until a human resolves the
 * review", stated positively. `docs/api/examples/relay.run.ts` asserts one
 * write after `submitReview`; this example makes the gate itself the subject —
 * the relay is given its chance to write while the session sits at
 * `awaiting-review` and writes nothing, and the single write that follows
 * `submitReview` carries the reviewed values, not the raw extraction. The
 * adapter is a tool-neutral `ToolAdapter` double behind `toWriteStep`, the
 * shape a host actually wires.
 */

// #region imports
import assert from "node:assert/strict";
import { z } from "zod";
import {
  buildReviewRequest,
  createMemoryBackend,
  createRelay,
  enveloped,
  FakeExtractor,
  FakeTranscriber,
  openStorage,
  resolveReview,
  restrictToKind,
  toSessionExtractStep,
  toWriteStep,
  type FieldDecision,
  type ToolAdapter,
} from "@azx/ribo-core";
// #endregion imports

// #region adapter
// A type alias, not an interface: `V` must carry an index signature, and only
// a type alias gets the implicit one.
type Values = z.infer<typeof valuesSchema>;

const valuesSchema = z.object({
  attic: z.object({ insulation: z.string().nullable().optional() }).optional(),
});

/** Every write the adapter was asked to make — the gate's observable. */
const writes: { fields: Values; ctx: { jobId: string } }[] = [];

/** A tool-neutral adapter double: real schemas, a write that counts. */
const adapter: ToolAdapter<Values, { jobId: string }> = {
  name: "field-tool",
  schema: valuesSchema,
  extractionSchema: enveloped(valuesSchema),
  ctxSchema: z.object({ jobId: z.string() }),
  instructions: "a tool-neutral adapter double",
  write: async (fields, ctx) => {
    writes.push({ fields, ctx });
    return { receipt: "record-1" };
  },
};
// #endregion adapter

const EXTRACTED = {
  attic: {
    insulation: {
      value: "the attic is R-19",
      confidence: 0.9,
      sourceSpan: "the attic is R-19",
    },
  },
};

/** A lock manager that always grants — the Web Locks API is a browser global. */
function grantingLocks(): LockManager {
  const request = async (
    _name: string,
    _options: unknown,
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown> => callback({});
  return { request } as unknown as LockManager;
}

export async function nothingIsWrittenUntilAHumanResolvesTheReview(): Promise<void> {
  const now = (): number => 1_700_000_000_000;
  const storage = await openStorage({ backend: createMemoryBackend("example-review-gate"), now });

  // #region relay
  // The wiring a host actually runs: the write step is the adapter behind
  // toWriteStep — the last schema.parse between a persisted outcome and the
  // tool's own API.
  const relay = createRelay({
    storage,
    transcriber: restrictToKind("audio", new FakeTranscriber({ text: "the attic is R-19" })),
    sessionExtract: toSessionExtractStep(new FakeExtractor(EXTRACTED)),
    sessionWrite: toWriteStep(adapter),
    locks: grantingLocks(),
    now,
  });
  const session = await storage.sessions.open({ ctx: { jobId: "job-7" }, ref: "job-7" });
  await storage.captures.enqueue({
    recording: {
      id: "rec-1",
      capturedAt: new Date(now()).toISOString(),
      kind: "audio",
      durationMs: 96_000,
      mimeType: "audio/webm",
      ctx: {},
    },
    audio: new Blob(["not really audio"], { type: "audio/webm" }),
    sessionId: session.id,
  });
  await relay.syncNow();
  await storage.sessions.close(session.id);
  await relay.syncNow();
  // #endregion relay

  // #region gate
  // The session is parked at awaiting-review — and the relay gets its chance
  // to write anyway. The zero-writes assertion is the point: reading the
  // status alone would not catch a relay that wrote behind the reviewer's back.
  await relay.syncNow();
  const parked = await storage.sessions.get(session.id);
  assert.equal(parked?.status, "awaiting-review");
  assert.equal(writes.length, 0, "nothing may be written while the review waits");
  // #endregion gate

  // #region review
  // The request is built from the extraction the parked session carries,
  // against the transcript it was grounded in — review of a real session, not
  // a bare call.
  const rows = await storage.captures.list({ sessionId: session.id });
  const transcript = rows[0]?.transcript;
  assert.ok(transcript, "the capture row carries its transcript");
  assert.ok(parked?.extracted, "the parked session carries its extraction");
  const request = buildReviewRequest(parked.extracted, transcript, valuesSchema);

  // The reviewer corrects the reading — R-19 was spoken, R-49 was measured.
  const decisions: Record<string, FieldDecision> = {
    "attic.insulation": { status: "edited", value: "R-49 across the attic" },
  };
  const outcome = resolveReview(request, { status: "submitted", decisions });
  assert.ok(outcome.status === "edited");
  // #endregion review

  // Only a human decision moves the session out of awaiting-review: submit,
  // and exactly one write follows — carrying the REVIEWED value, not the
  // extraction's.
  await storage.sessions.submitReview(session.id, {
    status: outcome.status,
    fields: outcome.fields,
    editedFields: [...outcome.editedFields],
    rejectedFields: [...outcome.rejectedFields],
  });
  await relay.syncNow();

  const done = await storage.sessions.get(session.id);
  assert.equal(done?.status, "done");
  assert.equal(writes.length, 1, "exactly one write follows the resolved review");
  assert.equal(writes[0]?.fields.attic?.insulation, "R-49 across the attic");
  assert.equal(writes[0]?.ctx.jobId, "job-7");
  relay.stop();
  await storage.close();
}
