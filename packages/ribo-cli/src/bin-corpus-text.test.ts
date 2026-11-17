import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test, vi } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { FIXTURE_CORPUS } from "./eval/test-support/corpus.js";

/**
 * @file `ribo corpus text`, driven through the BUILT bin: the text each
 * case's prompt carries, printed without a model call or a credential.
 *
 * The corpus is the committed fixture, read in place — the command never
 * writes. The document case's text is transcribed through the same
 * pdf.js-under-Node path `ribo eval` uses, resolved from the installed
 * pdfjs-dist, so this suite is also the first to prove the single-file
 * bundle can still resolve pdf.js for the document path.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

// A run costs a subprocess; the document case's run also pays pdf.js's load
// and a real transcription inside the child.
vi.setConfig({ testTimeout: 60_000 });

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Drive the built bin with a minimal, credential-free environment. */
const runBin = async (args: readonly string[]): Promise<Run> => {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  return { status, stdout, stderr };
};

/** Drive `ribo corpus text`. */
const run = (args: readonly string[]): Promise<Run> => runBin(["corpus", "text", ...args]);

beforeAll(() => {
  buildCliOnce();
}, 120_000);

test("every case's text prints under a per-case header — the document case's extracted text included", async () => {
  const result = await run([FIXTURE_CORPUS]);

  expect(result.status).toBe(0);
  // A clear header per case, naming the case and its kind.
  expect(result.stdout).toContain("== service-sheet (document) ==");
  expect(result.stdout).toContain("== spoken-note (transcript) ==");
  expect(result.stdout).toContain("== written-ticket (text) ==");
  // The document case's extracted text: the fixture service sheet's own
  // words. Must-fail: an implementation that skips the document case, or
  // prints a placeholder for it, has no "Chain replaced" to print.
  expect(result.stdout).toContain("Chain replaced");
  // The transcript and text cases' text, verbatim.
  expect(result.stdout).toContain(
    "Customer brought in a steel frame bicycle, serial number BW-4471",
  );
  expect(result.stdout).toContain("Ticket 88213");
  // Piped output carries no escape bytes.
  expect(result.stdout).not.toContain("\x1b");
});

test("a case id prints that case alone, with no header and no other case's text", async () => {
  const result = await run([FIXTURE_CORPUS, "spoken-note"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "Customer brought in a steel frame bicycle, serial number BW-4471",
  );
  expect(result.stdout).not.toContain("service-sheet");
  expect(result.stdout).not.toContain("written-ticket");
  expect(result.stdout).not.toContain("Ticket 88213");
  expect(result.stdout).not.toContain("==");
});

test("an unknown case id exits 2, naming the id, with stdout empty", async () => {
  const result = await run([FIXTURE_CORPUS, "no-such-case"]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("ribo corpus text");
  expect(result.stderr).toContain("no-such-case");
  // The refusal names the cases the corpus does hold.
  expect(result.stderr).toContain("spoken-note");
  expect(result.stderr).toContain("(fix:");
});

test("--json emits the versioned document of {caseId, kind, text} entries", async () => {
  const result = await run(["--json", FIXTURE_CORPUS]);

  expect(result.status).toBe(0);
  const document = JSON.parse(result.stdout) as {
    readonly contractVersion: number;
    readonly corpus: string;
    readonly cases: readonly {
      readonly caseId: string;
      readonly kind: string;
      readonly text: string;
    }[];
  };
  expect(document.contractVersion).toBe(1);
  expect(document.corpus).toBe("workshop-bicycles");
  expect(document.cases.map((entry) => entry.caseId)).toEqual([
    "service-sheet",
    "spoken-note",
    "written-ticket",
  ]);
  const byId = new Map(document.cases.map((entry) => [entry.caseId, entry]));
  expect(byId.get("service-sheet")?.kind).toBe("document");
  expect(byId.get("service-sheet")?.text).toContain("Chain replaced");
  expect(byId.get("spoken-note")?.kind).toBe("transcript");
  expect(byId.get("spoken-note")?.text).toContain("BW-4471");
  expect(byId.get("written-ticket")?.kind).toBe("text");
  expect(byId.get("written-ticket")?.text).toContain("Ticket 88213");
});

test("an unreadable corpus exits 2, naming the path", async () => {
  const missing = join(tmpdir(), "ribo-corpus-text-no-such-dir");
  const result = await run([missing]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("ribo corpus text");
  expect(result.stderr).toContain(missing);
});
