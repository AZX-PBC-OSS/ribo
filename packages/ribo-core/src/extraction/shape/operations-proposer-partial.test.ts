import { ChatError } from "../../phases/chat-client.js";
import type { ChatClient, ChatCompletion, ChatRequest } from "../../phases/chat-client.js";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { proposeShapeOperations } from "./operations-proposer.js";

/**
 * @file The proposer's half of the partial-application change.
 *
 * The repair turn now receives EVERY refusal the applier found in one pass —
 * two bad operations (or eighteen) cost one repair turn, not N — and at
 * exhaustion the function returns the surviving subset of the final proposal
 * instead of `[]`. `[]` remains the answer when nothing survived, and the two
 * transport-exhaustion exits still return it: no proposal arrived on that
 * turn to partially apply. ADR 0016's exhaustion default is amended by ADR
 * 0023; the `[]` case is a special case of the new value, not a contradiction.
 */

const surveySchema = z.object({
  vessel: z.object({
    identification: z.object({
      name: z.string().nullable().optional(),
      buildYear: z.string().nullable().optional(),
    }),
    dimensions: z.object({
      lengthM: z.number().nullable().optional(),
      beamM: z.number().nullable().optional(),
    }),
    notes: z.string().nullable().optional(),
  }),
  engines: z.array(
    z.object({
      make: z.string().nullable().optional(),
      ratingKw: z.string().nullable().optional(),
      serialNumber: z.string().nullable().optional(),
    }),
  ),
});

/** A ChatClient that records every request and replays a script of completions or errors. */
function scriptedChat(script: readonly (ChatCompletion | Error)[]): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      const step = script[requests.length - 1];
      if (step === undefined) return Promise.reject(new Error("scripted chat exhausted"));
      return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
    },
  };
  return { chat, requests };
}

const completion = (body: unknown): ChatCompletion => ({
  content: JSON.stringify(body),
  finishReason: "stop",
});

describe("proposer — collect every refusal in the repair turn", () => {
  test("a first proposal with TWO bad operations gets one repair turn naming both, and is accepted", async () => {
    // Must-fail 11. Today the repair turn carries the first refusal the
    // applier reached; the second bad operation would cost a second repair
    // turn. One turn now carries both.
    const { chat, requests } = scriptedChat([
      completion({
        operations: [
          { op: "drop", path: "vessel.notes" },
          { op: "drop", path: "vessel.ghost" },
          { op: "retype", path: "vessel.dimensions.lengthM", to: "number" },
        ],
      }),
      completion({
        operations: [
          { op: "drop", path: "vessel.notes" },
          { op: "retype", path: "vessel.identification.buildYear", to: "number" },
        ],
      }),
    ]);

    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "repair-all-refusals",
      instructions: "",
    });

    expect(ops).toEqual([
      { op: "drop", path: "vessel.notes" },
      { op: "retype", path: "vessel.identification.buildYear", to: "number" },
    ]);
    // Accepted after exactly one repair attempt — both refusals arrived in
    // one turn, so one fix sufficed.
    expect(requests).toHaveLength(2);
    const feedback = requests[1]!.messages.at(-1)!;
    expect(feedback.role).toBe("user");
    expect(feedback.content).toContain("not produce a valid extraction shape");
    // Both refusals are named — each the applier's own message, prefixed with
    // the operation it names.
    expect(feedback.content).toContain(
      'deriveExtractionShape(): drop names "vessel.ghost", which is not a path of the schema.',
    );
    expect(feedback.content).toContain('retype at "vessel.dimensions.lengthM" needs a string');
    expect(feedback.content).toContain('drop "vessel.ghost"');
    expect(feedback.content).toContain('retype "vessel.dimensions.lengthM"');
  });
});

describe("proposer — exhaustion returns the surviving subset", () => {
  test("a final proposal that is mostly good returns its survivors, not []", async () => {
    // Must-fail 12. The live incident's ending: a proposal that never fully
    // validates now yields its surviving operations instead of nothing.
    const mostlyGood = {
      operations: [
        { op: "drop", path: "vessel.notes" },
        { op: "retype", path: "vessel.identification.buildYear", to: "number" },
        { op: "drop", path: "vessel.ghost" },
      ],
    };
    const { chat, requests } = scriptedChat([completion(mostlyGood), completion(mostlyGood)]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "exhaustion-survivors",
      instructions: "",
      maxRepairAttempts: 1,
    });
    expect(ops).toEqual([
      { op: "drop", path: "vessel.notes" },
      { op: "retype", path: "vessel.identification.buildYear", to: "number" },
    ]);
    expect(requests).toHaveLength(2);
  });

  test("a final proposal that is entirely refusable still returns []", async () => {
    const allBad = { operations: [{ op: "drop", path: "vessel.ghost" }] };
    const { chat, requests } = scriptedChat([completion(allBad), completion(allBad)]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "exhaustion-all-bad",
      instructions: "",
      maxRepairAttempts: 1,
    });
    expect(ops).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  test("transport exhaustion on a repair attempt still returns [] — no proposal arrived to salvage", async () => {
    // The two transport-exhaustion exits keep their value even when an
    // earlier attempt left survivors: on this turn the model was never
    // reached, so there is nothing to partially apply.
    const limited = ChatError.http(429, "openAiChat: 429 from /chat/completions");
    const { chat, requests } = scriptedChat([
      completion({
        operations: [
          { op: "drop", path: "vessel.notes" },
          { op: "drop", path: "vessel.ghost" },
        ],
      }),
      limited,
      limited,
      limited,
    ]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "exhaustion-transport",
      instructions: "",
      maxRepairAttempts: 1,
      networkRetryDelay: () => Promise.resolve(),
    });
    expect(ops).toEqual([]);
    // The initial call plus the repair attempt's three network tries.
    expect(requests).toHaveLength(4);
  });
});
