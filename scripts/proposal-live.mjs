/**
 * Live run for the Stage 2 proposer. Records what operations a real route
 * proposes against a schema the library has never seen, and walks the
 * proposed-shape through `deriveExtractionShape` + `reshapedExtractor` so
 * the report carries a real extraction, not just the proposal step.
 *
 * This is **NOT** a test. It is a record of one run against one route
 * through one model, with tokens redacted. Run it with:
 *
 *     HELIX_DEV_TOKEN=$(grep '^HELIX_DEV_TOKEN=' /Users/ekongiy/projects/azx/ribo/.env.local | cut -d= -f2-) \
 *     node --experimental-vm-modules scripts/proposal-live.mjs
 *
 * Output: a transcript of (a) the rendered prompt the model saw, (b) the
 * model's response, (c) whether the applier accepted or refused the
 * proposal, (d) on acceptance, the extraction that runs end-to-end on a
 * crafted dictation. Tokens redacted. The dictation is in this repo; the
 * schema is in this repo; the credentials are gitignored.
 *
 * The schema deliberately has not been tuned against a fill-rate corpus.
 * The point of this run is to record "what a model given only a schema
 * does" — it is not evidence the schema is a good shape for the user's
 * domain.
 */

// zod lives in the workspace's .pnpm/ hoisted store rather than at the
// top of node_modules; importing by exact package path keeps this script
// free of a separate install.
import { z } from "../node_modules/.pnpm/zod@4.4.3/node_modules/zod/index.js";

// Load the dev token from the repo's gitignored .env.local. Reading the file
// directly rather than via a loader keeps this script void of platform deps.
import { readFileSync } from "node:fs";

const envPath = new URL("../.env.local", import.meta.url);
const envContent = readFileSync(envPath, "utf-8");
const devTokenLine = envContent.split("\n").find((line) => line.startsWith("HELIX_DEV_TOKEN="));
if (devTokenLine === undefined) {
  throw new Error("HELIX_DEV_TOKEN missing from .env.local");
}
const HELIX_DEV_TOKEN = devTokenLine.slice("HELIX_DEV_TOKEN=".length).trim();

const BASE_URL = "https://dev-api.azx.helix.azxlabs.io/ribo-docs/_api/openai/v1";

// Pick a model that is documented to support structured outputs.
const MODEL = "gpt-5.6-sol";

// One schema the library has never seen: a small "ride-share audit" schema
// that pitches three groups (rider, driver, vehicle) and three kinds each.
// Description text varies across leaves. None of this has been through the
// pilot corpus or any tuning pass.
const rideAudit = z.object({
  rider: z.object({
    fullName: z.string().describe("Rider's full name as stated.").nullable().optional(),
    pickupAddress: z.string().describe("Pickup address as spoken.").nullable().optional(),
    ratingFrom1To5: z
      .string()
      .describe("Rating the rider gave, 1 through 5.")
      .nullable()
      .optional(),
    notesInternal: z.string().nullable().optional(),
  }),
  driver: z.object({
    name: z.string().nullable().optional(),
    cabNumber: z.string().nullable().optional(),
    licensePlate: z.string().nullable().optional(),
    fifoQueuePosition: z
      .number()
      .describe("Position in the dispatch queue at pickup.")
      .nullable()
      .optional(),
  }),
  vehicle: z.object({
    make: z.string().nullable().optional(),
    modelYear: z
      .string()
      .describe("Year the vehicle was manufactured, as stated.")
      .nullable()
      .optional(),
    odometerMiles: z.number().nullable().optional(),
  }),
});

// The build path: I need to import the proposer from the BUILT packages
// because the script loads via Node, not Vite. The `tsdown` builds emit
// dist/ that this script consumes. The strategies and shape derivation live
// in `@azx/ribo-core` (ADR 0029); the `openAiChat` transport lives in
// `@azx/ribo-chat-openai`.
const coreBuild = new URL("../packages/ribo-core/dist/index.js", import.meta.url).pathname;
const { proposeExtractionShape, proposeShapeOperations, schemaExtractor, deriveExtractionShape } =
  await import(coreBuild);
const { openAiChat } = await import(
  new URL("../packages/ribo-chat-openai/dist/index.js", import.meta.url).pathname
);

// Origin-injecting fetch — explains how a dev token reaches the route.
const originInjectedFetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  if (!headers.has("origin")) headers.set("origin", "http://localhost:5173");
  return fetch(input, { ...init, headers });
};

// Record the propose call's request and response so the report carries the
// model's actual answer, not just the operation count.
const proposeLog = { request: null, response: null };
const recordingBaseChat = openAiChat({
  apiKey: HELIX_DEV_TOKEN,
  baseUrl: BASE_URL,
  fetchImpl: originInjectedFetch,
});
const recordingChat = {
  chat: {
    complete: async (request, options) => {
      // Capture only the propose type of call (`shape-proposal` is the
      // proposer's pinned wire schema name).
      if (
        request.response_format?.json_schema?.name === "shape-proposal" &&
        proposeLog.request === null
      ) {
        proposeLog.request = request;
        const result = await originInjectedFetch(BASE_URL + "/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${HELIX_DEV_TOKEN}`,
            origin: "http://localhost:5173",
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            response_format: request.response_format,
            ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          }),
          signal: options?.signal,
        });
        const body = await result.json();
        const fr = body.choices?.[0]?.finish_reason ?? "stop";
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new Error(
            `proposal-live: response from ${BASE_URL} had no choices[0].message.content string`,
          );
        }
        proposeLog.response = {
          status: result.status,
          finishReason: fr,
          content,
          usage: body.usage,
        };
        return { content, finishReason: fr };
      }
      // Subsequent calls (the inner schemaExtractor) go through the regular
      // openAiChat — they aren't part of the propose record.
      return recordingBaseChat.complete(request, options);
    },
  },
};

