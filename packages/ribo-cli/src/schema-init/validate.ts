/**
 * @file Proposal parsing and source-grounded semantic validation. Evidence is
 * matched per input, never against the joined sample text: a text or
 * transcript input is exact, only a transcribed document receives the narrow
 * layout fold, and a quote is accepted when ONE input matches it under that
 * input's own rule — so acceptance never depends on input order, and a
 * non-matching input can never reject a quote another input matches. A
 * capture marker line and any quote spanning two inputs exist only in the
 * joined text, never inside one input, so neither can ever match.
 */
import type { z } from "zod";

import type { CorpusInputKind } from "../corpus/case.js";
import { OperatorError } from "../operator/error.js";
import type { SchemaInitSample } from "./samples.js";
import { dropOptionalNulls, schemaInitProposalSchema } from "./proposal.js";
import type {
  SchemaInitEvidence,
  SchemaInitLeafDeclaration,
  SchemaInitNodeDeclaration,
  SchemaInitObjectDeclaration,
  SchemaInitProposal,
} from "./proposal.js";

export type SchemaInitProposalValidation =
  | { readonly success: true; readonly proposal: SchemaInitProposal }
  | { readonly success: false; readonly problems: readonly string[] };

const issueText = (issue: z.ZodIssue): string => {
  const at = issue.path.length === 0 ? "response" : issue.path.join(".");
  return `${at}: ${issue.message}`;
};

/** Index caller input so an evidence source can never resolve ambiguously. */
export function indexSchemaInitSamples(
  samples: readonly SchemaInitSample[],
): ReadonlyMap<string, SchemaInitSample> {
  if (samples.length === 0) {
    throw new OperatorError("schema init needs at least one sample, loaded with a unique name");
  }
  const indexed = new Map<string, SchemaInitSample>();
  for (const sample of samples) {
    if (sample.name.trim().length === 0) {
      throw new OperatorError("schema init sample names must not be empty");
    }
    if (indexed.has(sample.name)) {
      throw new OperatorError(
        `schema init sample name "${sample.name}" is duplicated; evidence sources must resolve ` +
          "to exactly one sample (fix: rename the inputs)",
      );
    }
    if (sample.text.trim().length === 0) {
      throw new OperatorError(`schema init sample "${sample.name}" has no text to ground evidence`);
    }
    indexed.set(sample.name, sample);
  }
  return indexed;
}

/**
 * The document-only comparison fold. It changes neither stored string and
 * deliberately does not fold case, punctuation, numbers, units or words.
 */
