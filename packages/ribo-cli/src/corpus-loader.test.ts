/**
 * @file The corpus loader's tests: the committed fixture corpus loads, and
 * every authoring mistake the format can carry is refused by name.
 *
 * Each negative test copies the fixture corpus into a fresh temp directory,
 * breaks exactly one thing, and asserts the refusal — the `bin.test.ts`
 * pattern. The loader is driven for real: no test stubs a file read, and no
 * test makes a model call (this ticket has no model surface at all).
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { baseDocumentCaptureSchema, walkLeafInventory } from "@azx/ribo-core";
import { afterEach, expect, test } from "vitest";

import { convertDocument } from "./inspect/convert.js";
import { walkFieldInventory } from "./inspect/field-inventory.js";
import { CorpusError } from "./corpus/error.js";
import { loadCorpus } from "./corpus/loader.js";
import { resolveExpectation } from "./corpus/expectations.js";
import { SchemaInspectError } from "./inspect/error.js";

/** The committed fixture corpus. */
const FIXTURE = fileURLToPath(new URL("./fixtures/corpus", import.meta.url));

/** The temp directories this suite created, so each test cleans up after itself. */
const temporaries: string[] = [];

/** Copy the fixture corpus into a fresh temp directory, break one thing, and hand it over. */
const brokenCorpus = (breakOne: (dir: string) => void): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "ribo-corpus-"));
  temporaries.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  breakOne(dir);
  return dir;
};

/** Read a JSON file of the copied corpus, edit it, and write it back. */
const editJson = (file: string, edit: (document: Record<string, unknown>) => void): void => {
  const document = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(document);
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
};

/** The message of the refusal a broken corpus earns. */
const refusal = (dir: string): string => {
  try {
    loadCorpus(dir);
  } catch (error) {
    expect(error).toBeInstanceOf(CorpusError);
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the broken corpus loaded instead of being refused");
};

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The fixture corpus loads
// ---------------------------------------------------------------------------

test("the committed fixture corpus loads, with its manifest, its cases and its schema", () => {
  const corpus = loadCorpus(FIXTURE);

  expect(corpus.manifest.name).toBe("workshop-bicycles");
  expect(corpus.manifest.provenance).toBe("synthetic");
  expect(corpus.manifest.prompt.instructions).toContain("workshop note");
  expect(corpus.manifest.prompt.groupInstructions?.["frame"]).toContain("frame details");
  expect(corpus.manifest.prompt.fieldDescriptions).toBe("schema");

  // The cases come back sorted by id, so a run record keyed by case id is diffable.
  expect(corpus.cases.map((entry) => entry.id)).toEqual([
    "service-sheet",
    "spoken-note",
    "written-ticket",
  ]);

  // The leaf paths and the group keys are the ones the schema declares.
  expect(corpus.leafInventory.map((entry) => entry.path)).toEqual([
    "frame.material",
    "frame.serial",
    "service.date",
    "service.notes",
  ]);
  expect(corpus.groupKeys).toEqual(["frame", "service"]);

  // The schema document is reachable as loaded — the run fingerprint hashes it.
  expect(corpus.schemaDocument).toMatchObject({ type: "object" });
});

test("a text case's input is the file's exact utf8 bytes", () => {
  const corpus = loadCorpus(FIXTURE);
  const spoken = corpus.cases.find((entry) => entry.id === "spoken-note");
  if (spoken === undefined) throw new Error("the fixture's spoken case did not load");
  expect(spoken.input.kind).toBe("transcript");
  if (spoken.input.kind !== "transcript") throw new Error("the spoken case is not a transcript");
  const expected = readFileSync(path.join(FIXTURE, "spoken-note", "input.txt"), "utf8");
  expect(spoken.input.text).toBe(expected);

  const ticket = corpus.cases.find((entry) => entry.id === "written-ticket");
  if (ticket === undefined) throw new Error("the fixture's ticket case did not load");
  expect(ticket.input.kind).toBe("text");
  if (ticket.input.kind !== "text") throw new Error("the ticket case is not a text case");
  expect(ticket.input.text).toBe(
    readFileSync(path.join(FIXTURE, "written-ticket", "input.txt"), "utf8"),
  );
});

test("a document case loads as a capture record beside its bytes", () => {
  const corpus = loadCorpus(FIXTURE);
  const document = corpus.cases.find((entry) => entry.id === "service-sheet");
  expect(document?.input.kind).toBe("document");
  if (document?.input.kind !== "document") throw new Error("the document case did not load");

  // The capture record is core's own shape, parsed against core's own schema.
  const capture = baseDocumentCaptureSchema.parse(document.input.capture);
  expect(capture.id).toBe("service-sheet");
  expect(capture.mimeType).toBe("application/pdf");
  expect(capture.capturedAt).toBe("2026-02-11T08:15:00Z");
  expect(capture.pageCount).toBe(1);

  const bytes = readFileSync(path.join(FIXTURE, "service-sheet", "input.pdf"));
  expect(Buffer.from(document.input.bytes).equals(bytes)).toBe(true);
});

test("the fixture's own expectations resolve as it declares them", () => {
  const corpus = loadCorpus(FIXTURE);
  const spoken = corpus.cases.find((entry) => entry.id === "spoken-note");
  if (spoken === undefined) throw new Error("the fixture's spoken case did not load");

  // An explicit entry, with its alternatives.
  expect(resolveExpectation(spoken, "frame.serial")).toMatchObject({
    status: "asserted",
    value: "BW-4471",
    alternatives: ["BW4471"],
    origin: "explicit",
  });

  // A default covering the leaves the case says nothing about.
  expect(resolveExpectation(spoken, "service.date")).toMatchObject({
    status: "declared-absent",
    origin: "default",
  });

  // A leaf nothing covers.
  const ticket = corpus.cases.find((entry) => entry.id === "written-ticket");
  if (ticket === undefined) throw new Error("the fixture's ticket case did not load");
  expect(resolveExpectation(ticket, "frame.material")).toMatchObject({
    status: "unmentioned",
    origin: "none",
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("a case whose input file is missing is refused, naming the path", () => {
  const dir = brokenCorpus((root) => {
    rmSync(path.join(root, "spoken-note", "input.txt"));
  });
  const message = refusal(dir);
  expect(message).toContain(path.join(dir, "spoken-note", "input.txt"));
  expect(message).toContain("input.txt");
});

test("a document case whose input file is missing is refused, naming the path", () => {
  const dir = brokenCorpus((root) => {
    rmSync(path.join(root, "service-sheet", "input.pdf"));
  });
  const message = refusal(dir);
  expect(message).toContain(path.join(dir, "service-sheet", "input.pdf"));
});

test("an expected leaf the schema does not declare is refused, naming the valid leaf paths", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "spoken-note", "case.json"), (document) => {
      (document["expected"] as Record<string, unknown>)["frame.nosuch"] = {
        status: "asserted",
        value: "x",
      };
    });
  });
  const message = refusal(dir);
  expect(message).toContain(path.join(dir, "spoken-note", "case.json"));
  expect(message).toContain("frame.nosuch");
  expect(message).toContain("frame.material");
  expect(message).toContain("service.notes");
});

