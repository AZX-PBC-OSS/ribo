/**
 * @file The records store: where a run's record lands, and how the directory
 * is read back.
 *
 * The directory is the run's own, cwd-relative by default, because eval runs
 * against arbitrary schemas and corpora in arbitrary folders: a run's records
 * belong beside the work that produced them, not inside the tool's own tree.
 *
 * Three rules the store keeps:
 *
 * - a record is written whole or not at all (a temp file, then a rename), so
 *   an interrupted write never leaves a half-written record;
 * - a record is never overwritten (a colliding name gets a suffix), because
 *   a run costs money to produce and every grid deserves to survive;
 * - the lineage is computed HERE, from the directory's contents, because a
 *   lineage is a fact of the directory and not a caller's claim.
 *
 * A records directory accumulates strays — a report redirected there, a note
 * exported beside the records — so a read skips a `.json` file that is not a
 * run record at all, with one stderr line naming it, rather than refusing.
 * A file that IS a record — a JSON object carrying `contractVersion` or
 * `capturedAt`, the member every record format (old and new) has — is zod-parsed, never cast (AGENTS §4), and one that
 * fails the schema (a hand edit, an artefact of a newer contract version)
 * raises the could-not-run class naming its path: a record must never
 * silently drop out of a lineage.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import { EvalError } from "./error.js";
import { recordIdentity } from "./record-fingerprint.js";
import type {
  EvalRunRecord,
  EvalRunRecordDraft,
  EvalRunRecordHistoryEntry,
} from "./record-schema.js";
import { EvalRunRecordSchema } from "./record-schema.js";

/**
 * The records directory a run writes to when it names none: `./ribo-eval-runs/`
 * under the current working directory.
 *
 * The default is exported so the bin, compare and every freshness reader name
 * the same directory instead of restating it.
 * @category Eval
 */
export const EVAL_RUN_RECORDS_DEFAULT_DIR = "ribo-eval-runs";

/** The message of a thrown fault — a non-Error sentinel must not read "undefined". */
const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The records directory, resolved against the current working directory.
 * @param dir - The directory the caller named, if any.
 * @returns The resolved directory.
 */
const resolveDir = (dir?: string): string =>
  path.resolve(process.cwd(), dir ?? EVAL_RUN_RECORDS_DEFAULT_DIR);

/**
 * The file name a record is written under: its capture time and the first
 * part of its identity key.
 *
 * The name is sortable by time and carries the identity, so a directory of
 * records can be read by eye.
 * @param capturedAt - The record's capture time.
 * @param identity - The record's identity key.
 * @returns The file name, without a directory.
 */
const recordFileName = (capturedAt: string, identity: string): string => {
  const parsed = Date.parse(capturedAt);
  const stamp = Number.isNaN(parsed)
    ? capturedAt.replace(/[^0-9A-Za-z]/gu, "")
    : new Date(parsed)
        .toISOString()
        .replace(/[-:]/gu, "")
        .replace(/\.\d{3}/u, "");
  return `${stamp}-${identity.slice(0, 12)}.json`;
};

/**
 * The lineage of a record: the strictly-earlier records of the same identity
 * in the same directory.
 *
 * "Strictly earlier" is the capture time, so two runs captured in the same
 * millisecond are siblings rather than ancestors.
 * @param earlier - The records already in the directory.
 * @param identity - The new record's identity key.
 * @param capturedAt - The new record's capture time.
 * @returns The lineage, ordered by capture time.
 */
const historyOf = (
  earlier: readonly EvalRunRecord[],
  identity: string,
  capturedAt: string,
): EvalRunRecordHistoryEntry[] =>
  earlier
    .filter((entry) => recordIdentity(entry) === identity)
    .filter((entry) => Date.parse(entry.capturedAt) < Date.parse(capturedAt))
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt))
    .map((entry) => ({
      identity: recordIdentity(entry),
      capturedAt: entry.capturedAt,
      totals: entry.totals,
    }));

/**
 * Is this parsed JSON a run record to parse for real? A record is a plain
 * object carrying `contractVersion` (every record this store writes) or
 * `capturedAt` (which the retired old format also carries, so an old-format
 * record still refuses rather than dropping out silently). Anything else in the directory (a redirected
 * report, a stray list, a note) is not a record at all: it is skipped, never
 * judged by the schema.
 */
