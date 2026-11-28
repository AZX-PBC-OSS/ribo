/**
 * @file The guarded case writer: the one module that edits an existing
 * case.json, and the limits it enforces (R9; ADR 0049's D7).
 *
 * Authoring commands never write their input (`operator/output.ts`), but
 * propose and review must write `case.json` in place — a copy-out form would
 * duplicate every PDF per run and leave the reviewer to merge JSON by hand.
 * That departure is acceptable only because this module holds the rule: every
 * write goes through here, and here a write changes **only** `expected`.
 *
 * The limits, checked on every call:
 *
 * - the file is read raw, edited, and the result must re-parse as a case
 *   (`CorpusCaseSchema`) before anything reaches the disk — an edit that
 *   would make the case invalid is refused with the file untouched;
 * - every member other than `expected` survives with its value and key
 *   order, because the edited raw document is re-serialised whole and never
 *   rebuilt field by field;
 * - in add-only mode the edit may add keys and nothing else: an edit that
 *   changes or drops an existing entry is refused (R9 — propose never
 *   modifies or removes an existing entry or default);
 * - publication is a temp sibling then a rename, as `eval/record-store.ts`
 *   does, so an interrupted write never leaves a half-written case — and a
 *   failed publish removes the temp and leaves the original bytes intact;
 * - the module makes no model call, reads no schema document, and takes no
 *   clock: the caller supplies the entries, this file supplies the guard.
 *
 * The filesystem is injectable so the fault path is testable without
 * arranging real permission failures.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import { CorpusCaseSchema } from "./case.js";
import { CorpusError } from "./error.js";
import { describeIssues } from "./issues.js";

/**
 * The filesystem operations the writer uses, narrowed to exactly what a
 * write needs so a fault test can fake it in a Map.
 * @category Eval
 */
export interface CaseWriteFs {
  /** Read the case file's text. */
  readonly readFile: (file: string) => string;
  /** Write a file's text (the temp sibling). */
  readonly writeFile: (file: string, data: string) => void;
  /** Publish the temp sibling over the case file. */
  readonly rename: (from: string, to: string) => void;
  /** Remove the temp sibling after a failed publish. */
  readonly unlink: (file: string) => void;
}

/**
 * The real filesystem, as a {@link CaseWriteFs}.
 * @category Eval
 */
export const nodeCaseWriteFs: CaseWriteFs = {
  readFile: (file) => readFileSync(file, "utf8"),
  writeFile: (file, data) => writeFileSync(file, data, "utf8"),
  rename: (from, to) => renameSync(from, to),
  unlink: (file) => unlinkSync(file),
};

/**
 * The edit a caller applies to the case's expected map. It receives the raw
 * (untransformed) map as parsed from the file and returns the complete new
 * one: existing entries pass through untouched, new keys follow in the
 * caller's own order.
 * @category Eval
 */
export type ExpectedEdit = (expected: Readonly<Record<string, unknown>>) => Record<string, unknown>;

/**
 * Options for {@link writeCaseExpected}.
 * @category Eval
 */
export interface CaseWriteOptions {
  /**
   * Add-only mode: the edit may add keys and nothing else. An edit that
   * changes or drops an existing entry is refused — propose never modifies
   * or removes an existing entry or default (R9).
   */
  readonly addOnly?: boolean;
  /** The filesystem to write through; defaults to the real one. */
  readonly fs?: CaseWriteFs;
}