test("the refusal's leaf vocabulary is the field inventory's, never a second walk's", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "spoken-note", "case.json"), (document) => {
      (document["expected"] as Record<string, unknown>)["frame.nosuch"] = {
        status: "asserted",
        value: "x",
      };
    });
  });
  const message = refusal(dir);
  const listed = (message.split("the valid leaf paths are: ")[1] ?? "").split(" (fix:")[0] ?? "";
  const schema = convertDocument(
    JSON.parse(readFileSync(path.join(FIXTURE, "schema.json"), "utf8")) as unknown,
  );
  const inventory = walkFieldInventory(schema);
  expect(listed.split(", ")).toEqual(inventory.map((entry) => entry.path));
  // The inventory the loader used is core's own leaf walk over the same schema.
  expect(inventory.map((entry) => entry.path)).toEqual(
    walkLeafInventory(schema).map((entry) => entry.path),
  );
});

test("a manifest whose schema reference does not resolve is refused, naming the path", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "manifest.json"), (document) => {
      document["schema"] = "nowhere/absent.json";
    });
  });
  const message = refusal(dir);
  expect(message).toContain(path.join(dir, "nowhere", "absent.json"));
  expect(message).toContain("nowhere/absent.json");
});

test("a schema reference in absolute path form is refused, naming the fix", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "manifest.json"), (document) => {
      document["schema"] = path.join(root, "schema.json");
    });
  });
  const message = refusal(dir);
  expect(message).toContain("absolute path");
  expect(message).toContain("relative to the corpus root");
});

test("a draft-2020-12-form schema is refused by the loader's own refusal", () => {
  const dir = brokenCorpus((root) => {
    writeFileSync(
      path.join(root, "schema.json"),
      JSON.stringify({
        type: "object",
        properties: {
          frame: {
            type: "object",
            properties: { material: { anyOf: [{ type: "string" }, { type: "null" }] } },
          },
        },
      }),
    );
  });
  const message = refusal(dir);
  expect(message).toContain("draft-2020-12 nullability");
  expect(message).toContain("anyOf");
  expect(message).toContain("nullable");
  expect(message).toContain("schema.json");
});

test("a manifest without its provenance is refused, naming the field", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "manifest.json"), (document) => {
      delete document["provenance"];
    });
  });
  const message = refusal(dir);
  expect(message).toContain("provenance");
  expect(message).toContain(path.join(dir, "manifest.json"));
});