const isRecordCandidate = (document: unknown): document is Record<string, unknown> =>
  typeof document === "object" &&
  document !== null &&
  !Array.isArray(document) &&
  ("contractVersion" in document || "capturedAt" in document);

/**
 * One stderr line for a directory entry that is not a run record, naming the
 * file — the line is what keeps a skip from ever being silent.
 */
const skipNonRecord = (file: string, why: string): void => {
  process.stderr.write(`eval: skipping "${file}" — not a run record: ${why}\n`);
};

/**
 * Read every record in a directory.
 *
 * A missing directory reads as an empty list — the no-records-yet state is
 * normal, not a fault. A `.json` file that is not a run record at all —
 * unparseable JSON, or JSON carrying neither `contractVersion` nor
 * `capturedAt` — is skipped with one stderr line naming it. A file that
 * IS a record but fails the schema — a hand edit, an artefact of a newer
 * contract version — raises the could-not-run class naming its path.
 * @param dir - The records directory. Defaults to the run's own directory.
 * @returns The records, ordered by capture time.
 * @throws {@link EvalError} when a record file fails the record schema.
 * @category Eval
 */
export function readEvalRunRecords(dir?: string): EvalRunRecord[] {
  const target = resolveDir(dir);
  if (!existsSync(target)) return [];
  const entries = readdirSync(target, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const records: { readonly name: string; readonly record: EvalRunRecord }[] = [];
  for (const name of files) {
    const file = path.join(target, name);
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      skipNonRecord(file, `it is not valid JSON (${faultMessage(error)})`);
      continue;
    }
    if (!isRecordCandidate(document)) {
      skipNonRecord(file, "the JSON in it is not a run record object (no contractVersion or capturedAt)");
      continue;
    }
    const parsed = EvalRunRecordSchema.safeParse(document);
    if (!parsed.success) {
      throw new EvalError(
        `eval: the run record "${file}" is not a valid run record: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")} (fix: delete or repair the file)`,
      );
    }
    records.push({ name, record: parsed.data });
  }
  return records
    .sort((left, right) => {
      const byTime = Date.parse(left.record.capturedAt) - Date.parse(right.record.capturedAt);
      if (byTime !== 0) return byTime;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    })
    .map((entry) => entry.record);
}

/**
 * Write a record into a records directory.
 *
 * The directory is created when it is missing, the lineage is computed from
 * the records already there, the complete record is validated against the
 * record schema, and the file is written to a temp name and renamed — so an
 * interrupted write never leaves a half-written record, and a record that
 * could not be parsed never reaches the disk.
 *
 * The file is never overwritten: a name already taken gets a `-2`, `-3`, …
 * suffix, so two runs of the same measurement in the same second both
 * survive.
 * @param draft - The record to write, without its lineage.
 * @param dir - The records directory. Defaults to the run's own directory.
 * @returns The path of the file written.
 * @throws {@link EvalError} when the directory cannot be written, when a record already in it fails the record schema, or when the record itself is invalid.
 * @category Eval
 */
export function writeEvalRunRecord(draft: EvalRunRecordDraft, dir?: string): string {
  const target = resolveDir(dir);
  try {
    mkdirSync(target, { recursive: true });
  } catch (error) {
    throw new EvalError(
      `eval: the records directory "${target}" could not be created: ${faultMessage(error)} ` +
        "(fix: point --out at a writable directory)",
    );
  }
  // The directory's own records decide the lineage, so a sibling that reads
  // as a malformed record fails the write rather than dropping out of the
  // lineage silently; a stray that is no record at all is skipped by the
  // same read, with one stderr line naming it.
  const earlier = readEvalRunRecords(target);
  const identity = recordIdentity(draft);
  const record = EvalRunRecordSchema.safeParse({
    ...draft,
    history: historyOf(earlier, identity, draft.capturedAt),
  });
  if (!record.success) {
    throw new EvalError(
      `eval: the run record could not be written: ${record.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")} (fix: report this to the CLI's maintainers)`,
    );
  }
  const base = recordFileName(draft.capturedAt, identity);
  let file = path.join(target, base);
  let suffix = 1;
  while (existsSync(file)) {
    suffix += 1;
    file = path.join(target, base.replace(/\.json$/u, `-${suffix}.json`));
  }
  const temp = `${file}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(record.data, null, 2)}\n`);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new EvalError(
      `eval: the run record could not be written to "${file}": ${faultMessage(error)} ` +
        "(fix: point --out at a writable directory)",
    );
  }
  return file;
}
