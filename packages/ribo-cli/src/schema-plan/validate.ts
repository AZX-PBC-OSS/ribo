import { z } from "zod";

import type { SchemaPlanPiece } from "@azx/ribo-core";

/** The model-owned portion of a plan reply. Code never accepts artifact metadata from it. */
export interface SchemaPlanReply {
  readonly pieces: readonly SchemaPlanPiece[];
}

export type SchemaPlanReplyValidation =
  | { readonly success: true; readonly reply: SchemaPlanReply }
  | { readonly success: false; readonly problems: readonly string[] };

export interface ValidateSchemaPlanReplyOptions {
  /** The only paths this reply may place, and the paths it must place exactly once. */
  readonly expectedPaths: readonly string[];
  /** Surviving pieces an update may target. Their metadata is locked. */
  readonly existingPieces?: readonly SchemaPlanPiece[];
}

const replySchema = z.strictObject({
  pieces: z
    .array(
      z.strictObject({
        name: z.string().min(1, "must not be empty"),
        description: z.string().min(1, "must not be empty"),
        key: z.string().min(1, "must not be empty"),
        paths: z.array(z.string().min(1)).min(1, "must not be empty"),
      }),
    )
    .min(1),
});

const issueText = (issue: z.ZodIssue): string => {
  const at = issue.path.length === 0 ? "response" : issue.path.join(".");
  return `${at}: ${issue.message}`;
};

function semanticProblems(
  reply: SchemaPlanReply,
  options: ValidateSchemaPlanReplyOptions,
): string[] {
  const problems: string[] = [];
  const expected = new Set(options.expectedPaths);
  const expectedKeys = new Set(options.expectedPaths.map((path) => path.split(".")[0]));
  const existing = new Map(options.existingPieces?.map((piece) => [piece.name, piece]));
  const seenPaths = new Set<string>();
  const duplicatePaths = new Set<string>();
  const seenNames = new Set<string>();

  for (const [pieceIndex, piece] of reply.pieces.entries()) {
    if (seenNames.has(piece.name)) {
      problems.push(`pieces.${pieceIndex}.name: duplicate piece name "${piece.name}"`);
    }
    seenNames.add(piece.name);

    if (!expectedKeys.has(piece.key)) {
      problems.push(`pieces.${pieceIndex}.key: unknown top-level key "${piece.key}"`);
    }

    const target = existing.get(piece.name);
    if (target !== undefined) {
      if (piece.key !== target.key) {
        problems.push(
          `pieces.${pieceIndex}.key: existing piece "${piece.name}" has top-level key ` +
            `"${target.key}", not "${piece.key}"`,
        );
      }
      if (piece.description !== target.description) {
        problems.push(
          `pieces.${pieceIndex}.description: existing piece "${piece.name}" has locked ` +
            "description metadata",
        );
      }
    }

    for (const [pathIndex, path] of piece.paths.entries()) {
      const at = `pieces.${pieceIndex}.paths.${pathIndex}`;
      if (!expected.has(path)) {
        problems.push(`${at}: unknown path "${path}" in this request's closed path vocabulary`);
      }
      if (seenPaths.has(path)) duplicatePaths.add(path);
      seenPaths.add(path);
      if (path.split(".")[0] !== piece.key) {
        problems.push(
          `${at}: cross-key path "${path}" cannot belong to the piece's top-level key ` +
            `"${piece.key}"`,
        );
      }
    }
  }

  for (const path of [...duplicatePaths].sort()) {
    problems.push(`pieces: duplicate path "${path}"`);
  }
  for (const path of options.expectedPaths) {
    if (!seenPaths.has(path)) problems.push(`pieces: omitted path "${path}"`);
  }
  return problems;
}

/** Parse and fully validate one reply without dropping, completing or reordering any model data. */
export function validateSchemaPlanReply(
  content: string,
  options: ValidateSchemaPlanReplyOptions,
): SchemaPlanReplyValidation {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { success: false, problems: [`response: malformed JSON (${detail})`] };
  }

  const parsed = replySchema.safeParse(value);
  if (!parsed.success) {
    return { success: false, problems: parsed.error.issues.map(issueText) };
  }

  const reply: SchemaPlanReply = parsed.data;
  const problems = semanticProblems(reply, options);
  if (problems.length > 0) return { success: false, problems };
  return { success: true, reply };
}
