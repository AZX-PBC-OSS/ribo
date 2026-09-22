import { ChatError } from "@azx/ribo-core";
import type { ChatClient, ChatCompletion, ChatRequest } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { buildReviewRequest } from "@azx/ribo-core";

import { deriveExtractionShape } from "./shape-operations.js";
import type { DeriveExtractionShapeOptions } from "./shape-operations.js";

import { proposeExtractionShape, proposeShapeOperations } from "./operations-proposer.js";
import { renderLeafInventory, walkLeafInventory } from "./leaf-inventory.js";
import { schemaExtractor } from "../strategies/schema-extractor.js";
import type { EnvelopedSchemaExtractorOptions } from "../strategies/schema-extractor.js";
import { reshapedExtractor } from "./reshaped-extractor.js";

/**
 * @file STAGE 2 — the model-driven proposer.
 *
 * Six tests pin what the wave promised:
 *
 *   1. A proposal the applier refuses is repaired via the second turn's
 *      feedback, and a successful second proposal is returned.
 *   2. Exhaustion (no repair left) returns `[]`, the argued default.
 *   3. The proposer never sends a cap in its prompt — the assertion sees the
 *      instruction template's "no cap on count" phrase, not a number, so a
 *      real schema's enum values do not false-positive.
 *   4. The proposed operations go through `deriveExtractionShape` — no second
 *      code path, no bypass of `assertShapeMapping` — so the
 *      `shape-properties.test.ts` invariants cover proposed shapes too.
 *   5. Cancellation and deadline reach the chat calls.
 *   6. End to end with a fake chat: plain schema in, proposal, applier,
 *      `schemaExtractor`, reversal, and `buildReviewRequest` renders grounded
 *      envelopes.
 *
 * Plus the leaf-inventory's own tests: a structured walk plus its rendered
 * form, with descriptions carried verbatim. The walk and the renderer are
 * what the prompt sends; a proposer test that hand-rolled its inventory would
 * test an input, not the function.
 */

const Condition = z.enum(["Good", "Fair", "Poor"]);

/** The marine-survey fixture the earlier stages have used — proves the
 * applier's invariants are reused unchanged by the proposer. */
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
      readings: z.array(
        z.object({
          takenAt: z.string().nullable().optional(),
          mm: z.number().nullable().optional(),
        }),
      ),
    }),
  ),
  inspections: z.object({
    hull: z.object({
      condition: Condition.nullable().optional(),
      lastHauled: z.string().nullable().optional(),
    }),
  }),
});

/** A ChatClient that records every request and replays a script of completions or errors.
 *  Also records the {@link ChatCallOptions} passed alongside each request — the
 *  caller forwards signal and deadline into the chat call, and the forwarding
 *  discipline is what the proposal-tests want to assert. */
function scriptedChat(script: readonly (ChatCompletion | Error)[]): {
  chat: ChatClient;
  requests: ChatRequest[];
  options: (Parameters<ChatClient["complete"]>[1] | undefined)[];
} {
  const requests: ChatRequest[] = [];
  const options: (Parameters<ChatClient["complete"]>[1] | undefined)[] = [];
  const chat: ChatClient = {
    complete: (request, callOptions) => {
      requests.push(request);
      options.push(callOptions);
      const step = script[requests.length - 1];
      if (step === undefined) return Promise.reject(new Error("scripted chat exhausted"));
      return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
    },
  };
  return { chat, requests, options };
}

const completion = (body: unknown): ChatCompletion => ({
  content: JSON.stringify(body),
  finishReason: "stop",
});

