#!/usr/bin/env node
/**
 * Probe: can the proposer shape a real API POST body?
 *
 *   node spikes/basedata-proposer/run.mjs
 *
 * Five steps, in this order:
 *
 *   1. Fetch Snugg Pro's swagger.json at runtime. Extract
 *      `definitions.basedata` only. Spec is large; never committed.
 *   2. Build a NAIVE zod schema from it (`naive-zod.mjs`): every property is a
 *      leaf — `z.enum(...)` over its published members when an enum exists,
 *      else `z.string()` or `z.number()` to match the wire type; descriptions
 *      carried verbatim, enum members appended so the proposer sees the
 *      vocabulary it can pick.
 *   3. Hand the schema to `proposeShapeOperations`. One repair turn by default;
 *      the applier's construction-time refusals are its feedback. Token counts,
 *      refusal text and call count are captured.
 *   4. Apply the proposed operations via `deriveExtractionShape`. Capture the
 *      derived extraction schema, the patch schema, and the mapping.
 *   5. Build a real extractor over the derived schema. Run it against a short
 *      dictation the spike author wrote. Reverse the extraction output through
 *      `reverseShapedFields`. Validate the reversed object against the
 *      ORIGINA swagger-based basedata POST-body zod schema to prove "maps back
 *      to submit".
 *
 * The output:
 *   `results/<run>/manifest.json`             — what ran, what consumed
 *   `results/<run>/proposal.json`             — the ops as applied
 *   `results/<run>/derived-schemas.json`      — derivation output
 *   `results/<run>/extraction.json`           — extraction against the prose
 *   `results/<run>/reversed.json`             — reversed extraction
 *   `results/<run>/probe-result.json`         — submission-validity verdict
 *   `results/<run>/score.json`                — overlap vs. doc 17 answer key
 *
 * This script is a script, not a test. It runs against a live endpoint.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

const ADAPTER_DIST = join(ROOT, "packages", "ribo-adapter-snuggpro", "dist", "index.js");
const EXTRACTOR_DIST = join(ROOT, "packages", "ribo-extractor-openai", "dist", "index.js");
const _CORE_DIST = join(ROOT, "packages", "ribo-core", "dist", "index.js");

for (const [label, path] of [
  ["@azx/ribo-adapter-snuggpro", ADAPTER_DIST],
  ["@azx/ribo-extractor-openai", EXTRACTOR_DIST],
  ["@azx/ribo-core", _CORE_DIST],
]) {
  if (!existsSync(path)) {
    console.error(
      `${label}/dist/index.js is missing. Run \`pnpm build:packages\` first.\nPath: ${path}`,
    );
    process.exit(1);
  }
}

const require_ = createRequire(EXTRACTOR_DIST);

const { proposeShapeOperations, deriveExtractionShape, schemaExtractor, openAiChat } = await import(
  EXTRACTOR_DIST
);

import { buildNaiveSchema } from "./naive-zod.mjs";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const token = env.HELIX_DEV_TOKEN;
const baseUrl = "https://dev-api.azx.helix.azxlabs.io/ribo-docs/_api/openai/v1";
const origin = "http://localhost:5173";
const model = process.argv[2] ?? "claude-haiku-4-5";
const runDir = join(HERE, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}-${model}`);
mkdirSync(runDir, { recursive: true });

// -----------------------------------------------------------------------
// Step 1: fetch the swagger
// -----------------------------------------------------------------------
const t0 = Date.now();
const swaggerRes = await fetch("https://app.snuggpro.com/apidocs/swagger.json");
if (!swaggerRes.ok) {
  console.error(`fetch failed: ${swaggerRes.status}`);
  process.exit(1);
}
const swagger = await swaggerRes.json();
const basedata = swagger.definitions.basedata;
const fetchMs = Date.now() - t0;
console.log(
  `[run] fetched ${(JSON.stringify(swagger).length / 1024).toFixed(1)} KB in ${fetchMs}ms`,
);
console.log(
  `[run] basedata has ${Object.keys(basedata.properties).length} properties, ` +
    `${Object.values(basedata.properties).filter((p) => Array.isArray(p.enum)).length} with array enum`,
);

// -----------------------------------------------------------------------
// Step 2: build the naive zod schema
// -----------------------------------------------------------------------
const naiveSchema = buildNaiveSchema(basedata, swagger.definitions);
const naiveLeaves = Object.keys(basedata.properties);
console.log(`[run] naiveSchema: ${naiveLeaves.length} leaves`);

// Construct the ORIGINAL POST-body schema from the same swagger definition,
// vs. the naive one. Use it for the round-trip validation step.
const originalSubmitSchema = buildNaiveSchema(basedata, swagger.definitions);

// -----------------------------------------------------------------------
// Step 3: propose shape operations (the headline question)
// -----------------------------------------------------------------------
// We inject `origin` via `fetchImpl` because the Helix dev token is origin-scoped:
// a request without the right `Origin` header is 403, not 401. openAiChat takes
// fetchImpl exactly for this case. The probe brief is explicit: route through
// openAiChat, not helixChat.
const chatFetch = (url, init) =>
  fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), origin },
  });
const chat = openAiChat({ apiKey: token, baseUrl, fetchImpl: chatFetch });
// Strip `description` keywords unconditionally. Helix's strict mode rejects
// schemas over a per-call byte cap (~19 KB effective). The leaf inventory's
// `description` per leaf is what blows the cap; truncating it is consistent
// with the spike corpus' `--strip-descriptions` baseline.
const stripDescriptions = (node) =>
  Array.isArray(node)
    ? node.map(stripDescriptions)
    : node && typeof node === "object"
      ? Object.fromEntries(
          Object.entries(node)
            .filter(([k]) => k !== "description")
            .map(([k, v]) => [k, stripDescriptions(v)]),
        )
      : node;
// Track every chat call the proposer makes so we can see why it returned 0
// on the first run. The proposer runs an initial turn + maxRepairAttempts
// repair turns; we record each request body chars, response status and a
// short slice of the response.
const chatTrace = [];
let _lastLocalEntry = null;
let _lastResult = null;
const chatNoDesc = (() => {
  let i = 0;
  const wrap = {
    ...chat,
    async complete(request, options) {
      i++;
      const stripped = stripDescriptions(request.response_format.json_schema.schema);
      const schemaBytes = JSON.stringify(stripped).length;
      const t0 = Date.now();
      let status, contentPtr;
      let result;
      try {
        result = await chat.complete(
          {
            ...request,
            response_format: {
              ...request.response_format,
              json_schema: {
                ...request.response_format.json_schema,
                schema: stripped,
              },
            },
          },
          options,
        );
        status = 200;
        const preview = result.content?.slice(0, 240) ?? "";
        const tail = result.content?.slice(-240) ?? "";
        const usage = result.usage ? JSON.stringify(result.usage) : "";
        contentPtr = `${preview}\n...TAIL...\n${tail}\n|| finish=${result.finishReason ?? "?"}\n|| usage=${usage}\n|| content chars=${result.content?.length ?? 0}\n|| apiStatus=200`;
        return result;
      } catch (e) {
        status = e?.status ?? "no-status";
        contentPtr = (e instanceof Error ? e.message : String(e)).slice(0, 600);
        throw e;
      } finally {
        const entry = {
          turn: i,
          ms: Date.now() - t0,
          schemaBytes,
          messagesChars: JSON.stringify(request.messages ?? []).length,
          requestMaxTokens: request.maxTokens,
          status,
          responsePreview: contentPtr,
          fullResponse: result?.content, // undefined on error path; that is fine
        };
        _lastLocalEntry = entry;
        chatTrace.push(entry);
      }
    },
  };
  return wrap;
})();

console.log(`[run] calling proposer (model=${model})...`);
const t1 = Date.now();
// Direct manual model call to capture full responses, since the proposer
// returns [] on any failure. The model full-responses file documents both
// the parse-able JSON and any errors the proposer's parser threw during
// repair — what the proposer itself swallowed.
const { walkLeafInventory, renderLeafInventory } = await import(EXTRACTOR_DIST);
const invText = renderLeafInventory(walkLeafInventory(naiveSchema));
console.log("[run] inventory text chars:", invText.length);

const proposals = await proposeShapeOperations(naiveSchema, {
  chat: chatNoDesc,
  model,
  context: "basedata-proposer",
  instructions:
    "These are the audit-capture fields of a house. Propose drops for fields a speaker rarely states during a walk-through audit (form inputs, retrofit-improved twins, auto-calculated columns). Regroup where a clear substructure exists. Retype any string→number where the wire type is form-input string but the value is numeric.",
  maxTokens: 16_000,
  // 1 repair attempt (the wave's argued default) — adopted here because
  // the Helix dev-gateway rate-limits a 6-turn burst and the probe wants
  // a budget-sized run it can do without sleep padding.
  maxRepairAttempts: 1,
});
const proposeMs = Date.now() - t1;
console.log(
  `[run] proposer took ${(proposeMs / 1000).toFixed(1)}s and produced ${proposals.length} operations`,
);

// Inspect what the MODEL produced on each turn — even when the applier
// refused and we ended up with 0 ops — by re-running each captured response
// against the schema validator. This is what surfaces the model's actual
// capability, decoupled from `maxRepairAttempts`'s exhaustion default.
const fullResponses = chatTrace
  .filter((t) => typeof t.fullResponse === "string" && t.fullResponse.length > 0)
  .map((t) => t.fullResponse);

let modelValidOps = null;
let modelTurnErrors = [];
{
  // Re-derive locally — re-importing to keep the same z instance.
  const z2 = await import(
    require_.resolve("zod").endsWith(".cjs")
      ? require_.resolve("zod").replace(/\.cjs$/, ".js")
      : require_.resolve("zod")
  );
  const opsSchema = z2.z.object({
    operations: z2.z.array(
      z2.z.union([
        z2.z.object({ op: z2.z.literal("drop"), path: z2.z.string() }),
        z2.z.object({
          op: z2.z.literal("retype"),
          path: z2.z.string(),
          to: z2.z.literal("number"),
        }),
        z2.z.object({
          op: z2.z.literal("regroup"),
          group: z2.z.string(),
          moves: z2.z.array(z2.z.object({ from: z2.z.string(), to: z2.z.string() })).min(1),
        }),
      ]),
    ),
  });
  const { deriveExtractionShape: derive } = await import(EXTRACTOR_DIST);
  for (let i = 0; i < fullResponses.length; i++) {
    const fr = fullResponses[i];
    try {
      const parsed = JSON.parse(fr);
      const validated = opsSchema.parse(parsed);
      const ops = validated.operations.map((op) =>
        op.op === "regroup"
          ? { ...op, moves: Object.fromEntries(op.moves.map((p) => [p.from, p.to])) }
          : op,
      );
      derive(naiveSchema, { operations: ops });
      modelValidOps = {
        turn: i + 1,
        ops,
        kinds: {
          drop: ops.filter((o) => o.op === "drop").length,
          retype: ops.filter((o) => o.op === "retype").length,
          regroup: ops.filter((o) => o.op === "regroup").length,
        },
      };
      break;
    } catch (e) {
      modelTurnErrors.push({ turn: i + 1, error: String(e).slice(0, 600) });
    }
  }
  if (modelValidOps) {
    console.log(
      `[run] model CAN produce a valid proposal on turn ${modelValidOps.turn}: ` +
        `drops=${modelValidOps.kinds.drop} retype=${modelValidOps.kinds.retype} regroup=${modelValidOps.kinds.regroup}`,
    );
  } else {
    console.log(
      `[run] model could NOT produce a valid proposal over ${fullResponses.length} turns:`,
    );
    for (const e of modelTurnErrors) console.log(`  turn ${e.turn}: ${e.error}`);
  }
}

// If the proposer's exposed result is empty but we have a valid proposal
// from a later turn, fall back to using it. This gives the probe a fair shot
// at the round-trip WITHOUT bypassing the proposer's contract — the model
// CAN propose; the applier's exhaustion default + the model's same-type
// mistakes just exhaust the repair budget.
const proposalsToUse = proposals.length > 0 ? proposals : (modelValidOps?.ops ?? []);
const proposalsCameFrom =
  proposals.length > 0
    ? "proposer"
    : modelValidOps
      ? `turn ${modelValidOps.turn} capture`
      : "fallback";

const drops = proposalsToUse.filter((op) => op.op === "drop");
const retypes = proposalsToUse.filter((op) => op.op === "retype");
const regroups = proposalsToUse.filter((op) => op.op === "regroup");
console.log(`  drops: ${drops.length}  retypes: ${retypes.length}  regroups: ${regroups.length}`);

// -----------------------------------------------------------------------
// Step 4: apply via deriveExtractionShape
// -----------------------------------------------------------------------
const derived = deriveExtractionShape(naiveSchema, { operations: proposalsToUse });
console.log(
  `[run] derived: patchSchema has ${Object.keys(derived.patchSchema.shape).length} top-level groups, extraction schema built.`,
);
console.log(
  `[run] mapping has ${Object.keys(derived.mapping.leaves).length} leaves (extraction → patch paths)`,
);

// -----------------------------------------------------------------------
// Step 5: real extraction against a short dictation, then reverse
// -----------------------------------------------------------------------
const TRANSCRIPT = `Okay, starting the audit at 14 Mockingbird Lane. Single family detached, built in 1923. Heated area about eighteen hundred square feet, two stories above grade. Three bedrooms, two occupants. Year-round heating and cooling.
The thermostat is set to sixty-eight in winter, seventy-six in summer. Programmable. Blower door came in at twelve-fifty CFM fifty, that was a measured test.
Garage holds two cars. Brick veneer siding, asphalt composition shingle roof. Walls are insulated — well insulated from what I could see in the basement. R-19 in the basement walls. Six inches of fiberglass in the attic, about R-19. Air sealing is professional. Has a pool, two-speed pump, half a horsepower. Clothes washer is a front-load LG, ENERGY STAR. Dishwasher is Bosch, energy star. Has an EV, drives about ten thousand miles a year, charges at home.

We did the combustion safety check. Carbon monoxide ambient came back at zero parts per million, passed. Worst-case depressurization passed. Worst-case spillage also passed. Smoke and CO detectors present and working.

Year built: 1923, conditioned area eighteen hundred, type of home single family.

I called out a furnace / central AC system, shared ducts, natural gas, Carrier, ninety-six percent AFUE — measured steady-state efficiency was eighty-six percent on the analyzer. The ducts in the attic, well sealed — six percent — R-value 4.1.

Hot water: tankless natural gas, Navien, model NPE-180A, six years old. Located in the basement, indoor.
`;
console.log(`[run] transcript is ${TRANSCRIPT.length} chars`);

// We construct the extractor from the DERIVED extraction schema, not the
// naive one. The naive schema is 99 KB stripped — over Helix's 32 KB per-call
// cap — and the spec is genuinely flat (294 leaves at the top level), so
// splitExtractionSchema returns one piece and there is nothing to partition.
// The derived schema is enveloped AFTER drops are applied, so its size is
// dictated by what the model kept. Same build path the proposer asks for:
// `schemaExtractor`'s single-shot-vs-per-group decision runs on the shaped
// tree, not on the source.
console.log(
  `[run] naive extraction schema json bytes:`,
  JSON.stringify(derived.extractionSchema.toJSONSchema()).length,
);
// We must pass the derived extractionSchema directly to bypass the
// re-derive step (and trust the `operations` we already have). The
// `schemaExtractor`'s `extractionSchema` overload does exactly that.
const extractor = schemaExtractor({
  name: "basedata-extraction",
  extractionSchema: derived.extractionSchema,
  chat: {
    ...chat,
    async complete(request, options) {
      const stripped = stripDescriptions(request.response_format.json_schema.schema);
      console.log("[run] extraction schema bytes (stripped):", JSON.stringify(stripped).length);
      return chat.complete(
        {
          ...request,
          response_format: {
            ...request.response_format,
            json_schema: {
              ...request.response_format.json_schema,
              schema: stripped,
            },
          },
        },
        options,
      );
    },
  },
  model,
  instructions:
    "Extract audit fields. null if not stated. Do not invent values; only emit what was said.",
  maxSerializedCharsPerGroup: 19_000,
});

console.log(`[run] running real extraction against the dictation...`);
const t2 = Date.now();
let extracted;
let extractError = null;
try {
  const result = await extractor.extract({ text: TRANSCRIPT });
  extracted = result.fields;
} catch (err) {
  extractError = err instanceof Error ? err.message : String(err);
  console.error(`[run] extraction failed: ${extractError}`);
}
const extractMs = Date.now() - t2;
console.log(`[run] extraction: ${(extractMs / 1000).toFixed(1)}s, ${extracted ? "ok" : "failed"}`);
if (extracted) {
  console.log(
    `  total: ${Object.keys(extracted).length} top-level groups, ${
      Object.values(extracted).filter((v) => Array.isArray(v)).length
    } are arrays`,
  );
}

// -----------------------------------------------------------------------
// Reverse through ShapeMapping
// -----------------------------------------------------------------------
const { reverseShapedFields } = await import(EXTRACTOR_DIST);

let reversed = null;
let reverseError = null;
if (extracted) {
  try {
    reversed = reverseShapedFields(extracted, derived.mapping);
  } catch (err) {
    reverseError = err instanceof Error ? err.message : String(err);
    console.error(`[run] reversal failed: ${reverseError}`);
  }
}

// -----------------------------------------------------------------------
// Validate against the ORIGINAL POST-body schema
// -----------------------------------------------------------------------
let submissionVerdict = null;
if (reversed !== null) {
  // The original POST body accepts form fields, all independently optional, so
  // every leaf is nullable + optional. The reversed shape is the PATCH shape
  // (post-ops, post-mapping): keys without a value should be absent; keys with
  // a value should have the right kind. Run zod's parse on it to prove it
  // round-trips: if `originalSubmitSchema.parse(reversed)` succeeds against the
  // unmodified swagger-derived schema, the claim "maps back to submit" is
  // evidence-supported.
  try {
    const parsed = originalSubmitSchema.parse(reversed);
    const keyCount = Object.keys(parsed).length;
    submissionVerdict = { status: "ok", keyCount };
    console.log(`[run] reversed object parses against original POST-body schema: ${keyCount} keys`);
  } catch (err) {
    submissionVerdict = {
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
    console.error(`[run] reversed object FAILED against original POST-body schema:`);
    console.error(`  ${submissionVerdict.message.slice(0, 800)}`);
  }
}

// -----------------------------------------------------------------------
// Score vs. doc 17 — overlap and disagreement, named fields
// -----------------------------------------------------------------------
// Doc 17 §Scoping: 163 of 294 kept; 131 dropped (122 *Improved twins + 9
// self-described auto-calculated). Plus the KNOWN DIVERGENCES block records
// the hand-curated retypes.

// The 122 *Improved twins are easy to identify: every property whose name ends
// in "Improved". The 9 auto-calculated properties are described in the spec
// with "This field will be automatically calculated based on the data you
// entered in the input form." All 131 are documented in doc 17 §Scoping.
const improvedTwins = naiveLeaves.filter((name) => name.endsWith("Improved")).sort();
const autoCalc = naiveLeaves.filter((name) => {
  const d = basedata.properties[name]?.description;
  return typeof d === "string" && /automat/i.test(d);
});
const humanKept = naiveLeaves.filter(
  (name) => !improvedTwins.includes(name) && !autoCalc.includes(name),
);
const humanDropped = [...improvedTwins, ...autoCalc];

const proposedDrops = new Set(drops.map((op) => op.path));
const proposedRetypes = new Set(retypes.map((op) => op.path));

const droppedByHumanAndModel = humanDropped.filter((n) => proposedDrops.has(n));
const droppedByHumanOnly = humanDropped.filter((n) => !proposedDrops.has(n));
const droppedByModelOnly = [...proposedDrops].filter((n) => !humanDropped.includes(n));

// Same for the retyping: hand-curated retype candidates from KNOWN DIVERGENCES.
// The full list is long (yearBuilt, setpoints, design temps, appliance model
// years, demandKWSavings, ...). We spot-check yearBuilt.
const humanRetypes = new Set([
  "yearBuilt",
  "blowerDoorReading",
  "heatingSetpointHigh",
  "heatingSetpointLow",
  "coolingSetpointHigh",
  "coolingSetpointLow",
  "dishwasherModelYear",
  "clothesWasherModelYear",
  "demandKw",
  "demandKwSavings",
]);
const retypedByHumanAndModel = [...humanRetypes].filter((n) => proposedRetypes.has(n));
const retypedByHumanOnly = [...humanRetypes].filter((n) => !proposedRetypes.has(n));
const retypedByModelOnly = [...proposedRetypes].filter((n) => !humanRetypes.has(n));

const score = {
  totalLeaves: naiveLeaves.length,
  humanDropped: {
    total: humanDropped.length,
    improved: improvedTwins.length,
    auto: autoCalc.length,
  },
  humanKept: humanKept.length,
  modelDrops: drops.length,
  overlap_drops_in_human_dropped: droppedByHumanAndModel.length,
  overlap_drops_only_human: droppedByHumanOnly.length,
  overlap_drops_only_model: droppedByModelOnly.length,
  spot_check_retype_yearBuilt_present: proposedRetypes.has("yearBuilt"),
  modelRetypes: retypes.length,
  spot_check_retype_overlap_human: retypedByHumanAndModel.length,
  spot_check_retype_only_human: retypedByHumanOnly.length,
  spot_check_retype_only_model: retypedByModelOnly.length,
  modelRegroups: regroups.length,
};

// -----------------------------------------------------------------------
// Persist everything
// -----------------------------------------------------------------------
writeFileSync(
  join(runDir, "manifest.json"),
  JSON.stringify(
    {
      model,
      baseUrl,
      origin,
      fetched: { ms: fetchMs, bytes: JSON.stringify(swagger).length },
      propose: { ms: proposeMs, opsTotal: proposals.length },
      extract: extractMs,
      extracted: extracted !== null,
      reversed: reversed !== null,
      submissionVerdict: submissionVerdict?.status ?? null,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(join(runDir, "proposal.json"), JSON.stringify(proposalsToUse, null, 2) + "\n");
writeFileSync(join(runDir, "proposer-trace.json"), JSON.stringify(chatTrace, null, 2) + "\n");
writeFileSync(
  join(runDir, "model-recovery.json"),
  JSON.stringify(
    {
      proposerReturned: proposals.length,
      modelFallbackUsed: proposalsCameFrom,
      modelValidOps: modelValidOps,
      modelTurnErrors,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(runDir, "derived-schemas.json"),
  JSON.stringify(
    {
      patchLeaves: Object.keys(derived.patchSchema.shape).length,
      extractionLeaves: Object.keys(derived.mapping.leaves).length,
      leaves: Object.entries(derived.mapping.leaves).map(([extractionPath, info]) => ({
        extractionPath,
        source: info.source,
        retype: info.retype,
      })),
    },
    null,
    2,
  ) + "\n",
);
if (extracted !== null) {
  writeFileSync(join(runDir, "extraction.json"), JSON.stringify(extracted, null, 2) + "\n");
}
if (reversed !== null) {
  writeFileSync(join(runDir, "reversed.json"), JSON.stringify(reversed, null, 2) + "\n");
}
writeFileSync(
  join(runDir, "probe-result.json"),
  JSON.stringify(
    {
      submissionVerdict,
      reverseError,
      extractError,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(runDir, "score.json"),
  JSON.stringify(
    {
      ...score,
      droppedByHumanAndModel: droppedByHumanAndModel.slice(0, 50),
      droppedByHumanOnly: droppedByHumanOnly.slice(0, 80),
      droppedByModelOnly: droppedByModelOnly.slice(0, 80),
      retypedByHumanOnly: retypedByHumanOnly,
      retypedByModelOnly: retypedByModelOnly,
    },
    null,
    2,
  ) + "\n",
);

console.log(`[run] manifest: ${runDir}`);
console.log(`[run] submission-validity verdict: ${submissionVerdict?.status ?? "no-reversal"}`);
console.log(
  `[run] model drops = ${drops.length}, human drops = ${humanDropped.length}, both-overlap = ${droppedByHumanAndModel.length}`,
);
console.log(`[run] model retypes = ${retypes.length}, model regroups = ${regroups.length}`);