test("a manifest without its prompt inputs is refused, naming the field", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "manifest.json"), (document) => {
      delete document["prompt"];
    });
  });
  const message = refusal(dir);
  expect(message).toContain("prompt");
});

test("a groupInstructions key that names no group is refused, naming the key and the groups", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "manifest.json"), (document) => {
      const prompt = document["prompt"] as Record<string, unknown>;
      prompt["groupInstructions"] = { gearbox: "nothing" };
    });
  });
  const message = refusal(dir);
  expect(message).toContain("gearbox");
  expect(message).toContain("frame");
  expect(message).toContain("service");
});

test("a schema with no groups refuses every groupInstructions key", () => {
  const dir = brokenCorpus((root) => {
    writeFileSync(
      path.join(root, "schema.json"),
      JSON.stringify({
        type: "object",
        properties: { material: { type: "string" }, serial: { type: "string" } },
      }),
    );
    editJson(path.join(root, "manifest.json"), (document) => {
      const prompt = document["prompt"] as Record<string, unknown>;
      prompt["groupInstructions"] = { frame: "nothing" };
    });
  });
  const message = refusal(dir);
  expect(message).toContain("frame");
  expect(message).toContain("none");
});

test("a case whose id differs from its directory is refused, naming both", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "spoken-note", "case.json"), (document) => {
      document["id"] = "elsewhere";
    });
  });
  const message = refusal(dir);
  expect(message).toContain("elsewhere");
  expect(message).toContain("spoken-note");
});

test("an unknown key is refused wherever the format is strict", () => {
  const cases: readonly { readonly where: string; readonly file: string }[] = [
    { where: "manifest", file: "manifest.json" },
    { where: "prompt", file: "manifest.json" },
    { where: "case file", file: "spoken-note/case.json" },
  ];
  for (const entry of cases) {
    const dir = brokenCorpus((root) => {
      const file = path.join(root, entry.file);
      editJson(file, (document) => {
        if (entry.where === "prompt") {
          (document["prompt"] as Record<string, unknown>)["nosuch"] = "x";
          return;
        }
        document["nosuch"] = "x";
      });
    });
    const message = refusal(dir);
    expect(message).toContain("nosuch");
    expect(message).toContain(path.join(dir, entry.file));
  }
});

test("an unknown key inside an example, an expectation entry, a default or a capture block is refused", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "manifest.json"), (document) => {
      const prompt = document["prompt"] as Record<string, unknown>;
      const examples = prompt["examples"] as Record<string, unknown>[];
      examples[0] = { ...examples[0], nosuch: "x" };
    });
  });
  expect(refusal(dir)).toContain("nosuch");

  const dir2 = brokenCorpus((root) => {
    editJson(path.join(root, "spoken-note", "case.json"), (document) => {
      const expected = document["expected"] as Record<string, Record<string, unknown>>;
      expected["frame.material"] = { ...expected["frame.material"], nosuch: "x" };
    });
  });
  expect(refusal(dir2)).toContain("nosuch");

  const dir3 = brokenCorpus((root) => {
    editJson(path.join(root, "spoken-note", "case.json"), (document) => {
      const defaults = document["defaults"] as Record<string, unknown>[];
      defaults[0] = { ...defaults[0], nosuch: "x" };
    });
  });
  expect(refusal(dir3)).toContain("nosuch");

  const dir4 = brokenCorpus((root) => {
    editJson(path.join(root, "service-sheet", "case.json"), (document) => {
      const capture = document["capture"] as Record<string, unknown>;
      capture["nosuch"] = "x";
    });
  });
  expect(refusal(dir4)).toContain("nosuch");
});

test("a manifest or case file that is not valid JSON is refused, naming the file", () => {
  const dir = brokenCorpus((root) => {
    writeFileSync(path.join(root, "manifest.json"), "{not json");
  });
  const message = refusal(dir);
  expect(message).toContain(path.join(dir, "manifest.json"));
  expect(message).toContain("not valid JSON");

  const dir2 = brokenCorpus((root) => {
    writeFileSync(path.join(root, "spoken-note", "case.json"), "[1, 2, 3]");
  });
  const message2 = refusal(dir2);
  expect(message2).toContain(path.join(dir2, "spoken-note", "case.json"));
});

test("a case file that is valid JSON of the wrong shape is refused, naming the file", () => {
  const dir = brokenCorpus((root) => {
    writeFileSync(path.join(root, "spoken-note", "case.json"), '"a bare string"');
  });
  const message = refusal(dir);
  expect(message).toContain(path.join(dir, "spoken-note", "case.json"));
  expect(message).toContain("invalid");
});