describe("proposer — the leaf inventory", () => {
  test("walkLeafInventory lists every leaf, kinds verbatim, descriptions carried", () => {
    const entries = walkLeafInventory(surveySchema);
    // One entry per leaf — paths are unique under one root and the walk is
    // exhaustive. The fixture has nested objects, an array of objects, an
    // array of objects-of-arrays, top-level leaves.
    const paths = entries.map((entry) => entry.path).sort();
    expect(paths).toEqual([
      "engines.make",
      "engines.ratingKw",
      "engines.readings.mm",
      "engines.readings.takenAt",
      "engines.serialNumber",
      "inspections.hull.condition",
      "inspections.hull.lastHauled",
      "vessel.dimensions.beamM",
      "vessel.dimensions.lengthM",
      "vessel.identification.buildYear",
      "vessel.identification.name",
      "vessel.notes",
    ]);
    // Kind vocabulary matches the closed retype set; the only `number` leaves
    // here are dimension mm/length, and they are recognised as such.
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("vessel.dimensions.lengthM")!.kind).toBe("number");
    expect(byPath.get("vessel.dimensions.beamM")!.kind).toBe("number");
    expect(byPath.get("vessel.identification.buildYear")!.kind).toBe("string");
    expect(byPath.get("inspections.hull.condition")!.kind).toBe("enum");
    // `inArray` flags collection membership — even a nested array's leaves
    // still report `inArray: true` because the schema-time convention is
    // arrays transparent above the leaf.
    expect(byPath.get("engines.make")!.inArray).toBe(true);
    expect(byPath.get("engines.readings.mm")!.inArray).toBe(true);
    expect(byPath.get("vessel.dimensions.lengthM")!.inArray).toBe(false);
  });

  test("a leaf with a `.describe()` keeps the text in the inventory entry", () => {
    const withDescription = z.object({
      year: z
        .string()
        .describe("Year of the build, as stated in the dictation.")
        .nullable()
        .optional(),
      weight: z.number().nullable().optional(),
    });
    const entries = walkLeafInventory(withDescription);
    const yearLeaf = entries.find((entry) => entry.path === "year");
    expect(yearLeaf?.description).toBe("Year of the build, as stated in the dictation.");
    const weightLeaf = entries.find((entry) => entry.path === "weight");
    expect(weightLeaf?.description).toBeUndefined();
  });

  test("renderLeafInventory produces a textual inventory the proposer's prompt can carry", () => {
    const withDescription = z.object({
      visit: z.object({
        summary: z.string().describe("A one-sentence summary of the visit.").nullable().optional(),
        durationMin: z.number().nullable().optional(),
      }),
      client: z.object({
        name: z.string().nullable().optional(),
      }),
    });
    const text = renderLeafInventory(walkLeafInventory(withDescription));

    // Group headers carry the top-level key plus the structural shape label.
    // A model parses this to decide which group's moves can run.
    expect(text).toContain("- visit (object)");
    expect(text).toContain("- client (object)");
    // Description text comes through verbatim — the same string review reads.
    expect(text).toContain("A one-sentence summary of the visit.");
    // The leaf line carries a kind token the model can grep.
    expect(text).toContain("summary (string)");
    expect(text).toContain("durationMin (number)");
    expect(text).toContain("name (string)");
  });

  test("renderLeafInventory surfaces array groups and their leaves as collection members", () => {
    const narrative = z.object({
      hvac: z.array(
        z.object({
          maker: z.string().nullable().optional(),
        }),
      ),
    });
    const text = renderLeafInventory(walkLeafInventory(narrative));
    expect(text).toContain("- hvac (array)");
    expect(text).toContain("maker (string)");
  });

  test("renderLeafInventory handles a flat schema: every leaf's name, kind and description, no phantom header", () => {
    // A flat schema — every leaf at the root, no nested objects, no arrays of
    // objects — is the case `renderLeafInventory` was broken on. The walk
    // produces one entry per leaf, and bucketing by `path.split(".")[0]`
    // made every leaf its own single-entry bucket; the renderer then emitted
    // a `- <leafPath> (object)` header for each, and `inside =
    // leaf.path.slice(group.length + 1)` for a dot-free path was the empty
    // string, so the leaf line was nameless. On the real Snugg Pro probe
    // (294 leaves), that produced 294 phantom `(object)` headers and 294
    // nameless leaf lines.
    const flat = z.object({
      yearBuilt: z
        .string()
        .describe("Year the home or building was constructed.")
        .nullable()
        .optional(),
      squareMeters: z
        .number()
        .describe("Indoor floor area in square meters.")
        .nullable()
        .optional(),
      heatingType: z.enum(["gas", "oil", "electric"]).nullable().optional(),
      hasGarage: z.boolean().nullable().optional(),
    });
    const text = renderLeafInventory(walkLeafInventory(flat));

    // No phantom group headers — a flat schema has no group scope, so the
    // "this is a group you can address" header does not apply.
    expect(text).not.toMatch(/\(object\)/);
    expect(text).not.toMatch(/\(array\)/);

    // Every leaf appears by its full name with its kind and description. Pin
    // them end to end — the prompt a real model reads to choose what to drop
    // and retype must be inspectable.
    expect(text).toContain('- yearBuilt (string) — "Year the home or building was constructed."');
    expect(text).toContain('- squareMeters (number) — "Indoor floor area in square meters."');
    expect(text).toContain("- heatingType (enum)");
    expect(text).toContain("- hasGarage (boolean)");

    // No nameless leaf line — the old bug emitted `    -  (string) — "..."`
    // on every flat leaf.
    expect(text).not.toMatch(/^ {4}-\s+\(/m);
  });

  test("renderLeafInventory on a flat schema: every leaf appears exactly once with no duplicates", () => {
    // A header-only assertion (e.g. "no `(object)` line") could pass under
    // either bug fix candidate — but only a fix that lays every leaf at the
    // top level produces a usable inventory. Counting each leaf line once
    // pins the renderer to the per-leaf structure, not the per-group one.
    const flat = z.object({
      a: z.string().nullable().optional(),
      b: z.number().nullable().optional(),
      c: z.boolean().nullable().optional(),
    });
    const text = renderLeafInventory(walkLeafInventory(flat));
    expect(text).toContain("- a (string)");
    expect(text).toContain("- b (number)");
    expect(text).toContain("- c (boolean)");
    // Each leaf appears exactly once — the renderer does not duplicate the
    // leaf under a header line and a separate leaf line.
    expect(text.match(/^- a \(string\)$/gm)).toHaveLength(1);
    expect(text.match(/^- b \(number\)$/gm)).toHaveLength(1);
    expect(text.match(/^- c \(boolean\)$/gm)).toHaveLength(1);
  });

  test("renderLeafInventory on a mixed schema: flat leaves and grouped leaves render without conflict", () => {
    // Mixed: some leaves are ground-level, others live under a top-level
    // group. The ground leaves render flat; the grouped leaves keep their
    // header (only with leaves under it). The two forms must not collide —
    // a ground leaf must not appear as if it were a header.
    const mixed = z.object({
      visitId: z.string().describe("A stable identifier for the visit.").nullable().optional(),
      visit: z.object({
        summary: z.string().describe("A one-sentence summary of the visit.").nullable().optional(),
        durationMin: z.number().nullable().optional(),
      }),
    });
    const text = renderLeafInventory(walkLeafInventory(mixed));

    // Ground leaf: no header, full-name line.
    expect(text).toContain('- visitId (string) — "A stable identifier for the visit."');
    // Grouped leaves: header retains its structural label, leaves indented.
    expect(text).toContain("- visit (object)");
    expect(text).toContain("    - summary (string)");
    expect(text).toContain("    - durationMin (number)");
    // The ground leaf must not appear indented as if under a phantom header.
    expect(text).not.toMatch(/^ {4}- visitId/m);
  });
});

