/**
 * The bin's input plumbing, extended from T3's: the document is read from the
 * file at `path`, or from stdin when `path` is absent or exactly `-`. When no
 * path is given and stdin is a TTY there is nothing to read — the command
 * never prompts and never blocks on a terminal (design §1, Decision D6) — so
 * that case is refused with guidance instead. An explicit `-` still honours
 * the caller's request to read stdin.
 *
 * Every fault is an `InputFault` carrying the finished, actionable diagnostic
 * message — naming the path, the source or the emptiness, per design §5's
 * message table. The bin maps it to the could-not-run class (exit 2, stderr,
 * empty stdout). The seam is a plain function taking the `isTTY` boolean so
 * the TTY branch is testable without a terminal.
 */
import { readFileSync } from "node:fs";

/** A could-not-run input fault, carrying the finished diagnostic message. */
export class InputFault extends Error {}

export function readDocumentSource(path: string | undefined, stdinIsTTY: boolean): string {
  const fromStdin = !path || path === "-";
  const source = fromStdin ? "stdin" : `the file at ${path}`;
  if (fromStdin && path === undefined && stdinIsTTY) {
    throw new InputFault(
      "no input: pass a file path to inspect, or pipe the JSON Schema document on stdin " +
        "(use - to read stdin explicitly)",
    );
  }
  let raw: string;
  if (fromStdin) {
    try {
      raw = readFileSync(0, "utf8");
    } catch (error) {
      throw new InputFault(
        `could not read stdin: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      throw new InputFault(
        `could not read the file at ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (raw.trim() === "") {
    throw new InputFault(
      `the input read from ${source} was empty — an empty input is a could-not-run fault, ` +
        "never a report about a schema with no leaves in it",
    );
  }
  return raw;
}
