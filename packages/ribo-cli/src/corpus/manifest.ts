/**
 * @file The corpus manifest: the corpus's own declaration of what it is.
 *
 * The manifest is hand-authored, so it is parsed with zod at the boundary and
 * never cast (AGENTS.md §4). Unknown keys are refused rather than ignored: a
 * misspelled field in a corpus is an authoring mistake, and a manifest that
 * silently dropped it would measure something other than what it declares.
 *
 * The schema reference is the corpus's ONLY schema source (amendment 4): there
 * is no `--schema` flag, so two corpora over different schemas are different
 * corpora rather than one corpus under two flags.
 */
import type { FieldDescriptionsMode } from "@azx/ribo-core";
import { z } from "zod";

/**
 * The field-descriptions mode, spelled as core's own pair.
 *
 * The parity check below ties the corpus format to core's option: if core
 * gains a third mode, this assignment fails to compile until the format is
 * updated deliberately, rather than the corpus silently dropping the new mode.
 */
const fieldDescriptionsModeSchema = z.enum(["schema", "prompt"]);

type ModeParity =
  z.infer<typeof fieldDescriptionsModeSchema> extends FieldDescriptionsMode
    ? FieldDescriptionsMode extends z.infer<typeof fieldDescriptionsModeSchema>
      ? true
      : never
    : never;

const _modeParity: ModeParity = true;

/**
 * One few-shot example: a transcript and the fields it should yield.
 *
 * Each example becomes one user/assistant turn pair in the prompt.
 * @category Eval
 */
export const CorpusExampleSchema = z.strictObject({
  /** The example's input text, verbatim. */
  transcript: z.string(),
  /** The fields the example demonstrates, as the nested JSON object the assistant turn carries. */
  fields: z.record(z.string(), z.unknown()),
});

/**
 * The run's prompt inputs — the objects core's prompt builders assemble from,
 * and nothing else.
 * @category Eval
 */
export const CorpusPromptInputsSchema = z.strictObject({
  /** The system instructions, passed verbatim to the extraction target. */
  instructions: z.string(),
  /** The few-shot examples, each one transcript with the fields it yields. */
  examples: z.array(CorpusExampleSchema).optional(),
  /** Where the schema's field descriptions travel: `"schema"` or `"prompt"`. */
  fieldDescriptions: fieldDescriptionsModeSchema.optional(),
  /**
   * Per-group instructions, keyed by group key. An entry replaces the main
   * instructions for that group's calls; a group with no entry uses the main
   * instructions.
   */
  groupInstructions: z.record(z.string(), z.string()).optional(),
});

/**
 * The corpus manifest — the corpus's declaration of its name, its schema
 * reference, its provenance and its prompt inputs.
 * @category Eval
 */
export const CorpusManifestSchema = z.strictObject({
  /** The corpus's name; it names the corpus in reports and records. */
  name: z.string().min(1),
  /** A path, relative to the corpus root, to a JSON Schema document. */
  schema: z.string().min(1),
  /** The corpus's declared provenance: `"real"` or `"synthetic"`. */
  provenance: z.enum(["real", "synthetic"]),
  /** The run's prompt inputs. */
  prompt: CorpusPromptInputsSchema,
  /** Free text for a human reader; nothing reads it. */
  description: z.string().optional(),
});

/**
 * One few-shot example, as the manifest declares it.
 * @category Eval
 */
export type CorpusExample = z.infer<typeof CorpusExampleSchema>;

/**
 * The run's prompt inputs, as the manifest declares them.
 * @category Eval
 */
export type CorpusPromptInputs = z.infer<typeof CorpusPromptInputsSchema>;

/**
 * The corpus manifest, as the manifest file declares it.
 * @category Eval
 */
export type CorpusManifest = z.infer<typeof CorpusManifestSchema>;

/**
 * The corpus's declared provenance — `"real"` or `"synthetic"`.
 * @category Eval
 */
export type CorpusProvenance = CorpusManifest["provenance"];