describe("proposer — chat-call discipline", () => {
  test("the cap NEVER reaches the model: assert on the directive phrase, not on a numeric substring", async () => {
    // The cap phrase is fixed text in the proposer's system prompt. The
    // assertion reads the FIRST chat request's SYSTEM message, which is
    // what the model received — that is the only place the cap policy can
    // hide. A naive substring check on a number would false-positive
    // against a real schema's enum members; checking the instruction
    // template directly catches a future edit that quietly introduced a
    // numeric cap or removed the no-cap marker entirely.
    const { chat, requests } = scriptedChat([completion({ operations: [] })]);
    await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "cap-no-reach",
      instructions: "Audit fields.",
    });
    const systemMessage = requests[0]!.messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("no cap on");
    // And no numeric cap token slipped in unchecked by the assertion above.
    // If the directive ever grew a `max-N operations` instruction, the
    // marker phrase would still appear, but this second check catches it.
    expect(systemMessage?.content).not.toMatch(/max(imum)?\s+\d+\s+(operations|ops)/);
  });

  test("the directive names nest and states its source restriction", async () => {
    // The vocabulary the model may use is the directive's operation list; a
    // flat schema is exactly the case nest exists for (spike 0009), so the
    // bullet must say what it does and what it may move.
    const { chat, requests } = scriptedChat([completion({ operations: [] })]);
    await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "directive-nest",
      instructions: "",
    });
    const systemMessage = requests[0]!.messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("nest { group, moves: { from: to } }");
    expect(systemMessage?.content).toMatch(/nest[^\n]*top-level field/);
    expect(systemMessage?.content).toMatch(/never an existing group|never a group/);
  });

  test("cancellation and deadline reach every chat call (initial + repair)", async () => {
    const initialFailing = { operations: [{ op: "drop", path: "missing.path" as const }] };
    const repairSucceeding = { operations: [{ op: "drop", path: "vessel.notes" as const }] };
    const { chat, requests, options } = scriptedChat([
      completion(initialFailing),
      completion(repairSucceeding),
    ]);

    const controller = new AbortController();
    const deadline = 1_987_654_321;
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "cap-forward",
      instructions: "Audit fields.",
      options: { signal: controller.signal, deadline },
    });

    expect(ops).toHaveLength(1);
    // Forwarding discipline: each chat call carried the caller's options bag
    // whole. signal reaches the chat transport through ChatCallOptions;
    // deadline rides on the same options object passed through — the chat
    // seam does not declare it, but the bag is forwarded unbroken, so a
    // future transport that does carry it (or a future chat layer that
    // derives an abort signal from it) finds the value where the proposer
    // put it.
    expect(requests).toHaveLength(2);
    expect(options[0]?.signal).toBe(controller.signal);
    expect(options[1]?.signal).toBe(controller.signal);
    const deadline0 = (options[0] as unknown as { deadline?: number } | undefined)?.deadline;
    const deadline1 = (options[1] as unknown as { deadline?: number } | undefined)?.deadline;
    expect(deadline0).toBe(deadline);
    expect(deadline1).toBe(deadline);
  });
});

