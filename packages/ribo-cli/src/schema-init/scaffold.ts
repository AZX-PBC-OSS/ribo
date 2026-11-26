/**
 * @file Deterministic corpus scaffolding over the exact drafted schema bytes
 * and the samples' original inputs. No answer or prompt content is inferred.
 */
import { isAbsolute } from "node:path";

import { CorpusCaseSchema } from "../corpus/case.js";
import { CorpusManifestSchema } from "../corpus/manifest.js";
import type { CorpusProvenance } from "../corpus/manifest.js";
import { convertDocument } from "../inspect/convert.js";
import { walkFieldInventory } from "../inspect/field-inventory.js";
import { OperatorError } from "../operator/error.js";
import { writeOperatorDirectoryOutput } from "../operator/output.js";
import type {
  OperatorDirectoryEntry,
  OperatorDirectoryOutputResult,
  WriteOperatorDirectoryOutputOptions,
} from "../operator/output.js";
import type { SchemaInitOpenApiObject } from "./render.js";
import type { SchemaInitSample } from "./samples.js";
import { indexSchemaInitSamples } from "./validate.js";

/** The operator's explicit corpus identity; drafting never chooses either value. */
export interface SchemaInitCorpusMetadata {
  readonly name: string;
  readonly provenance: CorpusProvenance;
}

const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Serialize once, then prove the serialized document still walks through inspect. */
export function serializeSchemaInitDocument(document: SchemaInitOpenApiObject): string {
  const artifact = `${JSON.stringify(document, null, 2)}\n`;
  try {
    const reparsed = JSON.parse(artifact) as unknown;
    walkFieldInventory(convertDocument(reparsed));
  } catch (error) {
    throw new OperatorError(
      `schema init's final serialized output failed validation: ${faultMessage(error)} ` +
        "(no schema or corpus destination was written)",
    );
  }
  return artifact;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function safePart(value: string, label: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    isAbsolute(value)
  ) {
    throw new OperatorError(
      `the schema-init ${label} "${value}" cannot be used as a corpus file name ` +
        "(fix: rename the input so it is one safe path component)",
    );
  }
  return value;
}

function caseEntries(sample: SchemaInitSample): readonly OperatorDirectoryEntry[] {
  const id = safePart(sample.name, "sample name");
  const file = safePart(sample.source.file, `sample "${id}" input file`);
  const capture = sample.source.capture;
  if (sample.kind === "document" && capture === undefined) {
    throw new OperatorError(
      `the schema-init document sample "${id}" has no capture metadata; scaffolding never invents it`,
    );
  }
  const input = {
    file,
    kind: sample.kind,
    ...(sample.kind === "document"
      ? {
          capture: {
            capturedAt: capture!.capturedAt,
            pageCount: capture!.pageCount,
          },
        }
      : {}),
  };
  const caseFile = CorpusCaseSchema.parse({ id, inputs: [input], expected: {} });
  return [
    { path: `${id}/case.json`, contents: json(caseFile) },
    { path: `${id}/${file}`, contents: sample.source.bytes },
  ];
}

/** Build the complete staged tree from explicit metadata and loaded source records. */
export function schemaInitCorpusEntries(
  artifact: string,
  samples: readonly SchemaInitSample[],
  metadata: SchemaInitCorpusMetadata,
): readonly OperatorDirectoryEntry[] {
  indexSchemaInitSamples(samples);
  if (metadata.name.trim().length === 0) {
    throw new OperatorError("the corpus name must not be empty (fix: pass --corpus-name)");
  }
  const manifest = CorpusManifestSchema.parse({
    name: metadata.name,
    schema: "schema.json",
    provenance: metadata.provenance,
    prompt: { instructions: "" },
  });
  const ordered = [...samples].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  // Case folders that differ only by letter case collide on case-insensitive filesystems.
  const folded = new Map<string, string>();
  for (const sample of ordered) {
    const key = sample.name.toLowerCase();
    const other = folded.get(key);
    if (other !== undefined) {
      throw new OperatorError(
        `the schema-init samples "${other}" and "${sample.name}" differ only by letter case and ` +
          "would collide as corpus case folders (fix: rename one of the inputs)",
      );
    }
    folded.set(key, sample.name);
  }
  return [
    { path: "schema.json", contents: artifact },
    { path: "manifest.json", contents: json(manifest) },
    ...ordered.flatMap(caseEntries),
  ];
}

/** Directory output dependencies plus diagnostics emitted after publication. */
export interface WriteSchemaInitCorpusOptions extends WriteOperatorDirectoryOutputOptions {
  readonly review?: string;
}

/** Publish a complete corpus through the shared all-or-nothing directory port. */
export async function writeSchemaInitCorpus(
  out: string,
  artifact: string,
  samples: readonly SchemaInitSample[],
  metadata: SchemaInitCorpusMetadata,
  options: WriteSchemaInitCorpusOptions = {},
): Promise<OperatorDirectoryOutputResult> {
  return writeOperatorDirectoryOutput(
    {
      out,
      entries: schemaInitCorpusEntries(artifact, samples, metadata),
      ...(options.review === undefined ? {} : { review: options.review }),
    },
    options,
  );
}
