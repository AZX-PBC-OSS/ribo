/**
 * Retry flattened runs whose meta recorded a schema error. Deletes nothing;
 * only fills in (doc, run) pairs that currently lack a flattened .json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS_DIR, loadCredentials, loadRibo, anthropicChat } from "./lib.mjs";

const valuesSchemaSource = readFileSync(join(import.meta.dirname, "run-experiment.mjs"), "utf8");
// reuse the exact schema by importing the module pieces via a tiny shim:
// simplest is to re-declare — the schema is defined in run-experiment.mjs but
// not exported. Import the module for its side effects is wrong (it runs the
// experiment), so re-declare the identical schema here.
const { core, ext, z } = await loadRibo();
const { enveloped } = core;
const { singleShotExtractor } = ext;

const valuesSchema = z.object({
  rooms: z.array(
    z.object({
      name: z.string().nullable(),
      area: z.number().nullable(),
      heatingLoad: z.number().nullable(),
      coolingLoad: z.number().nullable(),
      heatingAvf: z.number().nullable(),
      coolingAvf: z.number().nullable(),
    }),
  ),
  house: z.object({
    totalHeatingLoad: z.number().nullable(),
    totalCoolingLoad: z.number().nullable(),
    totalArea: z.number().nullable(),
    heatingEquipmentManufacturer: z.string().nullable(),
    heatingEquipmentModel: z.string().nullable(),
    preparerName: z.string().nullable(),
    hvacSystemType: z.string().nullable(),
  }),
});
const extractionSchema = enveloped(valuesSchema, { provenance: {} });

// Same RULES text as run-experiment.mjs — extracted to a shared import would be
// better; kept duplicated and marked to avoid drift in a spike.
const m = valuesSchemaSource.match(/const RULES = `([\s\S]*?)`;\n\nconst NATIVE_PROMPT/);
if (!m) throw new Error("could not lift RULES from run-experiment.mjs");
const RULES = m[1];

const { apiKey, anthropicBaseUrl } = loadCredentials();
const chat = anthropicChat({ apiKey, baseUrl: anthropicBaseUrl });
const extractor = singleShotExtractor({
  target: { name: "manual-j", extractionSchema, instructions: RULES },
  chat,
  model: "claude-haiku-4-5",
  maxTokens: 16000,
});

const DOCS = ["wrightsoft", "coolcalc"];
for (const doc of DOCS) {
  for (let run = 0; run < 5; run++) {
    const out = join(RESULTS_DIR, "flattened", `${doc}-run${run}.json`);
    if (existsSync(out)) continue;
    const markdown = readFileSync(join(RESULTS_DIR, "ocr", `${doc}-run${run}.md`), "utf8");
    process.stdout.write(`[retry] ${doc} run${run} ... `);
    try {
      const started = performance.now();
      const result = await extractor.extract(markdown);
      const extractMs = Math.round(performance.now() - started);
      writeFileSync(out, JSON.stringify(result.fields, null, 2));
      writeFileSync(
        join(RESULTS_DIR, "flattened", `${doc}-run${run}.meta.json`),
        JSON.stringify({ extractMs, usage: result.usage ?? null, retried: true }, null, 2),
      );
      console.log(`${extractMs}ms`);
    } catch (err) {
      console.log(`FAIL AGAIN: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }
}