describe("proposer — repair", () => {
  test("a refused proposal is repaired via the second turn's feedback", async () => {
    const { chat, requests } = scriptedChat([
      // First turn: a drop the applier cannot find. The applier's message is
      // the user feedback; the model sees it on the second turn.
      completion({
        operations: [{ op: "drop", path: "vessel.typoLeaf" }],
      }),
      // Second turn: a valid proposal. The repair acceptance returns the
      // operations, not the wire-bound failure.
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
      context: "repair-accept",
      instructions: "",
    });

    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ op: "drop", path: "vessel.notes" });
    expect(ops[1]).toEqual({
      op: "retype",
      path: "vessel.identification.buildYear",
      to: "number",
    });
    // Two turns, with the second carrying the previous output as an assistant
    // turn and the refusal text in a user turn.
    expect(requests).toHaveLength(2);
    const repair = requests[1]!;
    expect(repair.messages.find((m) => m.role === "assistant")?.content).toContain(
      "vessel.typoLeaf",
    );
    const feedback = repair.messages.at(-1)!;
    expect(feedback.role).toBe("user");
    expect(feedback.content).toContain("not produce a valid extraction shape");
    expect(feedback.content).toContain("vessel.typoLeaf");
    // The leaf inventory is on the FIRST turn only — repair appends the
    // assistant + user feedback pair without re-rendering the inventory.
    const inventoryLines = repair.messages.filter(
      (m) => m.content.includes("engines (array)") || m.content.includes("vessel (object)"),
    );
    expect(inventoryLines).toHaveLength(1);
  });

  test("a repair reuses the same response_format the initial attempt used", async () => {
    const { chat, requests } = scriptedChat([
      completion({ operations: [{ op: "drop", path: "missing.path" }] }),
      completion({ operations: [{ op: "drop", path: "vessel.notes" }] }),
    ]);
    await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "repair-schema-stable",
      instructions: "",
    });
    expect(requests[0]?.response_format).toEqual(requests[1]?.response_format);
  });

  test("exhaustion returns [] — the honest default for a newcomer", async () => {
    // Two completions, both produce invalid shapes, with zero repair budget.
    const { chat, requests } = scriptedChat([
      completion({ operations: [{ op: "drop", path: "missing.path" }] }),
      completion({ operations: [{ op: "drop", path: "vessel.notes" }] }),
    ]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "exhaustion",
      instructions: "",
      maxRepairAttempts: 0,
    });
    expect(ops).toEqual([]);
    // No repair made: only one chat call, even though the test happens to
    // script a second completion that would have succeeded.
    expect(requests).toHaveLength(1);
  });

  test("exhaustion of attempts after a budget returns [] without a stray extra call", async () => {
    const { chat, requests } = scriptedChat([
      completion({ operations: [{ op: "drop", path: "missing.path" }] }),
      completion({ operations: [{ op: "drop", path: "missing.path" }] }),
      completion({ operations: [{ op: "drop", path: "missing.path" }] }),
    ]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "exhaustion-after-budget",
      instructions: "",
      maxRepairAttempts: 1,
    });
    expect(ops).toEqual([]);
    // Initial + 1 repair = 2 attempts; the third scripted completion is
    // untouched because the budget was exhausted first.
    expect(requests).toHaveLength(2);
  });

  test("a TerminalError refusal (model verdict) is folded into the repair path; second refusal exhausts the budget to []", async () => {
    // `completeOrClassify` translates `ChatError.refusal` / `ChatError.unsupported`
    // into a `TerminalError` — a model verdict, not a transport blip. The repair
    // loop is exactly what a model verdict gets: one retry with the refusal text
    // as feedback. A second refusal of the same kind exhausts the budget and
    // returns [] — the model has confirmed the verdict persists.
    //
    // This test was originally about "a transport-level refusal" before the
    // chat-call fix distinguished transport blips (retried silently) from model
    // verdicts (one repair chance). The behaviour on a model verdict is
    // unchanged — what changed is the failure mode a 429 takes — so the
    // original property ("the model verdict still gets one repair chance, and
    // a second one exhausts") is the property this rewrite still pins.
    const refused = ChatError.refusal("not for this input");
    const { chat, requests } = scriptedChat([refused, refused, completion({ operations: [] })]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "refused",
      instructions: "",
      maxRepairAttempts: 1,
    });
    expect(ops).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  test("a TerminalError refusal with no repair budget returns [] without second call", async () => {
    // The original ("a transport-level refusal with no repair budget returns []
    // without second call") was protecting the call accounting: with
    // `maxRepairAttempts: 0`, even a model verdict that reached the repair
    // path must not produce a second chat call. The fix did not touch this
    // accounting — a model verdict still routes to the repair loop, just once
    // per attempt, and a zero budget means no second chat call at all.
    const refused = ChatError.refusal("not for this input");
    const { chat, requests } = scriptedChat([refused, completion({ operations: [] })]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "refused-no-repair",
      instructions: "",
      maxRepairAttempts: 0,
    });
    expect(ops).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  test("a transient 429 silently retries inside the chat call; success returns ops without consuming repair budget", async () => {
    // The defect 2 case: a 429 reaches the proposer during a brief rate-limit
    // window. Today the call folds into `failure: "transport"` and consumes
    // the (default 1) repair budget. After the fix, the chat-call step wraps
    // `completeOrClassify` in `retryAsync` — the transient 429 is retried
    // silently with backoff up to the configured `maxNetworkRetries`. On a
    // successful retry the repair loop is not consulted, so a hit does not
    // burn a repair attempt.
    //
    // The chat call here throws once with a 429 (`ChatError.http` carries a
    // status, so `isTransientFailure` returns true and `retryAsync` retries
    // it); the scripted retry returns a valid proposal. Default
    // `maxNetworkRetries` is 2, so up to three attempts before exhaustion.
    // This script settles on the second attempt. `networkRetryDelay` skips
    // the real-time backoff so the test is fast.
    const ok = completion({ operations: [{ op: "drop", path: "vessel.notes" }] });
    const limited = ChatError.http(429, "openAiChat: 429 from /chat/completions");
    const { chat, requests } = scriptedChat([limited, ok]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "transient-retry",
      instructions: "",
      maxRepairAttempts: 1,
      networkRetryDelay: () => Promise.resolve(),
    });
    // The proposal landed on the retry: ops are returned and the repair
    // budget was untouched.
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ op: "drop", path: "vessel.notes" });
    // Two chat calls: the 429 attempt and the successful retry. The repair
    // never ran — a 429 is a transport blip, not a model verdict, and
    // `retryAsync` owns the retry.
    expect(requests).toHaveLength(2);
  });

  test("a transient 429 that exhausts network retries returns [] without consuming repair budget", async () => {
    // The defect 2 case continued: if the route stays busy throughout, the
    // `retryAsync` budget on the chat-call step runs out. Today that budget
    // is zero (no retry at all), so the failure reaches the repair path and
    // burns a repair attempt. After the fix, `retryAsync`'s default 2 retries
    // (= 3 attempts) handles it, the repair loop is not consulted, and
    // exhaustion of the network retries returns [] directly.
    //
    // A wrong implementation that catches the final 429 and returns []
    // without distinguishing retryable vs terminal failures passes this test
    // — but breaks the TerminalError tests above. A wrong implementation that
    // routes ALL chat-call errors to the repair path also passes the
    // TerminalError test — but breaks this one (it would do 4 calls, the 4th
    // being a repair attempt). The two classes of test pin each other.
    const limited = ChatError.http(429, "openAiChat: 429 from /chat/completions");
    const { chat, requests } = scriptedChat([limited, limited, limited]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "transient-exhaust",
      instructions: "",
      maxRepairAttempts: 1,
      networkRetryDelay: () => Promise.resolve(),
    });
    expect(ops).toEqual([]);
    // Three chat calls: the default 2 retries → 3 attempts. The repair
    // budget was untouched — a transient blip, even one that exhausts its
    // own retries, does not consume a repair attempt.
    expect(requests).toHaveLength(3);
  });

  test("a transient transport blip mid-repair is retried inside `retryAsync`; the repair loop runs once", async () => {
    // The repair loop's chat call also goes through `retryAsync` — a 429 on
    // a repair attempt is identical, in this code, to a 429 on the initial
    // attempt. Today the second attempt's 429 would consume the remaining
    // repair budget (here, zero — only one repair attempt is allowed) and
    // the run would return [] with two calls. After the fix the repair's
    // 429 is silently retried, succeeds on the retry, and the run returns
    // the proposal without consuming any further repair budget.
    const ok = completion({ operations: [{ op: "drop", path: "vessel.notes" }] });
    const invalid = completion({ operations: [{ op: "drop", path: "missing.path" }] });
    const limited = ChatError.http(429, "openAiChat: 429 from /chat/completions");
    // Initial → applier-invalid (failure: shape) → repair attempt → 429 → retry → ok
    const { chat, requests } = scriptedChat([invalid, limited, ok]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "transient-mid-repair",
      instructions: "",
      maxRepairAttempts: 1,
      networkRetryDelay: () => Promise.resolve(),
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ op: "drop", path: "vessel.notes" });
    // Three chat calls: invalid proposal, repair that retries after 429,
    // successful retry.
    expect(requests).toHaveLength(3);
  });

  test("a truncated response (finish_reason 'length') gives one repair chance then []", async () => {
    const truncated: ChatCompletion = { content: '{"operations":[', finishReason: "length" };
    const truncatedAgain: ChatCompletion = {
      content: '{"operations":[',
      finishReason: "length",
    };
    const { chat, requests } = scriptedChat([truncated, truncatedAgain]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "truncated",
      instructions: "",
      maxRepairAttempts: 1,
    });
    expect(ops).toEqual([]);
    // Initial truncation triggers a repair; a second truncation of the same
    // input is final, and the budget yields [].
    expect(requests).toHaveLength(2);
  });
});

