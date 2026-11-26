import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { schemaPlanSchema } from "@azx/ribo-core";
import type { SchemaPlan } from "@azx/ribo-core";

import { OperatorError } from "../operator/error.js";
import { writeOperatorOutput } from "../operator/output.js";
import type { OperatorOutputResult, WriteOperatorOutputOptions } from "../operator/output.js";

export interface ReadSchemaPlanInputsOptions {
  readonly cwd?: string;
  readonly readFileImpl?: (path: string) => Promise<string>;
}

export interface SchemaPlanInputs {
  readonly document: unknown;
  readonly existingPlan?: SchemaPlan;
}

const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function readJson(
  path: string,
  label: string,
  options: ReadSchemaPlanInputsOptions,
): Promise<unknown> {
  const resolved = resolve(options.cwd ?? process.cwd(), path);
  const read = options.readFileImpl ?? ((file: string) => readFile(file, "utf8"));
  let raw: string;
  try {
    raw = await read(resolved);
  } catch (error) {
    throw new OperatorError(
      `the ${label} "${resolved}" could not be read: ${faultMessage(error)} ` +
        `(fix: pass a readable ${label} file)`,
    );
  }
  if (raw.trim().length === 0) {
    throw new OperatorError(`the ${label} "${resolved}" is empty (fix: supply a JSON document)`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new OperatorError(
      `the ${label} "${resolved}" is not valid JSON: ${faultMessage(error)} ` +
        "(fix: repair the JSON input)",
    );
  }
}

/** Refuse the destructive alias before any backend preparation or model call. */
export function assertSchemaPlanOutputIsNotUpdateInput(
  update: string | undefined,
  out: string | undefined,
  cwd = process.cwd(),
): void {
  if (update === undefined || out === undefined) return;
  if (resolve(cwd, update) !== resolve(cwd, out)) return;
  throw new OperatorError(
    `the update input and output are the same file "${resolve(cwd, out)}" — input is never used ` +
      "as output (fix: choose a distinct new --out path, or omit --out to write the artifact to " +
      "stdout)",
  );
}

/** Read the schema and optional stored plan, parsing the plan at the trust boundary. */
export async function readSchemaPlanInputs(
  schemaPath: string,
  updatePath?: string,
  options: ReadSchemaPlanInputsOptions = {},
): Promise<SchemaPlanInputs> {
  const document = await readJson(schemaPath, "schema", options);
  if (updatePath === undefined) return { document };
  const value = await readJson(updatePath, "schema plan", options);
  const parsed = schemaPlanSchema.safeParse(value);
  if (!parsed.success) {
    const path = resolve(options.cwd ?? process.cwd(), updatePath);
    throw new OperatorError(
      `the schema plan "${path}" is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`)
        .join("; ")} (fix: pass a complete schema-plan artifact)`,
    );
  }
  return { document, existingPlan: parsed.data };
}

/** The complete artifact, with exactly one final newline. */
export function serializeSchemaPlan(plan: SchemaPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export interface WriteSchemaPlanArtifactOptions extends WriteOperatorOutputOptions {
  readonly update?: string;
  readonly out?: string;
  readonly review?: string;
}

/** Serialize once and delegate all destination and stream discipline to the shared output port. */
export async function writeSchemaPlanArtifact(
  plan: SchemaPlan,
  options: WriteSchemaPlanArtifactOptions = {},
): Promise<OperatorOutputResult> {
  const common = {
    artifact: serializeSchemaPlan(plan),
    ...(options.out === undefined ? {} : { out: options.out }),
    ...(options.review === undefined ? {} : { review: options.review }),
  };
  return writeOperatorOutput(
    options.update === undefined
      ? { kind: "create", ...common }
      : { kind: "update", input: options.update, ...common },
    options,
  );
}
