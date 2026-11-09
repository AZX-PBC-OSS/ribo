/**
 * The runnable example behind docs/api/tool-adapter.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: the adapter is a fake, the storage a
 * memory backend.
 */

import assert from "node:assert/strict";
import { z } from "zod";
import {
  enveloped,
  deriveInstanceIdempotencyKey,
  ReceiptedWriteError,
  type SessionWriteInput,
  TerminalError,
  type ToolAdapter,
  toInstanceWriteStep,
  toWriteStep,
} from "@azx/ribo-core";

// A type alias, not an interface: `V` must carry an index signature, and only a
// type alias gets the implicit one.
type Values = z.infer<typeof valuesSchema>;

const valuesSchema = z.object({
  job: z.object({ narrative: z.string().nullable().optional() }).nullable().optional(),
  hvac: z
    .array(z.object({ equipment: z.string().nullable().optional() }))
    .nullable()
    .optional(),
});

interface WriteCall {
  fields: unknown;
  ctx: unknown;
  idempotencyKey: string;
  linkTarget?: string;
}

/** A fake adapter: real schemas, a write that records and returns a receipt. */
function fakeAdapter(options: { failSecondInstance?: boolean } = {}): {
  adapter: ToolAdapter<Values, { jobId: string }>;
  calls: WriteCall[];
} {
  const calls: WriteCall[] = [];
  let instanceCalls = 0;
  const adapter: ToolAdapter<Values, { jobId: string }> = {
    name: "fake-tool",
    schema: valuesSchema,
    extractionSchema: enveloped(valuesSchema),
    ctxSchema: z.object({ jobId: z.string() }),
    instructions: "a fake adapter",
    write: async (fields, ctx, meta) => {
      // One group per call: either the singleton patch or ONE instance's.
      const isInstance = Array.isArray(fields.hvac);
      const instanceNumber = isInstance ? instanceCalls++ : -1;
      calls.push({
        fields,
        ctx,
        idempotencyKey: meta.idempotencyKey,
        ...(meta.linkTarget === undefined ? {} : { linkTarget: meta.linkTarget }),
      });
      if (options.failSecondInstance === true && instanceNumber === 1) {
        // The record landed; the follow-up request failed. The receipt is real.
        throw new ReceiptedWriteError("receipt-landed", new Error("follow-up failed"));
      }
      return { receipt: `receipt-${String(calls.length)}` };
    },
  };
  return { adapter, calls };
}

function sessionRow(outcome: {
  fields: Record<string, unknown>;
  instanceKeys?: Record<string, readonly string[]>;
  linkTargets?: Record<string, readonly (string | null)[]>;
}): SessionWriteInput["session"] {
  return {
    id: "sess-1",
    status: "writing",
    openedAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
    ctx: { jobId: "job-7" },
    ref: "job-7",
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
    idempotencyKey: "idem-1",
    reviewOutcome: {
      status: "edited",
      fields: outcome.fields,
      editedFields: [],
      rejectedFields: [],
      ...(outcome.instanceKeys === undefined ? {} : { instanceKeys: outcome.instanceKeys }),
      ...(outcome.linkTargets === undefined ? {} : { linkTargets: outcome.linkTargets }),
    },
  } as never;
}

const reviewed = {
  job: { narrative: "Attic insulated to R-49" },
  hvac: [{ equipment: "Boiler" }, { equipment: "Heat pump" }],
};

function recordReceiptLog(): {
  log: { group: string; instanceKey: string; receipt: string }[];
  recordReceipt: SessionWriteInput["recordReceipt"];
} {
  const log: { group: string; instanceKey: string; receipt: string }[] = [];
  return {
    log,
    recordReceipt: async (group, instanceKey, receipt) => {
      log.push({ group, instanceKey, receipt });
    },
  };
}

export async function toWriteStepParsesThenHandsThePatchToTheAdapter(): Promise<void> {
  // #region usage
  const { adapter, calls } = fakeAdapter();
  const step = toWriteStep(adapter);
  const result = await step({
    session: sessionRow({ fields: reviewed }),
    reviewed,
    idempotencyKey: "idem-1",
    ctx: { jobId: "job-7" },
    recordReceipt: async () => undefined,
  });
  // #endregion usage

  // One call, the whole patch, one receipt under `singleton`.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.idempotencyKey, "idem-1");
  assert.deepEqual((result as { receipts?: unknown }).receipts, { singleton: "receipt-1" });
}