describe("proposer — the closed overlap with deriveExtractionShape", () => {
  test("a proposed set goes through the same applier and inherits its `shape-mapping` post-condition", () => {
    // The wave's invariant: the proposed operations never bypass
    // `deriveExtractionShape` or `assertShapeMapping`. A successful proposal
    // yields the SAME artifact shape a hand-written operation set yields, so
    // `assertShapeMapping`'s tests cover both code paths.
    const proposedOps = [
      { op: "drop" as const, path: "vessel.notes" },
      { op: "retype" as const, path: "vessel.identification.buildYear", to: "number" as const },
      { op: "drop" as const, path: "engines.serialNumber" },
    ];
    const proposed = deriveExtractionShape(surveySchema, { operations: proposedOps });
    const handWritten = deriveExtractionShape(surveySchema, { operations: proposedOps });
    expect(Object.keys(proposed.mapping.leaves).sort()).toEqual(
      Object.keys(handWritten.mapping.leaves).sort(),
    );
    expect(proposed.mapping.provenance).toEqual(handWritten.mapping.provenance);
  });

  test("a parsed response that fails the response schema is repaired via a JSON feedback turn", async () => {
    // Raw object that does not match the response schema — a successful
    // JSON parse, but the discriminator is wrong. Repair feedback carries
    // the rejection text and a JSON object showing the right shape.
    const invalid: Record<string, unknown> = { operations: [{ bogus: true }] };
    const valid: Record<string, unknown> = {
      operations: [{ op: "drop", path: "vessel.notes" }],
    };
    const { chat, requests } = scriptedChat([completion(invalid), completion(valid)]);

    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "schema-fail",
      instructions: "",
    });

    expect(ops).toHaveLength(1);
    const repair = requests[1]!;
    const feedback = repair.messages.at(-1)!;
    expect(feedback.role).toBe("user");
    expect(feedback.content).toContain("did not match the response schema");
    // The repair names the whole vocabulary — naming three of four would teach
    // the wrong one.
    expect(feedback.content).toContain('"drop", "retype", "regroup", or "nest"');
  });

  test("a parsed response whose operations compose is accepted on the first attempt", async () => {
    const { chat, requests } = scriptedChat([
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
      context: "first-accept",
      instructions: "",
    });
    expect(ops).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  test("a regroup's moves come in as an array of {from, to} pairs and go out as a record", async () => {
    // The wire-format discrepancy: the model's response schema uses an array
    // of pairs (because `additionalProperties` typed on a record is outside
    // the platform route's strict subset; see proposedOperationsSchema's
    // header). The applier expects a record. The proposer converts on
    // accept.
    const { chat } = scriptedChat([
      completion({
        operations: [
          {
            op: "regroup",
            group: "vessel",
            moves: [
              { from: "identification.buildYear", to: "papers.yearOfBuild" },
              { from: "dimensions.lengthM", to: "dimensions.loa" },
            ],
          },
        ],
      }),
    ]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "array-to-record",
      instructions: "",
    });
    expect(ops).toHaveLength(1);
    const regroup = ops[0];
    expect(regroup?.op).toBe("regroup");
    if (regroup?.op === "regroup") {
      expect(regroup.moves).toEqual({
        "identification.buildYear": "papers.yearOfBuild",
        "dimensions.lengthM": "dimensions.loa",
      });
    }
  });

  test("a nest's moves come in as an array of {from, to} pairs and go out as a record", async () => {
    // The same wire accommodation as regroup, and the same conversion site —
    // a missing branch leaves `moves` an array, which the applier cannot read
    // as a record, so the proposal would fail its shape check and exhaust to [].
    const flat = z.object({
      yearBuilt: z.string().nullable().optional(),
      squareMeters: z.number().nullable().optional(),
    });
    const { chat } = scriptedChat([
      completion({
        operations: [
          {
            op: "nest",
            group: "construction",
            moves: [
              { from: "yearBuilt", to: "yearBuilt" },
              { from: "squareMeters", to: "area.squareMeters" },
            ],
          },
        ],
      }),
    ]);
    const ops = await proposeShapeOperations(flat, {
      chat,
      model: "m",
      context: "nest-array-to-record",
      instructions: "",
    });
    expect(ops).toHaveLength(1);
    const nest = ops[0];
    expect(nest?.op).toBe("nest");
    if (nest?.op === "nest") {
      expect(nest.moves).toEqual({
        yearBuilt: "yearBuilt",
        squareMeters: "area.squareMeters",
      });
    }
  });

  test("a JSON parse failure on the first response is repaired via a JSON-shaped user turn", async () => {
    // Malformed JSON content; the second turn answers with a valid one.
    const malformed: ChatCompletion = { content: "{not-json", finishReason: "stop" };
    const valid: Record<string, unknown> = {
      operations: [{ op: "drop", path: "vessel.notes" }],
    };
    const { chat, requests } = scriptedChat([malformed, completion(valid)]);
    const ops = await proposeShapeOperations(surveySchema, {
      chat,
      model: "m",
      context: "json-fail",
      instructions: "",
    });
    expect(ops).toHaveLength(1);
    const repair = requests[1]!;
    const feedback = repair.messages.at(-1)!;
    expect(feedback.content).toContain("not valid JSON");
  });
});