/** The message of a thrown fault — a non-Error sentinel must not read "undefined". */
const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Is this value a plain JSON object (not an array, not null)? */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Refuse an add-only edit that changed or dropped an existing entry. */
const checkAddOnly = (
  caseFile: string,
  original: Readonly<Record<string, unknown>>,
  edited: Readonly<Record<string, unknown>>,
): void => {
  for (const [leaf, entry] of Object.entries(original)) {
    if (!(leaf in edited)) {
      throw new CorpusError(
        `the add-only write to the corpus case file "${caseFile}" would drop the existing ` +
          `entry for leaf "${leaf}" — a proposal never removes an existing entry (fix: add ` +
          `only new leaves, or edit the case by hand)`,
      );
    }
    // Both sides came out of one JSON.parse or are entries the caller built
    // for this write, so serialised form is a faithful equality check — and
    // it refuses even a key-order-only rewrite of an entry, which an
    // "unchanged" edit has no reason to make.
    if (JSON.stringify(entry) !== JSON.stringify(edited[leaf])) {
      throw new CorpusError(
        `the add-only write to the corpus case file "${caseFile}" would change the existing ` +
          `entry for leaf "${leaf}" — a proposal never modifies an existing entry (fix: add ` +
          `only new leaves, or edit the case by hand)`,
      );
    }
  }
};

/**
 * Write a case file's `expected` map, and nothing else, in place.
 *
 * The file is read raw, the edit is applied, the result must re-parse as a
 * case, and publication is a temp sibling then a rename. Every member other
 * than `expected` survives with its value and key order, and a file already
 * in the two-space trailing-newline serialisation the schema-init scaffold
 * writes is byte-identical outside `expected` after the write.
 *
 * @param caseFile - The case.json to edit.
 * @param edit - The caller-supplied edit over the raw expected map.
 * @param options - Add-only mode and the injected filesystem.
 * @throws {@link CorpusError} when the file cannot be read or parsed, when
 * the edit would make the case invalid, when add-only mode catches a changed
 * or dropped entry, or when the publish fails — with the original file left
 * intact and no temp file left behind.
 * @category Eval
 */
export function writeCaseExpected(
  caseFile: string,
  edit: ExpectedEdit,
  options: CaseWriteOptions = {},
): void {
  const io = options.fs ?? nodeCaseWriteFs;
  let text: string;
  try {
    text = io.readFile(caseFile);
  } catch (error) {
    throw new CorpusError(
      `the corpus case file "${caseFile}" could not be read: ${faultMessage(error)} ` +
        "(fix: pass the path of an existing case.json)",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CorpusError(
      `the corpus case file "${caseFile}" is not valid JSON: ${faultMessage(error)} ` +
        "(fix: repair the file before proposing into it)",
    );
  }
  if (!isPlainObject(raw)) {
    throw new CorpusError(
      `the corpus case file "${caseFile}" is not a JSON object (fix: write the case as an ` +
        "object with id, inputs, expected and defaults members)",
    );
  }
  const original: Readonly<Record<string, unknown>> = isPlainObject(raw.expected)
    ? raw.expected
    : {};
  const edited = edit(original);
  if (!isPlainObject(edited)) {
    throw new CorpusError(
      `the edit to the corpus case file "${caseFile}" did not return a map of leaf paths to ` +
        "entries (fix: return the complete new expected map, existing entries included)",
    );
  }
  if (options.addOnly) checkAddOnly(caseFile, original, edited);

  // Spread, not rebuild: the top-level members keep their key order, and the
  // `expected` key keeps its position because it already exists in raw.
  const next: unknown = { ...raw, expected: edited };
  const result = CorpusCaseSchema.safeParse(next);
  if (!result.success) {
    throw new CorpusError(
      `the corpus case file "${caseFile}" would not be a valid case after the edit: ` +
        `${describeIssues(result.error.issues, next)} (fix: propose entries the case format ` +
        "accepts)",
    );
  }

  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  const temp = `${caseFile}.tmp`;
  try {
    io.writeFile(temp, serialized);
    io.rename(temp, caseFile);
  } catch (error) {
    // The publish failed, so the temp is at most a partial file: remove it,
    // never let the fault mask the original failure.
    try {
      io.unlink(temp);
    } catch {
      // Best-effort cleanup; the original fault is the one worth raising.
    }
    throw new CorpusError(
      `the corpus case file "${caseFile}" could not be written: ${faultMessage(error)} — ` +
        "the original file is untouched (fix: check the case directory is writable)",
    );
  }
}
