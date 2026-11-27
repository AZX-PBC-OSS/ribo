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

/**
 * The committed flat fixture corpus — a schema with no groups at all.
 *
 * It exists for the spend guard: the presence-narrowed strategy has no call
 * bound over a schema with no groups, and a guard that read "no bound" as
 * "no calls" would price the run at nothing.
 */
export const FIXTURE_FLAT_CORPUS = fileURLToPath(
  new URL("../../fixtures/corpus-flat", import.meta.url),
);

/** The committed schema-init-shaped fixture corpus — top-level scalars beside a plain-leaf collection. */
export const FIXTURE_SCALARS_CORPUS = fileURLToPath(
  new URL("../../fixtures/corpus-scalars", import.meta.url),
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
 * A copy of the committed fixture corpus with its document case removed —
 * for suites that measure transcript and text cases only.
 * @returns The copied corpus's path.
 * @category Eval
 */
export function corpusWithoutDocuments(): string {
  return copiedCorpus(FIXTURE_CORPUS, (dir) => {
    rmSync(path.join(dir, "service-sheet"), { recursive: true, force: true });
  });
}

/**
 * A copy holding only the document case, for preflight refusals that must
 * prove transcription never started.
 * @returns The copied corpus's path.
 * @category Eval
 */
export function corpusWithDocumentCase(): string {
  return copiedCorpus(FIXTURE_CORPUS, (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "service-sheet") {
        rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      }
    }
  });
}

/**
 * A copied corpus with nested objects and collections, plus a prompt-mode
 * manifest. Its plan belongs to each test: this helper supplies no plan and
 * never writes one into the corpus.
 * @returns The copied corpus's path.
 * @category Eval
 */
export function corpusWithNestedRows(): string {
  return copiedCorpus(FIXTURE_CORPUS, (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "spoken-note") {
        rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      }
    }
    writeFileSync(
      path.join(dir, "schema.json"),
      `${JSON.stringify(
        {
          type: "object",
          properties: {
            building: {
              type: "object",
              properties: {
                details: {
                  type: "object",
                  properties: {
                    year: { type: "number", description: "The construction year." },
                    color: { type: "string", description: "The exterior colour." },
                  },
                  required: ["year", "color"],
                },
              },
              required: ["details"],
            },
            systems: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "The system name." },
                  serial: { type: "string", description: "The system serial." },
                },
                required: ["name", "serial"],
              },
            },
          },
          required: ["building", "systems"],
        },
        null,
        2,
      )}\n`,
    );
    editJson(path.join(dir, "manifest.json"), (document) => {
      const prompt = document["prompt"] as Record<string, unknown>;
      prompt["examples"] = [];
      prompt["fieldDescriptions"] = "prompt";
      prompt["groupInstructions"] = {
        building: "Manifest group guidance must not replace the semantic plan.",
      };
    });
    editJson(path.join(dir, "spoken-note", "case.json"), (document) => {
      document["expected"] = {};
      delete document["defaults"];
    });
  });
}

/**
 * The transcriber package's scanned-PDF fixture, referenced in place: a PDF
 * with no text layer, which the document path refuses (the transcriber's
 * `no-text-layer` guard).
 */
const NO_TEXT_LAYER_PDF = fileURLToPath(
  new URL("../../../../ribo-transcriber-pdfjs/src/fixtures/no-text-layer.pdf", import.meta.url),
);

/**
 * A copy of the committed fixture corpus whose document case's PDF has no
 * text layer: the document path refuses the whole run, naming the case.
 * @returns The copied corpus's path.
 * @category Eval
 */
export function corpusWithNoTextLayerDocument(): string {
  return copiedCorpus(FIXTURE_CORPUS, (dir) => {
    writeFileSync(path.join(dir, "service-sheet", "input.pdf"), readFileSync(NO_TEXT_LAYER_PDF));
  });
}