export function normalizeSchemaInitDocumentText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .normalize("NFKC")
    .replace(/(?<=\p{L})-[\t ]*\n[\t ]*(?=\p{L})/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * The minimal shape the quote matchers read — an input's kind and its exact
 * text, beside whatever else the caller's richer input type carries. A
 * proposal's evidence is verified against this shape, never against a joined
 * text, so schema init and the corpus proposer share one matching rule.
 */
export interface QuoteMatchingInput {
  readonly kind: CorpusInputKind;
  readonly text: string;
}

/**
 * Does one input's own rule accept the quote? Text and transcript inputs
 * match exactly; only a document input receives the layout fold.
 */
export function inputMatchesQuote(quote: string, input: QuoteMatchingInput): boolean {
  return input.kind === "document"
    ? normalizeSchemaInitDocumentText(input.text).includes(normalizeSchemaInitDocumentText(quote))
    : input.text.includes(quote);
}

/**
 * The inputs whose own rule accepts the quote, in the order given — so the
 * first match is the earliest declared input, which is the one an evidence
 * link records. Empty when no input matches.
 */
export function matchingQuoteInputs<I extends QuoteMatchingInput>(
  quote: string,
  inputs: readonly I[],
): readonly I[] {
  return inputs.filter((input) => inputMatchesQuote(quote, input));
}

/** The inputs of one sample whose own rule accepts the quote. */
const matchingInputs = (
  evidence: SchemaInitEvidence,
  sample: SchemaInitSample,
): readonly QuoteMatchingInput[] => matchingQuoteInputs(evidence.quote, sample.inputs);

/**
 * An enum member's quote must contain the member itself, ignoring letter case
 * (a vocabulary is often normalized) and — when the input that matched the
 * quote is a document — the layout fold. A text input's fold is never
 * borrowed: each matched input answers under its own rule.
 */
function quoteNamesValue(
  value: string,
  quote: string,
  matched: readonly QuoteMatchingInput[],
): boolean {
  const fold = (input: QuoteMatchingInput | undefined, text: string): string =>
    (input?.kind === "document" ? normalizeSchemaInitDocumentText(text) : text).toLowerCase();
  // An unmatched quote is already reported; judge the member by its quote alone.
  if (matched.length === 0) return fold(undefined, quote).includes(fold(undefined, value));
  return matched.some((input) => fold(input, quote).includes(fold(input, value)));
}

function validateEvidence(
  evidence: SchemaInitEvidence,
  at: string,
  samples: ReadonlyMap<string, SchemaInitSample>,
  problems: string[],
): void {
  const sample = samples.get(evidence.source);
  if (sample === undefined) {
    problems.push(
      `${at}.source: unknown source "${evidence.source}"; evidence must name one loaded sample`,
    );
    return;
  }
  if (matchingInputs(evidence, sample).length === 0) {
    problems.push(
      `${at}.quote: evidence quote ${JSON.stringify(evidence.quote)} was not found in any ` +
        `input of source "${evidence.source}" — text and transcript inputs match exactly, ` +
        "document inputs under the layout fold, a quote never spans inputs, and no other " +
        "source is searched",
    );
  }
}

function validateLeaf(
  leaf: SchemaInitLeafDeclaration,
  path: string,
  samples: ReadonlyMap<string, SchemaInitSample>,
  problems: string[],
): void {
  validateEvidence(leaf.evidence, `${path}.evidence`, samples, problems);
  if (leaf.enum === undefined) return;
  if (leaf.kind !== "string") {
    problems.push(`${path}.enum: enums are supported only on string leaves`);
  }
  const values = new Set<string>();
  for (const [index, member] of leaf.enum.entries()) {
    if (values.has(member.value)) {
      problems.push(`${path}.enum.${index}: duplicate enum value "${member.value}"`);
    }
    values.add(member.value);
    validateEvidence(member.evidence, `${path}.enum.${index}.evidence`, samples, problems);
    const memberSample = samples.get(member.evidence.source);
    if (
      memberSample !== undefined &&
      !quoteNamesValue(
        member.value,
        member.evidence.quote,
        matchingInputs(member.evidence, memberSample),
      )
    ) {
      problems.push(
        `${path}.enum.${index}.value: enum value ${JSON.stringify(member.value)} does not appear ` +
          `in its own evidence quote ${JSON.stringify(member.evidence.quote)}; a member must be ` +
          "quoted, not inferred",
      );
    }
  }
}

function validateNode(
  node: SchemaInitNodeDeclaration,
  path: string,
  seenPaths: Set<string>,
  samples: ReadonlyMap<string, SchemaInitSample>,
  problems: string[],
): void {
  if (seenPaths.has(path)) problems.push(`${path}: duplicate path "${path}"`);
  seenPaths.add(path);
  if (node.kind === "object") {
    validateObject(node, path, seenPaths, samples, problems);
    return;
  }
  if (node.kind === "collection") {
    validateObject(node.items, path, seenPaths, samples, problems);
    return;
  }
  validateLeaf(node, path, samples, problems);
}

function validateObject(
  object: SchemaInitObjectDeclaration,
  parentPath: string,
  seenPaths: Set<string>,
  samples: ReadonlyMap<string, SchemaInitSample>,
  problems: string[],
): void {
  for (const property of object.properties) {
    const path = parentPath.length === 0 ? property.name : `${parentPath}.${property.name}`;
    validateNode(property.node, path, seenPaths, samples, problems);
  }
}

/** Parse and validate one reply without repairing, dropping or rewriting any declaration. */
export function validateSchemaInitProposal(
  content: string,
  samples: readonly SchemaInitSample[],
): SchemaInitProposalValidation {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { success: false, problems: [`response: malformed JSON (${detail})`] };
  }

  const parsed = schemaInitProposalSchema.safeParse(dropOptionalNulls(value));
  if (!parsed.success) {
    return { success: false, problems: parsed.error.issues.map(issueText) };
  }

  const problems: string[] = [];
  validateObject(parsed.data.root, "", new Set(), indexSchemaInitSamples(samples), problems);
  if (problems.length > 0) return { success: false, problems };
  return { success: true, proposal: parsed.data };
}
