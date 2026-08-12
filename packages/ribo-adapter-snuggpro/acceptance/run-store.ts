import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { toHistoryEntry } from "./build-run-record.js";
import type { HistoryEntry, RunRecord } from "./run-record.js";
import { HistoryEntrySchema, RunRecordSchema } from "./run-record.js";

/**
 * CRUD over the committed extraction-accuracy run artifacts.
 *
 * Two files per backend, in `acceptance/runs/`:
 *   - `current-<label>.json`  — one run in full, OVERWRITTEN each time (~150 KB)
 *   - `history-<label>.jsonl` — one appended summary line per run (~400 B)
 *
 * `openRunStore({ dir })` takes an injectable directory, mirroring
 * `openOutbox({ storage })` (AGENTS §5.5): the default is the real committed
 * `runs/` directory, and tests pass a temp dir so they never touch the tree.
 *
 * Everything read back is zod-parsed, never cast — these are persisted records
 * crossing a trust boundary (AGENTS §4).
 *
 * See docs/roadmap/design/extraction-accuracy-report-design.md §4.
 */
export interface RunStore {
  /** Overwrite `current` (temp + rename), then append one `history` line. */
  saveRun(run: RunRecord): Promise<void>;
  readCurrent(backendLabel: string): Promise<RunRecord | null>;
  readHistory(backendLabel: string): Promise<HistoryEntry[]>;
  listBackends(): Promise<string[]>;
  /** Drop ONE bogus trend point, leaving `current` alone. */
  deleteHistoryEntry(backendLabel: string, capturedAt: string): Promise<void>;
  /** Trim the trend to the newest N. Maintenance, not correction. */
  pruneHistory(backendLabel: string, opts: { keep: number }): Promise<void>;
  /** Remove BOTH files — retire the backend entirely. */
  deleteRun(backendLabel: string): Promise<void>;
}

const DEFAULT_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "runs");

/** Same sanitisation the gate already applies to its results directory. */
function safe(label: string): string {
  return label.replace(/[^\w.-]+/g, "_");
}

export function openRunStore(opts: { dir?: string } = {}): RunStore {
  const dir = opts.dir ?? DEFAULT_DIR;
  const currentPath = (label: string): string => join(dir, `current-${safe(label)}.json`);
  const historyPath = (label: string): string => join(dir, `history-${safe(label)}.jsonl`);

  function readHistorySync(label: string): HistoryEntry[] {
    const path = historyPath(label);
    if (!existsSync(path)) return [];
    const entries: HistoryEntry[] = [];
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue; // trailing newline, or a blank a human left
      try {
        entries.push(HistoryEntrySchema.parse(JSON.parse(line)));
      } catch (cause) {
        throw new Error(
          `Malformed accuracy history in ${historyPath(label)} at line ${index + 1}. ` +
            `Fix or remove the line — a run summary that cannot be parsed must never be ` +
            `rendered as a data point.`,
          { cause },
        );
      }
    }
    return entries;
  }

  function writeHistorySync(label: string, entries: HistoryEntry[]): void {
    const body = entries.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(historyPath(label), entries.length === 0 ? "" : `${body}\n`);
  }

  return {
    async saveRun(run) {
      const parsed = RunRecordSchema.parse(run);
      mkdirSync(dir, { recursive: true });

      // Temp + rename so an interrupted write cannot leave a half-written grid,
      // and so `current` is never observed partially written. History is appended
      // AFTER the rename: a crash between the two loses a trend point, which is
      // recoverable; the reverse order would leave a history point referencing a
      // grid that was never written, which is not.
      const target = currentPath(parsed.backendLabel);
      const temp = `${target}.tmp`;
      writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`);
      renameSync(temp, target);

      appendFileSync(
        historyPath(parsed.backendLabel),
        `${JSON.stringify(toHistoryEntry(parsed))}\n`,
      );
    },

    async readCurrent(backendLabel) {
      const path = currentPath(backendLabel);
      if (!existsSync(path)) return null;
      try {
        return RunRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      } catch (cause) {
        throw new Error(
          `Malformed accuracy run in ${path}. Delete it and re-run the acceptance gate.`,
          { cause },
        );
      }
    },

    async readHistory(backendLabel) {
      return readHistorySync(backendLabel);
    },

    async listBackends() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.startsWith("current-") && f.endsWith(".json"))
        .map((f) => f.slice("current-".length, -".json".length));
    },

    async deleteHistoryEntry(backendLabel, capturedAt) {
      if (!existsSync(historyPath(backendLabel))) return;
      const kept = readHistorySync(backendLabel).filter((e) => e.capturedAt !== capturedAt);
      writeHistorySync(backendLabel, kept);
    },

    async pruneHistory(backendLabel, { keep }) {
      if (!existsSync(historyPath(backendLabel))) return;
      const entries = readHistorySync(backendLabel);
      writeHistorySync(backendLabel, keep <= 0 ? [] : entries.slice(-keep));
    },

    async deleteRun(backendLabel) {
      rmSync(currentPath(backendLabel), { force: true });
      rmSync(historyPath(backendLabel), { force: true });
    },
  };
}
