import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { InputFault, readDocumentSource } from "./read-input.js";

/**
 * @file The input-reading seam (Requirement 12's checkable seam): the TTY
 * no-prompt branch cannot be exercised through a piped subprocess, so it is
 * a plain unit test over the `isTTY` boolean. The filesystem faults are the
 * same faults the subprocess suite pins end to end; here they are cheapest.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ribo-cli-read-input-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("no path and a TTY stdin is refused with guidance — never a blocking read", () => {
  try {
    readDocumentSource(undefined, true);
    expect.unreachable("the TTY read did not refuse");
  } catch (error) {
    expect(error).toBeInstanceOf(InputFault);
    const message = (error as Error).message;
    expect(message).toContain("pass a file path");
    expect(message).toContain("stdin");
  }
});

test("a missing file names the path", () => {
  const missing = join(dir, "nope.schema.json");
  try {
    readDocumentSource(missing, false);
    expect.unreachable("the missing file did not refuse");
  } catch (error) {
    expect(error).toBeInstanceOf(InputFault);
    expect((error as Error).message).toContain(missing);
  }
});

test("a whitespace-only file names the empty source", () => {
  const blank = join(dir, "blank.json");
  writeFileSync(blank, "  \n \n");
  try {
    readDocumentSource(blank, false);
    expect.unreachable("the whitespace file did not refuse");
  } catch (error) {
    expect(error).toBeInstanceOf(InputFault);
    expect((error as Error).message).toContain(
      `the input read from the file at ${blank} was empty`,
    );
  }
});

test("a readable file is returned as-is", () => {
  const schema = join(dir, "ok.json");
  writeFileSync(schema, '{"type":"object"}\n');
  expect(readDocumentSource(schema, false)).toBe('{"type":"object"}\n');
});
