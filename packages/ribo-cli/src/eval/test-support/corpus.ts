/**
 * @file The corpus fixtures the eval suite drives: the committed fixture
 * corpus, the split fixture corpus, and the copy-and-mutate helper the
 * package's other suites use.
 *
 * Every test that needs a corpus copies a committed fixture into a temp
 * directory and breaks exactly one thing about it, so the suite never writes to
 * the committed tree and never shares state between tests.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The committed fixture corpus — transcript, text and document cases. */
export const FIXTURE_CORPUS = fileURLToPath(new URL("../../fixtures/corpus", import.meta.url));

/** The committed split fixture corpus — groups wide enough to split under a byte cap. */
export const FIXTURE_SPLIT_CORPUS = fileURLToPath(
  new URL("../../fixtures/corpus-split", import.meta.url),
);

/** The temp directories this suite created, so each test cleans up after itself. */
const temporaries: string[] = [];

/**
 * Copy a fixture corpus into a fresh temp directory, break one thing about
 * it, and hand the path over.
 * @param source - The fixture corpus to copy.
 * @param breakOne - The mutation to apply to the copy.
 * @returns The copied corpus's path.
 * @category Eval
 */
export function copiedCorpus(source: string, breakOne?: (dir: string) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ribo-eval-"));
  temporaries.push(dir);
  cpSync(source, dir, { recursive: true });
  breakOne?.(dir);
  return dir;
}

/**
 * A copy of the committed fixture corpus with its document case removed — the
 * corpus the runner accepts, since a document case refuses the whole run.
 * @returns The copied corpus's path.
 * @category Eval
 */
export function corpusWithoutDocuments(): string {
  return copiedCorpus(FIXTURE_CORPUS, (dir) => {
    rmSync(path.join(dir, "service-sheet"), { recursive: true, force: true });
  });
}

/**
 * A copy of the committed fixture corpus holding exactly the named cases — the
 * document case is always removed, since it refuses the whole run.
 * @param caseIds - The case ids to keep.
 * @returns The copied corpus's path.
 * @category Eval
 */
export function corpusWithCases(...caseIds: readonly string[]): string {
  return copiedCorpus(FIXTURE_CORPUS, (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== "service-sheet" && caseIds.includes(entry.name)) continue;
      rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    }
  });
}

/**
 * Read a JSON file of a copied corpus, edit it, and write it back.
 * @param file - The file to edit.
 * @param edit - The edit to apply.
 * @category Eval
 */
export function editJson(file: string, edit: (document: Record<string, unknown>) => void): void {
  const document = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(document);
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
}

/**
 * Remove every temp directory this suite created.
 * @category Eval
 */
export function removeTemporaries(): void {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
}
