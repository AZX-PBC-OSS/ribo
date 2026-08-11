import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { RunRecord } from "./run-record.js";
import { openRunStore } from "./run-store.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ribo-runs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    capturedAt: "2026-08-11T12:00:00.000Z",
    schemaFingerprint: `sha256:${"a".repeat(64)}`,
    backend: "codex-cli",
    backendLabel: "codex-cli",
    model: "codex-cli",
    passed: true,
    hallRate: 0.01,
    missRate: 0.02,
    hazards: {
      fuelDropped: 0,
      fuelInvented: 0,
      hallucinatedPass: 0,
      rvalueConversion: 0,
      enumWrongMember: 0,
      enumInvalid: 0,
      spanFabricated: 0,
      spanMissing: 0,
    },
    shapeConformance: { applicable: true, firstTry: 1, retried: 0, never: 0 },
    totals: { gtNull: 1 },
    leafPaths: ["attic.rValue"],
    transcripts: [{ slug: "01-one", status: "scored", problem: null }],
    grid: {
      "attic.rValue": {
        "01-one": {
          verdict: "correct",
          expected: "38",
          got: "38",
          sourceSpan: null,
          spanIssue: null,
          detail: null,
        },
      },
    },
    ...overrides,
  };
}

describe("openRunStore — create, read, update", () => {
  test("saveRun then readCurrent round-trips the full grid", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    const read = await store.readCurrent("codex-cli");
    expect(read?.grid["attic.rValue"]?.["01-one"]?.expected).toBe("38");
  });

  test("readCurrent returns null for a backend that has never run", async () => {
    expect(await openRunStore({ dir }).readCurrent("codex-cli")).toBeNull();
  });

  test("a second run OVERWRITES current but APPENDS to history", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    await store.saveRun(run({ capturedAt: "2026-08-12T12:00:00.000Z", hallRate: 0.05 }));

    expect((await store.readCurrent("codex-cli"))?.hallRate).toBe(0.05);
    const history = await store.readHistory("codex-cli");
    expect(history.map((h) => h.hallRate)).toEqual([0.01, 0.05]);
    expect(readdirSync(dir).filter((f) => f.startsWith("current-"))).toHaveLength(1);
  });

  test("history lines carry no grid — they are the small, appendable projection", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    const line = readFileSync(join(dir, "history-codex-cli.jsonl"), "utf8").trim();
    expect(JSON.parse(line)).not.toHaveProperty("grid");
    expect(line).not.toContain("\n");
  });

  test("listBackends reports every backend with a current run", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    await store.saveRun(run({ backend: "openai:gpt-4o", backendLabel: "gpt-4o", model: "gpt-4o" }));
    expect((await store.listBackends()).sort()).toEqual(["codex-cli", "gpt-4o"]);
  });
});

describe("openRunStore — the trust boundary", () => {
  test("a malformed history line throws, naming the file and the line number", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    writeFileSync(join(dir, "history-codex-cli.jsonl"), '{"capturedAt":"nope"}\n', { flag: "a" });
    await expect(store.readHistory("codex-cli")).rejects.toThrow(
      /history-codex-cli\.jsonl.*line 2/s,
    );
  });

  test("a corrupt current file throws rather than returning a partial record", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    writeFileSync(join(dir, "current-codex-cli.json"), "{ not json");
    await expect(store.readCurrent("codex-cli")).rejects.toThrow(/current-codex-cli\.json/);
  });

  test("blank lines in history are skipped, not treated as corruption", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    writeFileSync(join(dir, "history-codex-cli.jsonl"), "\n\n", { flag: "a" });
    expect(await store.readHistory("codex-cli")).toHaveLength(1);
  });
});

describe("openRunStore — delete", () => {
  test("deleteHistoryEntry removes one point by capturedAt and leaves neighbours", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run({ capturedAt: "2026-08-11T12:00:00.000Z" }));
    await store.saveRun(run({ capturedAt: "2026-08-12T12:00:00.000Z" }));
    await store.saveRun(run({ capturedAt: "2026-08-13T12:00:00.000Z" }));

    await store.deleteHistoryEntry("codex-cli", "2026-08-12T12:00:00.000Z");

    expect((await store.readHistory("codex-cli")).map((h) => h.capturedAt)).toEqual([
      "2026-08-11T12:00:00.000Z",
      "2026-08-13T12:00:00.000Z",
    ]);
  });

  test("pruneHistory keeps the newest N", async () => {
    const store = openRunStore({ dir });
    for (const day of ["11", "12", "13"]) {
      await store.saveRun(run({ capturedAt: `2026-08-${day}T12:00:00.000Z` }));
    }
    await store.pruneHistory("codex-cli", { keep: 2 });
    expect((await store.readHistory("codex-cli")).map((h) => h.capturedAt)).toEqual([
      "2026-08-12T12:00:00.000Z",
      "2026-08-13T12:00:00.000Z",
    ]);
  });

  test("deleteRun removes BOTH files, retiring the backend entirely", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    await store.deleteRun("codex-cli");

    expect(await store.readCurrent("codex-cli")).toBeNull();
    expect(await store.readHistory("codex-cli")).toEqual([]);
    expect(await store.listBackends()).toEqual([]);
  });

  test("deleting from a backend that never ran is a no-op, not a crash", async () => {
    const store = openRunStore({ dir });
    await expect(store.deleteRun("codex-cli")).resolves.toBeUndefined();
    await expect(
      store.deleteHistoryEntry("codex-cli", "2026-08-11T12:00:00.000Z"),
    ).resolves.toBeUndefined();
  });
});

describe("openRunStore — durability", () => {
  test("no temp file survives a completed save", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  test("a backend label with path-unsafe characters is sanitised into the filename", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(
      run({ backendLabel: "gpt-4o/2024-08-06", backend: "openai:gpt-4o/2024-08-06" }),
    );
    expect(readdirSync(dir)).toContain("current-gpt-4o_2024-08-06.json");
  });
});