/**
 * A copy of the committed fixture corpus holding exactly the named cases — the
 * document case is always removed, for suites that measure transcript and
 * text cases only.
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
 * A copy of the committed fixture corpus whose `service-sheet` case reads two
 * inputs — the document PDF first, then a text note — the shipped example's
 * shape.
 * @param note - The note's text; the shipped example's neutral note by default.
 * @returns The copied corpus's path.
 * @category Eval
 */
export function corpusWithMixedInputsCase(note = "No additional observations.\n"): string {
  return copiedCorpus(FIXTURE_CORPUS, (dir) => {
    writeFileSync(path.join(dir, "service-sheet", "site-note.txt"), note);
    editJson(path.join(dir, "service-sheet", "case.json"), (document) => {
      document["inputs"] = [
        {
          file: "input.pdf",
          kind: "document",
          capture: { capturedAt: "2026-02-11T08:15:00Z", pageCount: 1 },
        },
        { file: "site-note.txt", kind: "text" },
      ];
    });
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

/** The proposer a review fixture's proposals are stamped with. */
export interface ReviewProposer {
  /** The proposal's backend. */
  readonly backend: string;
  /** The proposal's model. */
  readonly model: string;
}

/**
 * A copied corpus whose one case carries one entry of each review class —
 * hand-written (`frame.material`), accepted-unchanged (`frame.serial`),
 * corrected (`service.date`), pending (`service.notes`) — plus a
 * `service.warranty` leaf judged from a declared-absent scoped default, so
 * the origin summaries have a default-resolved judged cell to classify. The
 * proposals are stamped with the given proposer, so a suite can point them
 * at — or away from — the backend and model the record will name.
 * @param proposer - The backend and model the proposals are stamped with.
 * @returns The copied corpus's path.
 * @category Eval
 */
export function corpusWithReviewClasses(
  proposer: ReviewProposer = { backend: "openai-compatible", model: "ribo-test" },
): string {
  return copiedCorpus(FIXTURE_CORPUS, (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "spoken-note") {
        rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      }
    }
    writeFileSync(
      path.join(dir, "schema.json"),
      `${JSON.stringify(
        {
          type: "object",
          properties: {
            frame: {
              type: "object",
              properties: {
                material: { type: "string", description: "The frame's material." },
                serial: { type: "string", description: "The frame's serial number." },
              },
              required: ["material", "serial"],
            },
            service: {
              type: "object",
              properties: {
                date: { type: "string", description: "The day the work was carried out." },
                notes: { type: "string", description: "Notes about the work." },
                warranty: { type: "string", description: "The warranty work, if any." },
              },
              required: ["date", "notes", "warranty"],
            },
          },
          required: ["frame", "service"],
        },
        null,
        2,
      )}\n`,
    );
    const proposal = (leaf: {
      readonly status: "asserted" | "declared-absent";
      readonly value?: unknown;
    }): Record<string, unknown> => ({
      status: leaf.status,
      ...(leaf.status === "asserted"
        ? { value: leaf.value, evidence: { quote: "the proposed quote", input: "input.txt" } }
        : {}),
      backend: proposer.backend,
      model: proposer.model,
      proposedAt: "2026-11-13T09:00:00.000Z",
    });
    editJson(path.join(dir, "spoken-note", "case.json"), (document) => {
      document["expected"] = {
        "frame.material": { status: "asserted", value: "steel", sourceSpan: "steel frame" },
        "frame.serial": {
          status: "asserted",
          value: "BW-4471",
          proposal: proposal({ status: "asserted", value: "BW-4471" }),
          review: "confirmed",
        },
        "service.date": {
          status: "asserted",
          value: "2026-01-06",
          proposal: proposal({ status: "asserted", value: "2026-01-05" }),
          review: "confirmed",
        },
        "service.notes": {
          status: "asserted",
          value: "brake pad replacement",
          proposal: proposal({ status: "asserted", value: "brake pad replacement" }),
          review: "pending",
        },
      };
      document["defaults"] = [{ scope: "service", status: "declared-absent" }];
    });
  });
}
