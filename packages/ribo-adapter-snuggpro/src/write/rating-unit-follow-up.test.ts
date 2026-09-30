import { describe, expect, test } from "vitest";
import { isTransientFailure, TerminalError, toInstanceWriteStep } from "@azx/ribo-core";

import { createSnuggProAdapter } from "../adapter.js";
import { snuggCtxSchema } from "../context.js";

/**
 * `createHvac` discards a sent rating unit and derives one from the equipment type;
 * `updateHvac` stores it (measured on staging, 2026-09-30). The writer therefore
 * follows a create that states a unit with an update of the new record.
 *
 * Everything runs through the real `toInstanceWriteStep` over `createSnuggProAdapter`
 * with a fake `fetch`: the receipt invariant lives in the composition, not in the
 * writer alone. A failed follow-up must leave the receipt recorded, or the retry
 * creates a second record on a customer's job.
 */

type StepInput = Parameters<ReturnType<typeof toInstanceWriteStep>>[0];

const ctx = snuggCtxSchema.parse({
  assessmentId: "123",
  companyId: "co-1",
  apiBaseUrl: "https://gateway.example/snugg",
});

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

type Responder = (call: Call, index: number) => Response | Promise<Response>;

const fakeVendor = (respond: Responder): { fetchImpl: typeof fetch; calls: Call[] } => {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace("/snugg", ""),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { fetchImpl, calls };
};

const json = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), { status });

/** A vendor that creates as `uuid-1` and stores whatever an update sends. */
const creatingVendor =
  (updateResponse: (call: Call) => Response = () => json(200, { uuid: "uuid-1" })): Responder =>
  (call) =>
    call.path === "/jobs/123/hvac" ? json(201, { uuid: "uuid-1" }) : updateResponse(call);

const instance = {
  hvacSystemEquipmentType: "Boiler",
  hvacUpgradeAction: "Keep an existing system as is",
  hvacHeatingSystemEfficiencyRatingUnit: "HSPF",
};

/** A session with one reviewed hvac instance, carrying `receipts` from earlier attempts. */
const stepInput = (
  values: Record<string, unknown>,
  options: { linkTarget?: string; receipts?: Record<string, string> } = {},
): { input: StepInput; recorded: Array<[string, string, string]> } => {
  const recorded: Array<[string, string, string]> = [];
  const session = {
    id: "session-1",
    idempotencyKey: "item-key",
    receipts: options.receipts ? { instances: { hvac: options.receipts } } : undefined,
    reviewOutcome: {
      status: "accepted",
      fields: { hvac: [values] },
      instanceKeys: { hvac: ["k1"] },
      ...(options.linkTarget ? { linkTargets: { hvac: [options.linkTarget] } } : {}),
    },
  } as unknown as StepInput["session"];
  return {
    recorded,
    input: {
      session,
      reviewed: { hvac: [values] },
      idempotencyKey: "item-key",
      ctx,
      recordReceipt: async (group, instanceKey, receipt) => {
        recorded.push([group, instanceKey, receipt]);
      },
    },
  };
};

const stepFor = (fetchImpl: typeof fetch) =>
  toInstanceWriteStep({
    adapter: createSnuggProAdapter({ fetchImpl }),
    collectionGroups: ["hvac"],
  });

const failureOf = async (run: Promise<unknown>): Promise<unknown> => {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("expected the step to reject");
};

describe("the rating-unit follow-up", () => {
  test("a create that states a unit is followed by an update of the new uuid carrying just the unit", async () => {
    const { fetchImpl, calls } = fakeVendor(creatingVendor());
    const { input, recorded } = stepInput({
      ...instance,
      hvacCoolingSystemEfficiencyRatingUnit: "EER",
    });

    await stepFor(fetchImpl)(input);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /jobs/123/hvac",
      "POST /jobs/hvac/uuid-1",
    ]);
    expect(calls[1]!.body).toEqual({
      hvacHeatingSystemEfficiencyRatingUnit: "HSPF",
      hvacCoolingSystemEfficiencyRatingUnit: "EER",
    });
    expect(recorded).toEqual([["hvac", "k1", "uuid-1"]]);
  });

  test("a create that states no unit sends no follow-up, and neither does an explicit null", async () => {
    for (const values of [
      { hvacSystemEquipmentType: "Boiler", hvacUpgradeAction: "Keep an existing system as is" },
      { ...instance, hvacHeatingSystemEfficiencyRatingUnit: null },
    ]) {
      const { fetchImpl, calls } = fakeVendor(creatingVendor());
      await stepFor(fetchImpl)(stepInput(values).input);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /jobs/123/hvac"]);
    }
  });

  test("an update of an existing record sends no follow-up", async () => {
    const { fetchImpl, calls } = fakeVendor(creatingVendor());

    await stepFor(fetchImpl)(stepInput(instance, { linkTarget: "existing-uuid" }).input);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /jobs/hvac/existing-uuid"]);
  });

  test("a transient follow-up failure keeps the receipt, and the retry updates instead of creating again", async () => {
    let failFollowUp = true;
    const { fetchImpl, calls } = fakeVendor(
      creatingVendor(() => {
        if (failFollowUp) return json(503);
        return json(200, { uuid: "uuid-1" });
      }),
    );
    const step = stepFor(fetchImpl);

    const first = stepInput(instance);
    const error = await failureOf(step(first.input));

    expect(isTransientFailure(error)).toBe(true);
    expect(first.recorded).toEqual([["hvac", "k1", "uuid-1"]]);

    // The relay hands the recorded receipt back on the session.
    failFollowUp = false;
    const retry = stepInput(instance, { receipts: { k1: "uuid-1" } });
    await step(retry.input);

    const creates = calls.filter((c) => c.path === "/jobs/123/hvac");
    expect(creates).toHaveLength(1);
    // Attempt one: create + failed follow-up. Attempt two: one update with the whole group.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /jobs/123/hvac",
      "POST /jobs/hvac/uuid-1",
      "POST /jobs/hvac/uuid-1",
    ]);
    expect(calls[2]!.body).toMatchObject({ hvacHeatingSystemEfficiencyRatingUnit: "HSPF" });
  });

  test("a network failure on the follow-up also keeps the receipt", async () => {
    const { fetchImpl } = fakeVendor(
      creatingVendor(() => Promise.reject(new TypeError("fetch failed")) as never),
    );
    const { input, recorded } = stepInput(instance);

    const error = await failureOf(stepFor(fetchImpl)(input));

    expect(isTransientFailure(error)).toBe(true);
    expect(recorded).toEqual([["hvac", "k1", "uuid-1"]]);
  });

  test("a terminal follow-up failure keeps the receipt, and is loud: terminal, naming the record and the lost unit", async () => {
    const { fetchImpl } = fakeVendor(creatingVendor(() => json(422, { message: "bad unit" })));
    const { input, recorded } = stepInput(instance);

    const error = await failureOf(stepFor(fetchImpl)(input));

    expect(error).toBeInstanceOf(TerminalError);
    expect(isTransientFailure(error)).toBe(false);
    expect(String(error)).toContain("uuid-1");
    expect(String(error)).toContain("WITHOUT");
    expect(recorded).toEqual([["hvac", "k1", "uuid-1"]]);
  });
});
