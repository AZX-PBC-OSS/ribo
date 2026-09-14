/**
 * Smoke test: one Mistral OCR call on a small doc, plain markdown, then with a
 * tiny annotation schema. Prints shape stats only — no document content.
 */
import { loadCredentials, loadRibo, mistralOcr, CORPUS_DIR } from "./lib.mjs";
import { join } from "node:path";

const { apiKey, resourceOrigin } = loadCredentials();
const { core, z } = await loadRibo();

const pdf = join(CORPUS_DIR, "Quote 4 - Final.pdf");

// Call 1: plain OCR
const t0 = await mistralOcr({ apiKey, resourceOrigin, pdfPath: pdf });
console.log("plain OCR:", {
  markdownChars: t0.markdown.length,
  latencyMs: t0.latencyMs,
  usage: t0.usage,
});

// Call 2: OCR + tiny annotation, schema built through enveloped()
const valuesSchema = z.object({
  house: z.object({
    totalHeatingLoad: z.number().nullable(),
    totalCoolingLoad: z.number().nullable(),
  }),
});
const extractionSchema = core.enveloped(valuesSchema, { provenance: {} });
// Convert zod -> json schema using zod v4's toJSONSchema
const jsonSchema = z.toJSONSchema ? z.toJSONSchema(extractionSchema, { target: "draft-7" }) : null;
if (!jsonSchema) throw new Error("z.toJSONSchema unavailable — need schema conversion plan B");
delete jsonSchema.$schema;

const t1 = await mistralOcr({
  apiKey,
  resourceOrigin,
  pdfPath: pdf,
  annotation: {
    name: "quote_extract",
    schema: jsonSchema,
    prompt:
      "Extract the fields defined by the schema from this document. Use null when not stated.",
  },
});
console.log("annotated OCR:", {
  markdownChars: t1.markdown.length,
  latencyMs: t1.latencyMs,
  usage: t1.usage,
  annotation: t1.annotation === null ? null : "(present)",
  annotationJson: JSON.stringify(t1.annotation)?.slice(0, 400),
});
console.log("raw jsonSchema sent:", JSON.stringify(jsonSchema).slice(0, 500));