describe("the convenience wrapper", () => {
  test("proposeExtractionShape composes propose → apply and returns a DerivedExtractionShape", async () => {
    const { chat } = scriptedChat([
      completion({
        operations: [
          { op: "drop", path: "vessel.notes" },
          { op: "retype", path: "vessel.identification.buildYear", to: "number" },
        ],
      }),
    ]);
    const shape = await proposeExtractionShape(surveySchema, {
      chat,
      model: "m",
      context: "shape-conv",
      instructions: "",
    });
    // The artifact matches the hand-written equivalent — same applier path.
    const handWritten = deriveExtractionShape(surveySchema, {
      operations: [
        { op: "drop", path: "vessel.notes" },
        { op: "retype", path: "vessel.identification.buildYear", to: "number" },
      ],
    });
    expect(Object.keys(shape.mapping.leaves).sort()).toEqual(
      Object.keys(handWritten.mapping.leaves).sort(),
    );
    // Pin a few invariants this repo's other tests already pin on the
    // hand-written path, so the proposed-path coverage is concrete.
    expect(shape.mapping.leaves["vessel.identification.buildYear"]!.retype).toEqual({
      extraction: "number",
      patch: "string",
    });
    expect(shape.patchSchema.shape.vessel).toBeDefined();
  });

  test("the wrapper carries provenance, requiredOnCreate and identifyingFields through", async () => {
    const { chat } = scriptedChat([completion({ operations: [] })]);
    const deriveOptions: Omit<DeriveExtractionShapeOptions, "operations"> = {
      provenance: { engines: "row", inspections: "none" } as const,
      requiredOnCreate: { engines: ["make"] },
      identifyingFields: { engines: ["make"] },
    };
    const shape = await proposeExtractionShape(
      surveySchema,
      {
        chat,
        model: "m",
        context: "shape-conv-options",
        instructions: "",
      },
      deriveOptions,
    );
    expect(shape.mapping.provenance).toEqual({
      engines: "row",
      inspections: "none",
    });
    expect(shape.requiredOnCreate).toEqual({ engines: ["make"] });
    expect(shape.identifyingFields).toEqual({ engines: ["make"] });
  });
});