console.log("Schema under proposal:");
console.log("  - rider (object): fullName, pickupAddress, ratingFrom1To5, notesInternal");
console.log("  - driver (object): name, cabNumber, licensePlate, fifoQueuePosition");
console.log("  - vehicle (object): make, modelYear, odometerMiles");
console.log();

console.log("Asking the model for shape operations...");
const proposedOps = await proposeShapeOperations(rideAudit, {
  chat: recordingChat.chat,
  model: MODEL,
  context: "live-proposal",
  instructions:
    "Audit a taxi ride-share dictation. Drop any field virtually never dictated; " +
    "retype form-input string fields whose meaning is a number; regroup leaves that " +
    "extract better under a different parent; nest top-level leaves under a new group.",
});

if (proposeLog.request !== null) {
  console.log();
  console.log("The model saw:");
  console.log("--- system message ---");
  console.log(proposeLog.request.messages.find((m) => m.role === "system")?.content);
  console.log();
  console.log("--- user message (the leaf inventory) ---");
  console.log(proposeLog.request.messages.find((m) => m.role === "user")?.content);
  console.log();
  console.log("Wire schema name:", proposeLog.request.response_format.json_schema.name);
} else {
  console.log("WARNING: proposeLog.request was not captured.");
}

if (proposeLog.response !== null) {
  console.log();
  console.log("The model answered:");
  console.log(proposeLog.response.content);
  console.log(
    `finish_reason: ${proposeLog.response.finishReason}, ` +
      `usage: ${JSON.stringify(proposeLog.response.usage ?? {})}`,
  );
} else {
  console.log("WARNING: proposeLog.response was not captured.");
}

console.log();
console.log(`Proposed shape operations: ${proposedOps.length}`);
for (const op of proposedOps) {
  if (op.op === "drop") console.log(`  - drop "${op.path}"`);
  else if (op.op === "retype") console.log(`  - retype "${op.path}" to ${op.to}`);
  else if (op.op === "regroup" || op.op === "nest") {
    console.log(`  - ${op.op} on "${op.group}":`);
    for (const [from, to] of Object.entries(op.moves)) {
      console.log(`      "${from}" -> "${to}"`);
    }
  } else console.log(`  - UNPRINTED operation: ${JSON.stringify(op)}`);
}

const proposedShape = await proposeExtractionShape(rideAudit, {
  chat: recordingBaseChat,
  model: MODEL,
  context: "live-proposal-apply",
  instructions:
    "Audit a taxi ride-share dictation. Drop any field virtually never dictated; " +
    "retype form-input string fields whose meaning is a number; regroup leaves that " +
    "extract better under a different parent; nest top-level leaves under a new group.",
});

const leafCountAfter = Object.keys(proposedShape.mapping.leaves).length;
const leafCountPlain = Object.keys(deriveExtractionShape(rideAudit).mapping.leaves).length;
console.log(`Mapping leaf count: ${leafCountAfter} (no-ops would yield ${leafCountPlain})`);

// Build the inner extractor over the proposed extraction schema, script a
// follow-up extractor call to confirm the chain survives.
console.log();
console.log("End-to-end smoke: shape → schemaExtractor → grounded envelopes on the patched schema");
const inner = schemaExtractor({
  extractionSchema: proposedShape.extractionSchema,
  name: "ride-audit-live",
  instructions: "Fill the audit schema the proposer agreed on.",
  chat: recordingBaseChat,
  model: MODEL,
});

// A dictation we'd write, states fields including modelYear as a number
// (testing the retype if the proposer picked one) and an internal-notes
// claim (testing the drop if the proposer picked one).
const dictation =
  "Picked up Yvonne Kim at 1410 Maple. The driver was Esteban Lim, cab 4477, " +
  "plate RIB-2024. The Toyota was a 2018 model with 88,412 miles. Dispatch was at " +
  "queue position 7 at pickup. Rider rated the driver 5. End of dictation.";

console.log();
console.log("Dictation transcript:");
console.log(`"${dictation}"`);
console.log();

const extraction = await inner.extract({
  text: dictation,
  annotations: {},
});

const fields = extraction.fields;
console.log("Extracted fields (model output):");
console.log(
  JSON.stringify(
    {
      rider: fields.rider,
      driver: fields.driver,
      vehicle: fields.vehicle,
    },
    null,
    2,
  ),
);

console.log();
console.log("Notes:");
console.log(
  "- All envelopes above — note the sourceSpan is verbatim from the " +
    "dictation if the model grounded; absent otherwise.",
);