export async function aBadPatchOrContextIsTerminalBeforeAnythingIsWritten(): Promise<void> {
  const { adapter, calls } = fakeAdapter();
  const step = toWriteStep(adapter);

  // A ctx the ctxSchema refuses — set at session open, unfixable by retrying.
  await assert.rejects(
    step({
      session: sessionRow({ fields: reviewed }),
      reviewed,
      idempotencyKey: "idem-1",
      ctx: { jobId: 7 },
      recordReceipt: async () => undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof TerminalError);
      return true;
    },
  );
  // A patch the schema refuses — nothing was written.
  await assert.rejects(
    step({
      session: sessionRow({ fields: reviewed }),
      reviewed: { job: { narrative: 7 } },
      idempotencyKey: "idem-1",
      ctx: { jobId: "job-7" },
      recordReceipt: async () => undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof TerminalError);
      return true;
    },
  );
  assert.equal(calls.length, 0);
}

export async function toInstanceWriteStepSendsOneGroupPerCallAndCheckpointsReceipts(): Promise<void> {
  const { adapter, calls } = fakeAdapter();
  const step = toInstanceWriteStep({ adapter, collectionGroups: ["hvac"] });
  const receipts = recordReceiptLog();

  const result = await step({
    session: sessionRow({ fields: reviewed, instanceKeys: { hvac: ["k1", "k2"] } }),
    reviewed,
    idempotencyKey: "idem-1",
    ctx: { jobId: "job-7" },
    recordReceipt: receipts.recordReceipt,
  });

  // One call per instance, plus one for the singleton group.
  assert.equal(calls.length, 3);
  // Each checkpoint is recorded as it is earned — a throw later in the loop
  // cannot discard it.
  assert.deepEqual(receipts.log, [
    { group: "hvac", instanceKey: "k1", receipt: "receipt-2" },
    { group: "hvac", instanceKey: "k2", receipt: "receipt-3" },
  ]);
  assert.deepEqual((result as { receipts?: { instances?: unknown } }).receipts?.instances, {
    hvac: { k1: "receipt-2", k2: "receipt-3" },
  });
}

export async function aReceiptedFailureIsCheckpointedThenRethrownAsItsCause(): Promise<void> {
  const { adapter } = fakeAdapter({ failSecondInstance: true });
  const step = toInstanceWriteStep({ adapter, collectionGroups: ["hvac"] });
  const receipts = recordReceiptLog();

  // The cause — not the wrapper — is what the relay classifies.
  await assert.rejects(
    step({
      session: sessionRow({ fields: reviewed, instanceKeys: { hvac: ["k1", "k2"] } }),
      reviewed,
      idempotencyKey: "idem-1",
      ctx: { jobId: "job-7" },
      recordReceipt: receipts.recordReceipt,
    }),
    /follow-up failed/,
  );
  // The landed record's receipt survived the failure: the retry UPDATEs it
  // instead of creating a duplicate. The first instance's checkpoint is here
  // too — it was earned before the throw.
  assert.deepEqual(receipts.log, [
    { group: "hvac", instanceKey: "k1", receipt: "receipt-2" },
    { group: "hvac", instanceKey: "k2", receipt: "receipt-landed" },
  ]);
}

export async function aReceiptFromAnEarlierAttemptTurnsTheRetryIntoAnUpdate(): Promise<void> {
  const { adapter, calls } = fakeAdapter();
  const step = toInstanceWriteStep({ adapter, collectionGroups: ["hvac"] });
  const receipts = recordReceiptLog();

  // A human's link decision wins over a stored receipt; without one, the
  // receipt an earlier attempt recorded means the record exists — UPDATE it.
  await step({
    session: sessionRow({
      fields: reviewed,
      instanceKeys: { hvac: ["k1", "k2"] },
      linkTargets: { hvac: ["chosen-uuid", null] },
    }),
    reviewed,
    idempotencyKey: "idem-2",
    ctx: { jobId: "job-7" },
    recordReceipt: receipts.recordReceipt,
  });

  // calls[0] is the singleton group's write; the instances follow.
  assert.equal(calls[1]?.linkTarget, "chosen-uuid");
  assert.equal(calls[2]?.linkTarget, undefined);
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // deriveInstanceIdempotencyKey's output format, read from
  // packages/ribo-core/src/write/instance-write-step.ts. The page quotes it
  // next to this region; a source change that moved it fails here.
  assert.equal(deriveInstanceIdempotencyKey("idem-1", "hvac", 0), "idem-1:instance:hvac:0");
  // Stable across retries of the same instance, distinct between instances.
  assert.equal(
    deriveInstanceIdempotencyKey("idem-1", "hvac", 0),
    deriveInstanceIdempotencyKey("idem-1", "hvac", 0),
  );
  assert.notEqual(
    deriveInstanceIdempotencyKey("idem-1", "hvac", 0),
    deriveInstanceIdempotencyKey("idem-1", "hvac", 1),
  );
}
// #endregion defaults