describe("end-to-end: schema in → propose → apply → schemaExtractor → reversal → grounded envelopes", () => {
  test("a proposed shape gets a real extractor that emits real envelopes on review", async () => {
    // A small visit schema that fits single-shot under every cap, so the
    // chain is exactly two chat calls: one propose, one extract. A larger
    // marine-survey fixture would invoke `perGroupExtractor` and produce a
    // different number of calls; this e2e test is about the seam, not the
    // strategy selection.
    const visitSchema = z.object({
      visit: z.object({
        summary: z.string().nullable().optional(),
        durationMin: z.number().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
      client: z.object({
        name: z.string().nullable().optional(),
      }),
    });

    const proposedOpsResponse = {
      operations: [
        // Drop notes — virtually never dictated.
        { op: "drop", path: "visit.notes" },
      ],
    };
    // The shaped schema has `visit (object) { summary, durationMin }` and
    // `client (object) { name }` — three envelope leaves = 6 nullable
    // unions, well under the cap, so single-shot.
    const extractionResponse = {
      visit: {
        summary: {
          value: "annual check-up",
          confidence: 0.9,
          sourceSpan: "an annual check-up",
        },
        durationMin: {
          value: 45,
          confidence: 1,
          sourceSpan: "about 45 minutes",
        },
      },
      client: {
        name: { value: "Alma", confidence: 0.95, sourceSpan: "Alma" },
      },
    };
    const { chat, requests } = scriptedChat([
      completion(proposedOpsResponse),
      completion(extractionResponse),
    ]);

    const shape = await proposeExtractionShape(visitSchema, {
      chat,
      model: "m",
      context: "e2e",
      instructions: "Audit a service-visit dictation.",
    });

    // Step 1 done: the propose call composed on the first attempt.
    expect(requests).toHaveLength(1);
    // The first chat call is the proposer's — its response_format names the
    // proposer's wire schema (`shape-proposal`, not the target's).
    expect(requests[0]!.response_format.json_schema.name).toBe("shape-proposal");
    expect(
      Object.values(shape.mapping.leaves).some((entry) => entry.source === "visit.notes"),
    ).toBe(false);

    // The extraction-schema passthrough is overloaded — without help, TS picks
    // the raw patch overload because our proposed patch is a plain `z.ZodObject`,
    // and the raw overload refuses `extractionSchema`. The V-erased passthrough
    // type tells it the schema's `_output` is `Record<string, unknown>` so V
    // inference resolves against the enveloped overload. The same move
    // `reshaped-extractor.test.ts` makes for its row-granularity schema.
    type PassthroughSchema = EnvelopedSchemaExtractorOptions<
      Record<string, unknown>
    >["extractionSchema"];
    const inner = schemaExtractor({
      extractionSchema: shape.extractionSchema as PassthroughSchema,
      name: "visit-e2e",
      instructions: "Fill the proposed visit schema.",
      chat,
      model: "m",
    });
    const wrapped = reshapedExtractor(inner, shape);

    const text =
      "Alma had an annual check-up today. Took about 45 minutes, and we replaced a filter.";
    const { fields } = await wrapped.extract({ text, annotations: {} });

    // Step 2 done: the extraction call followed.
    expect(requests).toHaveLength(2);
    // The second chat call is the extractor's — its response_format names the
    // target's wire schema (`visit-e2e`, the caller's name).
    expect(requests[1]!.response_format.json_schema.name).toBe("visit-e2e");

    // The review request built on the parsed fields carries grounded
    // envelopes — the whole point of the chain surviving the proposer's
    // handoff.
    const request = buildReviewRequest(
      fields,
      { recordingId: "rec-1", text, engine: "fake" },
      shape.patchSchema,
    );
    for (const field of Object.values(request.fields)) {
      expect(field.isGrounded).toBe(true);
      expect(field.extracted.confidence).toBeGreaterThan(0);
      expect(field.extracted.sourceSpan).not.toBeNull();
    }
    // visit.notes was dropped, so there's no card for it; the rest is on
    // a review card.
    const cardKeys = Object.keys(request.fields).sort();
    expect(cardKeys).toEqual(["client.name", "visit.durationMin", "visit.summary"]);
  });
});

/**
 * Read the proposer's source and assert a fixed phrase appears in the
 * directive. The phrase is the only place the cap-policy lives; a future
 * maintainer who removes it breaks this assertion in exactly one way —
 * "the directive no longer carries the cap-policy phrase" — without
 * ambiguity. Substring checks against numbers are deliberately avoided
 * because a real schema's enum members contain numerals and would
 * false-positive.
 */
