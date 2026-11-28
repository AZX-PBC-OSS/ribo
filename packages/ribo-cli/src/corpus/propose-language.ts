/**
 * @file The model-owned proposal language for a case's unanswered leaves.
 * This is deliberately not JSON Schema, and deliberately flat: the reply is a
 * list of scalar items and a list of collections, whatever the corpus schema
 * looks like, so the response format's depth and size are constant and no
 * provider's structured-output limit ever depends on the user's schema. The
 * schema document travels in the prompt instead.
 *
 * Code owns the paths, the grounding and the pivot to expectation entries;
 * the model only names paths it was given and quotes it saw. The reply never
 * names an input — the input is derived, by code, from where the quote
 * matches.
 */
import { z } from "zod";

import { dropNullMembers, strictWireSchema } from "../schema-init/proposal.js";

/** A proposed scalar value: a string, a finite number, or a boolean. */
export type ProposeValue = string | number | boolean;

const nonEmpty = (label: string) =>
  z
    .string()
    .min(1, `${label} must not be empty`)
    .refine((value) => value.trim().length > 0, `${label} must not be whitespace only`);

const proposeValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * One scalar proposal item: a value with its quote, or an explicit absence.
 *
 * The variant is judged by code, not by the wire schema — a strict transport
 * cannot express a union here, so the members are listed all-optional (as
 * null on the wire) and exactly one variant must be present. A value item
 * carries `value` plus a non-empty `quote`; an absence carries `absent: true`
 * and nothing else.
 */
export const proposeItemSchema = z.strictObject({
  path: nonEmpty("leaf path"),
  value: proposeValueSchema.nullable().optional(),
  quote: z.string().nullable().optional(),
  absent: z.boolean().nullable().optional(),
});

/** One scalar proposal item, as parsed. */
export type ProposeItem = z.infer<typeof proposeItemSchema>;

/**
 * One cell of a collection row: a value with its quote, named by the leaf's
 * full dotted path. One quote per CELL, never per row — a row in the text
 * spans several lines, and a long quote fails exact matching.
 */
export const proposeCellSchema = z.strictObject({
  leaf: nonEmpty("cell leaf path"),
  value: proposeValueSchema.nullable().optional(),
  quote: z.string().nullable().optional(),
});

/** One cell of a collection row, as parsed. */
export type ProposeCell = z.infer<typeof proposeCellSchema>;

/** One row of a collection, in document order. */
export const proposeRowSchema = z.strictObject({ cells: z.array(proposeCellSchema) });

/** One row of a collection, as parsed. */
export type ProposeRow = z.infer<typeof proposeRowSchema>;

/**
 * One collection's proposal: the collection's dotted path — the leaf's
 * nearest array ancestor — and its rows in document order. A row omits a
 * cell for a leaf it has no value for; a leaf missing from every row, or an
 * empty rows list, is a proposed absence.
 */
export const proposeCollectionSchema = z.strictObject({
  path: nonEmpty("collection path"),
  rows: z.array(proposeRowSchema),
});

/** One collection's proposal, as parsed. */
export type ProposeCollection = z.infer<typeof proposeCollectionSchema>;

/** The model's whole proposal reply. */
export const proposeReplySchema = z.strictObject({
  items: z.array(proposeItemSchema),
  collections: z.array(proposeCollectionSchema),
});

/** The model's whole proposal reply, as parsed. */
export type ProposeReply = z.infer<typeof proposeReplySchema>;

/** The members of an item or cell the strict wire form may deliver as null. */
const PROPOSE_NULL_MEMBERS = new Set(["value", "quote", "absent"]);

/** Strip the null members a strict transport sends so the parser sees absence. */
export function dropProposeReplyNulls(value: unknown): unknown {
  return dropNullMembers(value, PROPOSE_NULL_MEMBERS);
}

/**
 * The matching strict structured-output contract sent to chat transports:
 * every property required, the variant members nullable, derived from the
 * same transform the schema-init declaration language uses.
 */
export const proposeReplyJsonSchema = strictWireSchema(
  z.toJSONSchema(proposeReplySchema, { target: "draft-2020-12" }),
) as Record<string, unknown>;