test("an unreadable input file is refused, naming the path", () => {
  const dir = brokenCorpus((root) => {
    rmSync(path.join(root, "spoken-note", "input.txt"));
    mkdirSync(path.join(root, "spoken-note", "input.txt"));
  });
  const message = refusal(dir);
  expect(message).toContain(path.join(dir, "spoken-note", "input.txt"));
});

test("a subdirectory without a case file is refused, naming the directory", () => {
  const dir = brokenCorpus((root) => {
    mkdirSync(path.join(root, "empty-case"));
  });
  const message = refusal(dir);
  expect(message).toContain(path.join(dir, "empty-case"));
  expect(message).toContain("case.json");
});

test("a corpus with no case directories is refused, naming the corpus root", () => {
  const dir = brokenCorpus((root) => {
    for (const entry of ["spoken-note", "written-ticket", "service-sheet"]) {
      rmSync(path.join(root, entry), { recursive: true });
    }
  });
  const message = refusal(dir);
  expect(message).toContain(dir);
  expect(message).toContain("no case directories");
});

test("a case directory holding the other kind's input file is refused, naming the stray file", () => {
  const dir = brokenCorpus((root) => {
    writeFileSync(path.join(root, "spoken-note", "input.pdf"), "%PDF-1.4\n");
  });
  const message = refusal(dir);
  expect(message).toContain(path.join(dir, "spoken-note", "input.pdf"));
});

test("a default scoped to a path no leaf carries is refused, naming the scope", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "spoken-note", "case.json"), (document) => {
      (document["defaults"] as Record<string, unknown>[]).push({
        scope: "gearbox",
        status: "declared-absent",
      });
    });
  });
  const message = refusal(dir);
  expect(message).toContain("gearbox");
});

test("a scope string declared twice in one case is refused, naming it", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "spoken-note", "case.json"), (document) => {
      (document["defaults"] as Record<string, unknown>[]).push({
        scope: "service",
        status: "unmentioned",
      });
    });
  });
  const message = refusal(dir);
  expect(message).toContain("service");
  expect(message).toContain("two defaults");
});

test("a capture block on a case that is not a document is refused, naming the field", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "spoken-note", "case.json"), (document) => {
      document["capture"] = { capturedAt: "2026-02-11T08:15:00Z", pageCount: 1 };
    });
  });
  const message = refusal(dir);
  expect(message).toContain("capture");
});

test("a document case without its capture block is refused, naming the field", () => {
  const dir = brokenCorpus((root) => {
    editJson(path.join(root, "service-sheet", "case.json"), (document) => {
      delete document["capture"];
    });
  });
  const message = refusal(dir);
  expect(message).toContain("capture");
});

test("an expectation entry's shape is refused, naming the leaf path", () => {
  const withoutValue = brokenCorpus((root) => {
    editJson(path.join(root, "spoken-note", "case.json"), (document) => {
      (document["expected"] as Record<string, unknown>)["frame.material"] = {
        status: "asserted",
      };
    });
  });
  expect(refusal(withoutValue)).toContain("frame.material");

  const withValue = brokenCorpus((root) => {
    editJson(path.join(root, "spoken-note", "case.json"), (document) => {
      (document["expected"] as Record<string, unknown>)["frame.material"] = {
        status: "declared-absent",
        value: "steel",
      };
    });
  });
  expect(refusal(withValue)).toContain("frame.material");

  const withArray = brokenCorpus((root) => {
    editJson(path.join(root, "spoken-note", "case.json"), (document) => {
      (document["expected"] as Record<string, unknown>)["frame.material"] = {
        status: "asserted",
        value: ["steel", "alloy"],
      };
    });
  });
  expect(refusal(withArray)).toContain("frame.material");
});

test("every corpus refusal is a CorpusError and a could-not-run fault", () => {
  const breakings: readonly ((root: string) => void)[] = [
    (root) => rmSync(path.join(root, "spoken-note", "input.txt")),
    (root) =>
      editJson(path.join(root, "spoken-note", "case.json"), (document) => {
        (document["expected"] as Record<string, unknown>)["frame.nosuch"] = {
          status: "asserted",
          value: "x",
        };
      }),
    (root) =>
      editJson(path.join(root, "manifest.json"), (document) => {
        document["schema"] = "nowhere/absent.json";
      }),
    (root) =>
      editJson(path.join(root, "manifest.json"), (document) => {
        delete document["provenance"];
      }),
    (root) =>
      editJson(path.join(root, "manifest.json"), (document) => {
        (document["prompt"] as Record<string, unknown>)["groupInstructions"] = { gearbox: "x" };
      }),
  ];
  for (const breaking of breakings) {
    const dir = brokenCorpus(breaking);
    try {
      loadCorpus(dir);
      throw new Error("the broken corpus loaded instead of being refused");
    } catch (error) {
      expect(error).toBeInstanceOf(CorpusError);
      expect(error).toBeInstanceOf(SchemaInspectError);
    }
  }
});
