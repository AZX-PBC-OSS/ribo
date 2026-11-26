/** Evidence-grounded schema drafting over named loaded samples. */
import type { ChatClient } from "@azx/ribo-core";

import { OperatorError } from "./operator/error.js";
import { initialSchemaInitPrompt, repairSchemaInitPrompt } from "./schema-init/prompt.js";
import type { SchemaInitProposal } from "./schema-init/proposal.js";
import { renderSchemaInitProposal } from "./schema-init/render.js";
import type { SchemaInitOpenApiObject } from "./schema-init/render.js";
import type { SchemaInitSample } from "./schema-init/samples.js";
import { indexSchemaInitSamples, validateSchemaInitProposal } from "./schema-init/validate.js";

export type { SchemaInitSample, SchemaInitSampleSource } from "./schema-init/samples.js";
export type {
  SchemaInitCollectionDeclaration,
  SchemaInitEnumMember,
  SchemaInitEvidence,
  SchemaInitLeafDeclaration,
  SchemaInitLeafKind,
  SchemaInitNodeDeclaration,
  SchemaInitObjectDeclaration,
  SchemaInitPropertyDeclaration,
  SchemaInitProposal,
} from "./schema-init/proposal.js";
export type {
  SchemaInitOpenApiCollection,
  SchemaInitOpenApiLeaf,
  SchemaInitOpenApiNode,
  SchemaInitOpenApiObject,
} from "./schema-init/render.js";

/** Configuration for {@link initSchema}; transport, model identity and time are injected. */
export interface InitSchemaOptions {
  /** The stub or prepared operator transport that authors declarations. */
  readonly chat: ChatClient;
  /** Model name sent on every initial and repair request and retained in the draft. */
  readonly model: string;
  /** Completion clock, read only after a valid proposal renders and walks successfully. */
  readonly clock?: () => Date;
}

/** Code-owned provenance for a successful draft; it is not accepted from the model. */
export interface SchemaInitProvenance {
  readonly model: string;
  readonly createdAt: string;
}

/** A reviewable draft: plain OpenAPI, the evidence-linked declarations and call provenance. */
export interface SchemaInitDraft {
  readonly document: SchemaInitOpenApiObject;
  readonly proposal: SchemaInitProposal;
  readonly provenance: SchemaInitProvenance;
}

const MAX_REPAIRS = 2;

/**
 * Draft a supported OpenAPI 3.0 object schema from named loaded samples.
 *
 * The model may emit only the fixed recursive declaration language: objects,
 * collections of objects, string/number/boolean leaves, descriptions, optional
 * leaves and evidenced string enums. Every leaf and enum member must quote its
 * one named source. Text and transcript matching is exact; document matching
 * uses only the deterministic layout fold. Samples and quotes are never
 * rewritten, and evidence never claims complete source coverage.
 *
 * Invalid replies receive bounded, named whole-response repairs. Exhaustion
 * throws `OperatorError` and returns no partial draft. Code
 * owns rendering, omits optional leaves from `required`, marks only those
 * leaves `nullable: true`, and proves every result through inspect conversion
 * and field-inventory walking before reading the injected clock.
 */
export async function initSchema(
  samples: readonly SchemaInitSample[],
  options: InitSchemaOptions,
): Promise<SchemaInitDraft> {
  indexSchemaInitSamples(samples);
  const base = initialSchemaInitPrompt(samples, options.model);
  let activeRequest = base;
  let lastProblems: readonly string[] = ["no response was validated"];

  for (let repair = 0; repair <= MAX_REPAIRS; repair++) {
    const completion = await options.chat.complete(activeRequest);
    const validated = validateSchemaInitProposal(completion.content, samples);
    if (validated.success) {
      const document = renderSchemaInitProposal(validated.proposal);
      const now = options.clock === undefined ? new Date() : options.clock();
      return {
        document,
        proposal: validated.proposal,
        provenance: { model: options.model, createdAt: now.toISOString() },
      };
    }
    lastProblems = validated.problems;
    if (repair < MAX_REPAIRS) {
      activeRequest = repairSchemaInitPrompt(
        base,
        completion.content,
        validated.problems,
        repair + 1,
      );
    }
  }

  throw new OperatorError(
    "schema initialization exhausted its named repairs; no draft was produced. " +
      `Last feedback: ${lastProblems.join("; ")}`,
  );
}
