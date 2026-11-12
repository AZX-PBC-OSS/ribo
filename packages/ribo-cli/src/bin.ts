#!/usr/bin/env node
/**
 * The `ribo` bin — a thin shell over `inspectSchema` (ADR 0037). The command
 * path is `ribo schema inspect [path]` (design §1); the document is read from
 * the file at `path`, or from stdin when `path` is absent or exactly `-`.
 *
 * Output discipline (design §4): on success exactly one JSON document — the
 * report — on stdout, exit 0. On every could-not-run fault (unreadable file,
 * empty input, malformed JSON, not a JSON Schema document, unconvertible) a
 * plain-words diagnostic on stderr, stdout empty, exit 2. No credential-bearing
 * option exists on this surface, and none may: secrets never ride flags.
 */
import { readFileSync } from "node:fs";
import process from "node:process";

import { Command } from "commander";
import pc from "picocolors";

import { SchemaInspectError, inspectSchema } from "./inspect-schema.js";

/** Reports a could-not-run fault and exits 2. Stdout stays empty. */
function fail(message: string): never {
  process.stderr.write(`ribo schema inspect: ${pc.red(message)}\n`);
  process.exit(2);
}

function readDocumentSource(path?: string): string {
  const fromStdin = !path || path === "-";
  const source = fromStdin ? "stdin" : `the file at ${path}`;
  let raw: string;
  if (fromStdin) {
    try {
      raw = readFileSync(0, "utf8");
    } catch (error) {
      fail(`could not read stdin: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      fail(
        `could not read the file at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (raw.trim() === "") {
    fail(
      `the input read from ${source} was empty — an empty input is a could-not-run fault, ` +
        "never a report about a schema with no leaves in it",
    );
  }
  return raw;
}

function run(path?: string): void {
  const raw = readDocumentSource(path);
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    fail(`the input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  let report: ReturnType<typeof inspectSchema>;
  try {
    report = inspectSchema(document);
  } catch (error) {
    if (error instanceof SchemaInspectError) fail(error.message);
    throw error;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const program = new Command()
  .name("ribo")
  .description("Ribo's command-line tools (ADR 0037)")
  .showHelpAfterError();

const schema = program.command("schema").description("Sizing checks over a JSON Schema document");

schema
  .command("inspect")
  .description(
    "Size a JSON Schema document in OpenAPI 3.0 form before the first call. Reads the file at " +
      "<path>, or stdin when <path> is absent or exactly -.",
  )
  .argument("[path]", "path to the JSON Schema document file, or - for stdin")
  .action(run);

// Commander's parse() reads process.argv by default. Exit codes are the
// command's own: 0 from run(), 2 from fail(), and commander's own exit on a
// usage error, which is also a could-not-run shape.
program.parse();
