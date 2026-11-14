/**
 * @file The repoint checks: the CLI transport's new home is real, and the old
 * one is gone.
 *
 * The transport moved out of the Snugg adapter's unpublished acceptance tree
 * and into `@azx/ribo-cli` as published API. A move is easy to half-do — a
 * stale import here, a manifest that still declares a dependency nothing
 * imports, a config that still lists a file that has moved — and every one of
 * those failures is invisible until the thing it breaks is run.
 *
 * These checks are TEXT over the tree, not behaviour: they read the files as
 * they are on disk and assert what they say. The gate's own import is pinned
 * as a line because `gate.manual.ts` is deliberately excluded from the
 * typecheck (it imports the spike's untyped `.mjs` modules), so nothing else
 * would catch a wrong specifier there until a paid run.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const ADAPTER_DIR = join(PACKAGES_DIR, "ribo-adapter-snuggpro");
const CLI_DIR = join(PACKAGES_DIR, "ribo-cli");

/** This file — the one place the old paths appear as string literals. */
const THIS_FILE = fileURLToPath(import.meta.url);

/** Every file under a directory, recursively. */
function filesUnder(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

/** The files under `packages/`, this one excluded. */
const packageFiles = (): readonly string[] =>
  filesUnder(PACKAGES_DIR).filter((file) => file !== THIS_FILE);

/** The files under the adapter's tree, this one excluded. */
const adapterFiles = (): readonly string[] =>
  filesUnder(ADAPTER_DIR).filter((file) => file !== THIS_FILE);

describe("the CLI transport's new home", () => {
  test("the gate imports the transport from @azx/ribo-cli, by one pinned line", () => {
    const gate = readFileSync(join(ADAPTER_DIR, "acceptance", "gate.manual.ts"), "utf8");
    expect(gate).toContain('import { cliChat, type CliShapeResult } from "@azx/ribo-cli";');
    // The old sibling import is gone from the gate, header included.
    expect(gate).not.toContain("./cli-chat");
  });

  test("no file under packages/ names the transport's old location", () => {
    for (const file of packageFiles()) {
      const text = readFileSync(file, "utf8");
      expect({ file, match: text.includes("acceptance/cli-chat") }).toEqual({
        file,
        match: false,
      });
    }
  });

  test("no file in the adapter's tree imports the transport by its old path", () => {
    for (const file of adapterFiles()) {
      const text = readFileSync(file, "utf8");
      expect({ file, match: text.includes("./cli-chat") }).toEqual({ file, match: false });
    }
  });

  test("the moved transport and its test live in the CLI package", () => {
    expect(readFileSync(join(CLI_DIR, "src", "cli-chat.ts"), "utf8")).toContain(
      "export function cliChat",
    );
    expect(readFileSync(join(CLI_DIR, "src", "cli-chat.test.ts"), "utf8")).toContain(
      'describe("cliChat',
    );
    // The old files are gone, not merely unreferenced.
    expect(() => readFileSync(join(ADAPTER_DIR, "acceptance", "cli-chat.ts"), "utf8")).toThrow();
    expect(() =>
      readFileSync(join(ADAPTER_DIR, "acceptance", "cli-chat.test.ts"), "utf8"),
    ).toThrow();
  });
});

describe("the ajv migration", () => {
  test("no file in the adapter's tree imports ajv by value", () => {
    for (const file of adapterFiles()) {
      const text = readFileSync(file, "utf8");
      const importsAjv = /from\s+["']ajv/.test(text) || /import\(\s*["']ajv/.test(text);
      expect({ file, importsAjv }).toEqual({ file, importsAjv: false });
    }
  });

  test("the adapter's manifest no longer declares ajv, and the CLI's does", () => {
    const adapter = JSON.parse(readFileSync(join(ADAPTER_DIR, "package.json"), "utf8")) as {
      readonly dependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
    };
    expect(Object.keys(adapter.dependencies ?? {})).not.toContain("ajv");
    expect(Object.keys(adapter.devDependencies ?? {})).not.toContain("ajv");

    const cli = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as {
      readonly dependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
    };
    expect(cli.dependencies?.["ajv"]).toBe("catalog:");
    // The CLI's runtime dependencies never name an adapter.
    expect(Object.keys(cli.dependencies ?? {})).not.toContain("@azx/ribo-adapter-snuggpro");
  });
});

describe("the manual smoke", () => {
  test("it lives in the acceptance tree and no root Vitest project can match it", () => {
    const smoke = join(ADAPTER_DIR, "acceptance", "cli-backends-smoke.manual.ts");
    expect(readFileSync(smoke, "utf8")).toContain('import { cliChat } from "@azx/ribo-cli";');

    // Every include pattern of every root project names a TEST file, so a
    // `*.manual.ts` file is matched by none of them: the manual smoke is
    // collected by the acceptance config alone, and never by CI.
    const root = readFileSync(join(REPO_ROOT, "vitest.config.ts"), "utf8");
    const patterns: string[] = [];
    for (const block of root.matchAll(/include:\s*\[([^\]]*)\]/g)) {
      for (const literal of block[1]!.matchAll(/"([^"]+)"/g)) {
        patterns.push(literal[1]!);
      }
    }
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(pattern).toContain(".test.");
    }
  });
});

describe("the acceptance project's file list", () => {
  test("it names the moved file no more, and the real-audio companion now", () => {
    const raw = readFileSync(join(ADAPTER_DIR, "tsconfig.acceptance.json"), "utf8");
    // The file carries `//` comments, which JSON.parse does not accept.
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
    const config = JSON.parse(stripped) as { readonly include?: readonly string[] };
    expect(new Set(config.include ?? [])).toEqual(
      new Set([
        "acceptance/extract-real.manual.ts",
        "acceptance/run-record.ts",
        "acceptance/build-run-record.ts",
        "acceptance/run-store.ts",
        "acceptance/*.test.ts",
        // The adapter's own source, because the real-audio companion imports it.
        "src",
      ]),
    );
    // The manual gate stays excluded: it imports the spike's untyped `.mjs`
    // modules, which have no declarations and must never be given any.
    expect(config.include ?? []).not.toContain("acceptance/gate.manual.ts");
    expect(config.include ?? []).not.toContain("acceptance/cli-chat.ts");
  });
});
